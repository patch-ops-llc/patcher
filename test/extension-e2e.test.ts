import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueDevice } from '../src/inbox/companion.js';
import { workspaceByTeam } from '../src/inbox/store.js';
import { setSetting } from '../src/settings/settings.js';
import { createApp } from '../src/web/app.js';
import type { FakeSlackSite, Tab } from './fixtures/browser.js';
import { Chrome, PLANTED, startFakeSlackSite, until } from './fixtures/browser.js';
import { EXTENSION_DIR } from './fixtures/extension.js';
import { HUB, OWNER, harness, resetDb, seedPeople, testPool, webDeps } from './helpers.js';

/**
 * The extension in a real Chrome, loaded unpacked from `extension/` with its manifest as
 * shipped, against a made-up site standing where app.slack.com would be, posting to the
 * real Patcher routes on this machine.
 *
 * Opt-in: `EXTENSION_E2E=1 npx vitest run test/extension-e2e.test.ts`. It needs Chrome, takes
 * about two minutes, and is not part of `npm test` or CI.
 *
 * It shows that Chrome loads the extension, that the page-world script is in place before
 * the page opens its socket, that a frame travels from the socket to Patcher's database,
 * that the worker survives being stopped by Chrome, and that the planted cookie and token
 * never arrive at Patcher. It shows nothing about Slack: the site is invented.
 */
const enabled = process.env.EXTENSION_E2E === '1';
const ARTIFACTS = process.env.EXTENSION_E2E_ARTIFACTS;

const ACME = 'T0ACME';
const CHANNEL = 'C0ACMEPORTAL';
const DM = 'D0ACMEDANA';
const ME = 'U0MEATACME';
const DANA = 'U0DANA';
const ASK = 'Can you confirm the invoice export goes live on Friday?';
const CLIENT = `https://app.slack.com/client/${ACME}/${CHANNEL}`;

let clock = 0;
const ts = (): string => `${Math.floor(Date.now() / 1000)}.${String(++clock).padStart(6, '0')}`;

