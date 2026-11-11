import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex, Readable, Writable } from 'node:stream';

/**
 * What the end-to-end test of the extension needs: a real Chrome driven over its debugging
 * pipe, and a made-up site that stands where app.slack.com would be. The site is not a
 * copy of Slack: it is one page that plants a made-up cookie and token, opens a socket with
 * the token in its address, and shows a few made-up names. Chrome is told to resolve every
 * slack.com name to this machine, so nothing in the test can reach Slack.
 */

export const CHROME = process.env.CHROME_BIN ?? ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) ?? 'google-chrome';

/** The made-up secrets the page holds. The test requires that none of them ever reaches Patcher. */
export const PLANTED = {
  cookie: 'xoxd-made-up-session-cookie-0000000000',
  token: 'xoxc-0000000000-made-up-client-token',
  socketHost: 'wss-primary.slack.com',
};

export interface FakeSlackSite {
  port: number;
  /** Every request the site received: method, host and path. */
  requests: { method: string; host: string; path: string; origin: string | null }[];
  /** How many sockets are connected now. */
  sockets: () => number;
  /** Data frames clients sent on a socket. Slack's client would send some; the made-up page sends none, so any here came from elsewhere. */
  clientFrames: () => number;
  /** Pushes one frame to every connected socket, as Slack's server would. */
  push: (frame: unknown) => void;
  close: () => Promise<void>;
}

const page = (team: string, channel: string, self: string) => `<!doctype html>
<html>
  <head><title>project-portal (Channel) - Acme - Slack</title></head>
  <body>
    <div data-qa="user-button"><img src="https://ca.slack-edge.com/${team}-${self}-0123abcdef-48" alt="" /></div>
    <div data-qa-channel-sidebar-channel-id="${channel}"><span data-qa="channel_sidebar_name_project-portal">project-portal</span></div>
    <div><button data-qa="message_sender_name" data-message-sender="U0DANA">Dana Reyes</button>
      <a class="c-timestamp" href="https://acme-co.slack.com/archives/${channel}/p1800000000000100">9:00</a></div>
    <script>
      // What a signed-in page holds. None of it may ever leave the browser.
      document.cookie = 'd=${PLANTED.cookie}; path=/';
      localStorage.setItem('localConfig_v2', JSON.stringify({ teams: { ${team}: { token: '${PLANTED.token}' } } }));
      window.sentByPage = 0;
      window.socket = new WebSocket('wss://${PLANTED.socketHost}/?token=${PLANTED.token}&gateway_server=${team}-1');
      window.heard = 0;
      window.socket.addEventListener('message', () => { window.heard += 1; });
    </script>
  </body>
</html>`;

function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]) : null;
  if (!header) throw new Error('frame too long for this stand-in');
  return Buffer.concat([header, body]);
}

/** Counts the data frames in what a client wrote: opcode 1 or 2. Control frames (close, ping, pong) are not data. */
function countDataFrames(buffer: Buffer): number {
  let n = 0;
  let at = 0;
  while (at + 2 <= buffer.length) {
    const opcode = buffer[at]! & 0x0f;
    let length = buffer[at + 1]! & 0x7f;
    const masked = (buffer[at + 1]! & 0x80) !== 0;
    at += 2;
    if (length === 126) {
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(at));
      at += 8;
    }
    at += (masked ? 4 : 0) + length;
    if (opcode === 1 || opcode === 2) n += 1;
  }
  return n;
}

export async function startFakeSlackSite(input: { team: string; channel: string; self: string }): Promise<FakeSlackSite> {
  const dir = mkdtempSync(join(tmpdir(), 'made-up-site-'));
  // A certificate made for this run and thrown away with it. Chrome is told to accept it.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=app.slack.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const requests: FakeSlackSite['requests'] = [];
  const sockets = new Set<Duplex>();
  let clientBytes = Buffer.alloc(0);

  const server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    const path = req.url ?? '/';
    requests.push({ method: req.method ?? '', host: req.headers.host ?? '', path, origin: req.headers.origin ?? null });
    if (path.startsWith('/client/')) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(input.team, input.channel, input.self));
    else if (path.startsWith('/signin')) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Sign in | Slack</title><p>Sign in to your workspace</p>');
    else res.writeHead(404).end();
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    // The address is recorded without its query, which holds the made-up token.
    requests.push({ method: 'UPGRADE', host: req.headers.host ?? '', path: (req.url ?? '').split('?')[0]!, origin: req.headers.origin ?? null });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('data', (chunk: Buffer) => (clientBytes = Buffer.concat([clientBytes, chunk])));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    requests,
    sockets: () => sockets.size,
    clientFrames: () => countDataFrames(clientBytes),
    push: (frame) => {
      const data = textFrame(typeof frame === 'string' ? frame : JSON.stringify(frame));
      for (const socket of sockets) socket.write(data);
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/** Chrome's debugging protocol over the pipe Chrome was started with: JSON messages ended by a zero byte. */
export class Chrome {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private constructor(
    private readonly process: ChildProcess,
    private readonly profile: string,
  ) {
    (process.stdio[4] as Readable).on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (let end = this.buffer.indexOf('\0'); end >= 0; end = this.buffer.indexOf('\0')) {
        const message = JSON.parse(this.buffer.slice(0, end)) as { id?: number; result?: unknown; error?: { message: string } };
        this.buffer = this.buffer.slice(end + 1);
        const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id!);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
      }
    });
  }

  /** Starts Chrome with a fresh profile in which every slack.com name resolves to the made-up site. */
  static async launch(sitePort: number): Promise<Chrome> {
    const profile = mkdtempSync(join(tmpdir(), 'reader-profile-'));
    const child = spawn(
      CHROME,
      [
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${profile}`,
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--window-size=1300,1700',
        // Nothing in this run can reach Slack: its names resolve to this machine, and nothing else resolves at all.
        `--host-resolver-rules=MAP slack.com 127.0.0.1:${sitePort}, MAP *.slack.com 127.0.0.1:${sitePort}, MAP *.slack-edge.com 127.0.0.1:${sitePort}, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND`,
        '--ignore-certificate-errors',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    );
    const chrome = new Chrome(child, profile);
    await chrome.send('Target.getTargets');
    return chrome;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    (this.process.stdio[3] as Writable).write(`${message}\0`);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} did not answer`));
      }, 20_000);
    });
  }

  /** Loads the extension from its folder, unpacked, as "Load unpacked" does. Returns its id. */
  async loadExtension(path: string): Promise<string> {
    return (await this.send<{ id: string }>('Extensions.loadUnpacked', { path })).id;
  }

  async open(url: string): Promise<Tab> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    return new Tab(this, targetId, sessionId);
  }

  async close(): Promise<void> {
    try {
      await this.send('Browser.close');
    } catch {
      this.process.kill('SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

export class Tab {
  constructor(
    private readonly chrome: Chrome,
    readonly targetId: string,
    private readonly sessionId: string,
  ) {}

  /** Runs an expression in the page's own world and returns its value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.chrome.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async navigate(url: string): Promise<void> {
    await this.chrome.send('Page.navigate', { url }, this.sessionId);
  }

  /** The whole window, or one element of the page. */
  async screenshot(selector?: string): Promise<Buffer> {
    const clip = selector
      ? await this.evaluate<{ x: number; y: number; width: number; height: number }>(
          `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
        )
      : undefined;
    const { data } = await this.chrome.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, this.sessionId);
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    await this.chrome.send('Target.closeTarget', { targetId: this.targetId });
  }
}

export async function until<T>(what: string, check: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
