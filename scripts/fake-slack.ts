/* eslint-disable no-console */
/**
 * A local stand-in for Slack, for development and for checking the whole loop without real
 * credentials. It is never deployed and the services refuse its URLs in production.
 *
 * It plays three parts:
 *   1. the Web API the worker calls (chat.postMessage, chat.update, views.*, conversations.list);
 *   2. Sign in with Slack (authorize, token, keys), auto-approving as the identity set below;
 *   3. a person in the hub: `POST /_click`, `/_submit_edit`, `/_command` and `/_event` build the
 *      request Slack would send, sign it with SLACK_SIGNING_SECRET, and deliver it to `web`.
 *
 * Run: npm run dev:fake-slack   (reads the same .env as the services)
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { SignJWT, exportJWK } from 'jose';
import { signSlackRequest } from '../src/slack/verify.js';

const port = Number(process.env.FAKE_SLACK_PORT ?? 4010);
const self = `http://localhost:${port}`;
const webUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
const teamId = process.env.SLACK_TEAM_ID ?? 'T0PATCHOPS';
const clientId = process.env.SLACK_CLIENT_ID ?? 'fake-client-id';

type Json = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

interface Message {
  channel: string;
  ts: string;
  thread_ts?: string;
  text: string;
  blocks: Json[];
  edits: number;
}

const channels = [
  { id: 'C0OPSLOG', name: 'ops-log', is_private: false, is_member: true },
  { id: 'C0OPSCALLS', name: 'ops-calls', is_private: false, is_member: true },
  { id: 'C0GENERAL', name: 'general', is_private: false, is_member: false },
];
const messages: Message[] = [];
const calls: { method: string; args: Json }[] = [];
const responses: { id: string; body: Json }[] = [];
const views: { trigger_id: string; view: Json }[] = [];
const homes = new Map<string, Json>();
const codes = new Map<string, { nonce: string; identity: Identity }>();

interface Identity {
  userId: string;
  teamId: string;
  name: string;
  email: string;
}
let identity: Identity = {
  userId: process.env.BOOTSTRAP_OWNER_SLACK_USER_ID ?? 'U0OWNER',
  teamId,
  name: 'Fake Owner',
  email: 'owner@example.com',
};

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'fake-slack-key';

let tsCounter = 0;
const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++tsCounter).padStart(6, '0')}`;

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(req: http.IncomingMessage, body: string): Json {
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(body || '{}') as Json;
  const out: Json = {};
  for (const [key, value] of new URLSearchParams(body)) {
    try {
      out[key] = key === 'blocks' || key === 'view' ? (JSON.parse(value) as unknown) : value;
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function api(method: string, args: Json): Json {
  calls.push({ method, args });
  switch (method) {
    case 'chat.postMessage': {
      const channel = channels.find((c) => c.id === args.channel);
      if (!channel) return { ok: false, error: 'channel_not_found' };
      if (!channel.is_member) return { ok: false, error: 'not_in_channel' };
      const message: Message = {
        channel: channel.id,
        ts: nextTs(),
        text: str(args.text),
        blocks: (args.blocks as Json[] | undefined) ?? [],
        edits: 0,
        ...(args.thread_ts ? { thread_ts: str(args.thread_ts) } : {}),
      };
      messages.push(message);
      return { ok: true, channel: channel.id, ts: message.ts };
    }
    case 'chat.update': {
      const message = messages.find((m) => m.channel === args.channel && m.ts === args.ts);
      if (!message) return { ok: false, error: 'message_not_found' };
      message.text = str(args.text);
      message.blocks = (args.blocks as Json[] | undefined) ?? [];
      message.edits += 1;
      return { ok: true, channel: message.channel, ts: message.ts };
    }
    case 'views.open':
      views.push({ trigger_id: String(args.trigger_id), view: args.view as Json });
      return { ok: true, view: { id: `V${views.length}` } };
    case 'views.publish':
      homes.set(String(args.user_id), args.view as Json);
      return { ok: true };
    case 'conversations.list':
      return { ok: true, channels, response_metadata: { next_cursor: '' } };
    default:
      return { ok: false, error: 'unknown_method' };
  }
}

/** Delivers a request to `web` signed exactly as Slack signs it. */
async function deliver(path: string, body: string, contentType: string): Promise<{ status: number; body: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await fetch(`${webUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signSlackRequest(signingSecret, timestamp, body),
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

function responseUrl(): string {
  return `${self}/_response/${randomUUID()}`;
}

function findButton(message: Message, label: string): Json | undefined {
  for (const block of message.blocks) {
    for (const element of (block.elements as Json[] | undefined) ?? []) {
      const text = (element.text as Json | undefined)?.text;
      if (typeof text === 'string' && text.toLowerCase() === label.toLowerCase()) return element;
    }
  }
  return undefined;
}

const person = (userId: string, team = teamId) => ({
  user: { id: userId, username: userId.toLowerCase(), name: userId.toLowerCase(), team_id: team },
  team: { id: team, domain: 'patchops' },
});

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', self);
    const body = await readBody(req);

    // 1. Web API ---------------------------------------------------------------------------
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/openid.connect.token') {
      send(res, 200, api(url.pathname.slice('/api/'.length), parseArgs(req, body)));
      return;
    }

    // 2. Sign in with Slack ------------------------------------------------------------------
    if (url.pathname === '/openid/connect/authorize') {
      const code = randomUUID();
      codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', identity });
      const back = new URL(url.searchParams.get('redirect_uri') ?? webUrl);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/api/openid.connect.token') {
      const code = new URLSearchParams(body).get('code') ?? '';
      const grant = codes.get(code);
      codes.delete(code);
      if (!grant) {
        send(res, 200, { ok: false, error: 'invalid_code' });
        return;
      }
      const idToken = await new SignJWT({
        nonce: grant.nonce,
        name: grant.identity.name,
        email: grant.identity.email,
        'https://slack.com/user_id': grant.identity.userId,
        'https://slack.com/team_id': grant.identity.teamId,
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer('https://slack.com')
        .setAudience(clientId)
        .setSubject(grant.identity.userId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keyPair.privateKey);
      send(res, 200, { ok: true, id_token: idToken });
      return;
    }
    if (url.pathname === '/openid/connect/keys') {
      send(res, 200, { keys: [{ ...(await exportJWK(keyPair.publicKey)), kid, alg: 'RS256', use: 'sig' }] });
      return;
    }

    // Private replies the worker sends to a click's response URL.
    if (url.pathname.startsWith('/_response/')) {
      responses.push({ id: url.pathname.split('/').pop() ?? '', body: JSON.parse(body || '{}') as Json });
      send(res, 200, { ok: true });
      return;
    }

    // 3. Controls: inspect state, and act as a person in the hub ------------------------------
    const input = body && req.method === 'POST' ? (JSON.parse(body) as Json) : {};
    const userId = typeof input.userId === 'string' ? input.userId : identity.userId;
    const fromTeam = typeof input.teamId === 'string' ? input.teamId : teamId;

    if (url.pathname === '/_state') {
      send(res, 200, { identity, messages, responses, views, homes: Object.fromEntries(homes), calls });
      return;
    }
    if (url.pathname === '/_identity') {
      identity = { ...identity, ...(input as Partial<Identity>) };
      send(res, 200, identity);
      return;
    }
    if (url.pathname === '/_click') {
      // { ts, button: "Approve" | "Edit" | "Dismiss" | "Details" | "Retry", userId?, teamId?, value? }
      const message = messages.find((m) => m.ts === input.ts);
      const button = message && findButton(message, String(input.button));
      if (!message || (!button && typeof input.value !== 'string')) {
        send(res, 404, { error: 'no such message or button' });
        return;
      }
      const triggerId = `trigger-${randomUUID()}`;
      const payload = {
        type: 'block_actions',
        ...person(userId, fromTeam),
        trigger_id: triggerId,
        response_url: responseUrl(),
        container: { type: 'message', message_ts: message.ts, channel_id: message.channel },
        channel: { id: message.channel },
        actions: [
          {
            type: 'button',
            action_id: button?.action_id ?? input.actionId,
            value: typeof input.value === 'string' ? input.value : button?.value,
            action_ts: String(Date.now() / 1000),
          },
        ],
      };
      const delivered = await deliver(
        '/slack/interactions',
        new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
        'application/x-www-form-urlencoded',
      );
      send(res, 200, { delivered, triggerId });
      return;
    }
    if (url.pathname === '/_submit_edit') {
      // { title?, body?, params?, userId? } submits the most recently opened modal.
      const opened = views.at(-1);
      if (!opened) {
        send(res, 404, { error: 'no modal has been opened' });
        return;
      }
      const initial = (blockId: string) => {
        const block = (opened.view.blocks as Json[]).find((b) => b.block_id === blockId);
        return str((block?.element as Json | undefined)?.initial_value);
      };
      const value = (name: string) => ({
        value: { type: 'plain_text_input', value: typeof input[name] === 'string' ? input[name] : initial(name) },
      });
      const payload = {
        type: 'view_submission',
        ...person(userId, fromTeam),
        view: {
          ...opened.view,
          state: { values: { title: value('title'), body: value('body'), params: value('params') } },
        },
      };
      const delivered = await deliver(
        '/slack/interactions',
        new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
        'application/x-www-form-urlencoded',
      );
      send(res, 200, { delivered });
      return;
    }
    if (url.pathname === '/_command') {
      // { text: "status" | "pending" | "pause" | "resume", userId?, teamId? }
      const form = new URLSearchParams({
        command: '/ops',
        text: str(input.text),
        team_id: fromTeam,
        user_id: userId,
        response_url: responseUrl(),
        trigger_id: `trigger-${randomUUID()}`,
      });
      send(res, 200, { delivered: await deliver('/slack/commands', form.toString(), 'application/x-www-form-urlencoded') });
      return;
    }
    if (url.pathname === '/_event') {
      // { event: { type: "app_home_opened", user, tab: "home" }, eventId? }
      const envelope = {
        type: 'event_callback',
        team_id: fromTeam,
        event_id: typeof input.eventId === 'string' ? input.eventId : `Ev${randomUUID()}`,
        event: input.event,
      };
      send(res, 200, { delivered: await deliver('/slack/events', JSON.stringify(envelope), 'application/json') });
      return;
    }

    send(res, 404, { error: 'not found' });
  })().catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err) });
  });
});

server.listen(port, () => {
  console.log(`fake Slack on ${self} (delivering to ${webUrl}, signing: ${signingSecret ? 'yes' : 'NO SECRET SET'})`);
});