describe.runIf(enabled)('the extension in Chrome, against a made-up site', () => {
  const pool = testPool();
  let site: FakeSlackSite;
  let chrome: Chrome;
  let patcher: Server;
  let patcherUrl: string;
  let extensionId: string;
  let slackTab: Tab;
  let options: Tab;
  let deps: ReturnType<typeof webDeps>;
  /** Everything Patcher received from the extension: paths, bodies and every header but the key. */
  const received: { method: string; path: string; origin: string | undefined; headers: string; body: string }[] = [];

  const status = () => options.evaluate<any>(`chrome.runtime.sendMessage({ kind: 'status' })`);
  const checkNow = () => options.evaluate<any>(`chrome.runtime.sendMessage({ kind: 'tick' })`);
  const stored = async () => (await pool.query<{ source: string; text: string | null; own: boolean; channel_id: string; channel_name: string | null; sender_name: string | null }>('SELECT source, text, own, channel_id, channel_name, sender_name FROM slack_messages ORDER BY ts')).rows;
  const shot = async (tab: Tab, name: string, selector?: string) => {
    if (!ARTIFACTS) return;
    if (tab === options) {
      await tab.evaluate(`document.getElementById('tick').click()`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(`${ARTIFACTS}/${name}.png`, await tab.screenshot(selector));
  };

  beforeAll(async () => {
    await resetDb(pool);
    await seedPeople(pool);
    await setSetting(pool, 'inbox.enabled', true, OWNER);
    const app = express();
    app.use((req, _res, next) => {
      const chunks: Buffer[] = [];
      // Read now: the routers below rewrite the path as the request passes through them.
      const path = req.path;
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name !== 'authorization'));
        received.push({ method: req.method, path, origin: req.headers.origin, headers: JSON.stringify(headers), body: Buffer.concat(chunks).toString('utf8') });
      });
      next();
    });
    deps = webDeps(harness(pool));
    app.use(createApp(deps));
    patcher = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => patcher.once('listening', resolve));
    patcherUrl = `http://127.0.0.1:${(patcher.address() as AddressInfo).port}`;

    site = await startFakeSlackSite({ team: ACME, channel: CHANNEL, self: ME });
    chrome = await Chrome.launch(site.port);
    extensionId = await chrome.loadExtension(fileURLToPath(EXTENSION_DIR));
  }, 60_000);

  afterAll(async () => {
    await chrome?.close();
    await site?.close();
    await new Promise((resolve) => (patcher ? patcher.close(resolve) : resolve(null)));
    await pool.end();
  });

  it('is in the page before the page opens its socket, and counts frames without being paired', async () => {
    slackTab = await chrome.open(CLIENT);
    await until('the page to connect its socket', () => site.sockets() === 1);
    options = await chrome.open(`chrome-extension://${extensionId}/options.html`);
    site.push({ type: 'hello' });
    site.push({ type: 'user_typing', channel: CHANNEL, user: DANA });
    site.push({ type: 'message', channel: CHANNEL, user: DANA, text: 'Before pairing, nothing is sent.', ts: ts() });
    await until('the page to hear the frames', async () => (await slackTab.evaluate<number>('window.heard')) === 3);

    const s = await checkNow();
    expect(s.pairing).toBeNull();
    expect(s.last.tabs).toHaveLength(1);
    expect(s.last.tabs[0]).toMatchObject({ team: ACME, state: 'open', tap: true, sockets: 1, socketsOpen: 1, frames: 3, messageFrames: 1, notification: expect.any(String) });
    expect(s.last.tabs[0].types).toEqual({ hello: 1, user_typing: 1, message: 1 });
    expect(s.last.tabs[0].dom).toEqual({ channels: 1, messages: 1 });
    expect(s.known[ACME]).toEqual({ name: 'Acme', domain: 'acme-co', selfUserId: ME });
    expect(received).toEqual([]);
    // The page still has its own socket and nothing else was sent on it.
    expect(await slackTab.evaluate('window.socket.readyState')).toBe(1);
    expect(site.clientFrames()).toBe(0);
  }, 60_000);

  it('pairs from its own page, and a workspace it finds starts switched off', async () => {
    const { key } = await issueDevice(pool, { label: 'Reader profile' }, OWNER);
    await options.evaluate(`(() => {
      document.getElementById('base-url').value = ${JSON.stringify(patcherUrl)};
      document.getElementById('key').value = ${JSON.stringify(key)};
      document.getElementById('pair').requestSubmit();
    })()`);
    await until('the extension to pair', async () => (await status()).pairing?.lastOkAt);
    const workspace = await until('the workspace to be reported', () => workspaceByTeam(pool, ACME));
    expect(workspace).toMatchObject({ name: 'Acme', domain: 'acme-co', enabled: false, companionEnabled: true, readMode: 'companion' });
    expect(JSON.stringify(await status())).not.toContain(key);
    expect(await options.evaluate(`document.getElementById('key').value`)).toBe('');

    site.push({ type: 'message', channel: DM, channel_type: 'im', user: DANA, text: 'Switched off: this must not be sent.', ts: ts() });
    await until('the page to hear it', async () => (await slackTab.evaluate<number>('window.heard')) === 4);
    await checkNow();
    expect(await stored()).toEqual([]);
    expect(received.filter((r) => r.path === '/ingest/slack' && r.method === 'POST')).toEqual([]);
  }, 60_000);

  it('carries a message from the socket to Patcher once the workspace is switched on', async () => {
    await pool.query(`UPDATE slack_workspaces SET enabled = true, capture_level = 'page', reader_user_id = $2 WHERE team_id = $1`, [ACME, ME]);
    await until('the extension to learn the workspace is on', async () => (await checkNow()).config?.workspaces?.length === 1);
    site.push({ type: 'message', channel: CHANNEL, user: DANA, text: ASK, ts: ts(), team: ACME });
    site.push({ type: 'message', channel: CHANNEL, user: ME, text: 'My own words stay in the browser.', ts: ts(), team: ACME });
    site.push({ type: 'message', channel: DM, channel_type: 'im', user: DANA, text: `Careful with ${PLANTED.token}`, ts: ts() });
    await until('three messages to be stored', async () => (await stored()).length === 3);
    expect(await stored()).toEqual([
      { source: 'companion_page', text: ASK, own: false, channel_id: CHANNEL, channel_name: 'project-portal', sender_name: 'Dana Reyes' },
      { source: 'companion_page', text: null, own: true, channel_id: CHANNEL, channel_name: 'project-portal', sender_name: null },
      { source: 'companion_page', text: 'Careful with [removed]', own: false, channel_id: DM, channel_name: null, sender_name: 'Dana Reyes' },
    ]);
    await shot(options, 'extension-page-paired');
  }, 60_000);

  it('reports by itself every minute, also after Chrome has stopped its idle worker', async () => {
    const beats = () => received.filter((r) => r.path === '/ingest/slack/heartbeat' && r.method === 'POST').length;
    const before = beats();
    const startsBefore = (await status()).starts as number;
    // Nothing is asked of the extension for more than a minute. Chrome stops an idle worker after thirty seconds; the alarm has to start it again.
    await options.close();
    await new Promise((resolve) => setTimeout(resolve, 75_000));
    expect(beats()).toBeGreaterThan(before);
    site.push({ type: 'message', channel: CHANNEL, user: DANA, text: 'Heard while the worker was stopped.', ts: ts(), team: ACME });
    await until('the message to arrive', async () => (await stored()).some((r) => r.text === 'Heard while the worker was stopped.'));
    options = await chrome.open(`chrome-extension://${extensionId}/options.html`);
    const s = await status();
    expect(s.starts).toBeGreaterThan(startsBefore);
    expect(s.summary.teams[ACME].minutes.open).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('says so when the tab leaves the workspace for a sign-in page', async () => {
    await slackTab.navigate('https://app.slack.com/signin');
    await until('the state to change', async () => (await checkNow()).last.states.some((w: { teamId: string; state: string }) => w.teamId === ACME && w.state === 'signed_out'));
    const row = await until('Patcher to hear of it', async () => (await pool.query<{ state: string; state_detail: string }>('SELECT state, state_detail FROM companion_workspace_status')).rows.find((r) => r.state === 'signed_out'));
    expect(row.state_detail).toBe('the tab shows a sign-in page');
    await shot(options, 'extension-page-signed-out');
  }, 60_000);

  it('shows the reader, its health and the sign-out on the control page', async () => {
    deps.oidc.identity = { teamId: HUB, userId: OWNER, name: null, email: null };
    const page = await chrome.open(`${patcherUrl}/auth/slack`);
    await until('the sign-in to start', () => deps.oidc.lastState);
    await page.navigate(`${patcherUrl}/auth/slack/callback?code=c&state=${deps.oidc.lastState}`);
    await until('the session to exist', async () => (await pool.query('SELECT 1 FROM sessions')).rowCount);
    await page.navigate(`${patcherUrl}/inbox`);
    const text = await until('the control page', async () => {
      const body = await page.evaluate<string>(`document.getElementById('companion')?.innerText ?? ''`);
      return body.includes('Reader profile') ? body : null;
    });
    expect(text).toContain('Signed out');
    expect(text).toContain('Acme');
    expect(text).not.toContain('pdk_');
    await shot(page, 'control-page-companion', '#companion');
    await page.close();
  }, 60_000);

  it('never sent the planted cookie or token anywhere, and asked the made-up Slack for nothing', async () => {
    const fromExtension = received.filter((r) => r.path.startsWith('/ingest/'));
    const toPatcher = JSON.stringify(fromExtension);
    expect(fromExtension.length).toBeGreaterThan(5);
    for (const secret of [PLANTED.cookie, PLANTED.token, 'xoxc-', 'xoxd-', 'localConfig', PLANTED.socketHost]) expect(toPatcher).not.toContain(secret);
    expect(fromExtension.every((r) => r.origin === `chrome-extension://${extensionId}`)).toBe(true);
    expect(new Set(fromExtension.map((r) => r.path))).toEqual(new Set(['/ingest/slack/config', '/ingest/slack/heartbeat', '/ingest/slack']));
    // No cookie of any site travels with the extension's requests.
    expect(fromExtension.every((r) => !/"cookie"/i.test(r.headers))).toBe(true);

    const kept = JSON.stringify([
      (await pool.query('SELECT * FROM slack_messages')).rows,
      (await pool.query('SELECT * FROM slack_workspaces')).rows,
      (await pool.query('SELECT * FROM companion_devices')).rows,
      (await pool.query('SELECT * FROM companion_workspace_status')).rows,
      (await pool.query('SELECT * FROM slack_names')).rows,
    ]);
    for (const secret of [PLANTED.cookie, PLANTED.token, 'xoxc-', 'xoxd-']) expect(kept).not.toContain(secret);

    // The made-up site saw the page being loaded and its socket being opened, by the page. Nothing came from the extension.
    expect(site.requests.every((r) => r.origin === null || r.origin === 'https://app.slack.com')).toBe(true);
    expect(site.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE')).toEqual([]);
    expect(site.requests.filter((r) => r.method === 'UPGRADE')).toHaveLength(1);
    expect(site.clientFrames()).toBe(0);
  });
});
