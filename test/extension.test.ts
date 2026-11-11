import { readdirSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueDevice } from '../src/inbox/companion.js';
import { workspaceByTeam } from '../src/inbox/store.js';
import { setSetting } from '../src/settings/settings.js';
import { createApp } from '../src/web/app.js';
import type { FakeTab, FetchCall } from './fixtures/extension.js';
import { EXTENSION_DIR, EXTENSION_ID, FakeBrowser, FakeSocket, loadLib, source } from './fixtures/extension.js';
import type { Harness } from './helpers.js';
import { OWNER, harness, resetDb, seedPeople, testPool, webDeps } from './helpers.js';

/**
 * The browser extension, loaded from `extension/` as Chrome would load it, against a
 * made-up page and made-up Chrome interfaces, posting to the real Patcher routes. No
 * request here reached Slack, the "page" is not Slack's client, and every frame, name and
 * credential-shaped string is invented. What these tests show is what the extension does
 * with frames of the shape it expects; whether Slack sends frames of that shape is for the
 * spike to answer.
 */
const pool = testPool();
let h: Harness;
let app: ReturnType<typeof createApp>;
let browser: FakeBrowser;
let offline = false;

/** Where the made-up Patcher lives. Requests to it are answered by the real routes, in this process. */
const BASE_URL = 'https://patcher.test';
const ACME = 'T0ACME';
const GLOBEX = 'T0GLOBEX';
const ME = 'U0MEATACME';
const DANA = 'U0DANA';
const CHANNEL = 'C0ACMEPORTAL';
const DM = 'D0ACMEDANA';
const SOCKET_TOKEN = 'xoxc-made-up-socket-token';
const COOKIE = 'made-up-session-cookie';
const ASK = 'Can you confirm the invoice export goes live on Friday?';

let clock = 0;
const ts = (): string => `${Math.floor(Date.now() / 1000)}.${String(++clock).padStart(6, '0')}`;
const frame = (overrides: Record<string, unknown> = {}) => ({ type: 'message', channel: CHANNEL, user: DANA, text: ASK, ts: ts(), team: ACME, ...overrides });

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await setSetting(pool, 'inbox.enabled', true, OWNER);
  h = harness(pool);
  app = createApp(webDeps(h));
  FakeSocket.reset();
  offline = false;
  browser = new FakeBrowser(async (call: FetchCall) => {
    if (offline) throw new Error('offline');
    const path = new URL(call.url).pathname;
    const req = call.method === 'GET' ? request(app).get(path) : request(app).post(path).send(call.body as object);
    const res = await req.set(call.headers).set('origin', `chrome-extension://${EXTENSION_ID}`);
    return { status: res.status, json: res.body as unknown };
  }).startWorker();
});
afterAll(() => pool.end());

const key = async () => (await issueDevice(pool, { label: 'Reader profile' }, OWNER)).key;

/** Pairs the extension and switches Acme on in Patcher at the given level. */
async function paired(level: 'notifications' | 'page' = 'notifications', member: string | null = ME): Promise<{ tab: FakeTab; socket: FakeSocket; workspaceId: string }> {
  const tab = browser.tab().load();
  tab.document.title = 'project-portal (Channel) - Acme - Slack';
  const socket = tab.socket();
  expect(await browser.fromOptions({ kind: 'pair', baseUrl: `${BASE_URL}/`, key: await key() })).toEqual({ ok: true });
  const workspace = (await workspaceByTeam(pool, ACME))!;
  await pool.query('UPDATE slack_workspaces SET enabled = true, capture_level = $2, reader_user_id = $3 WHERE id = $1', [workspace.id, level, member]);
  await browser.alarm();
  return { tab, socket, workspaceId: workspace.id };
}

const stored = async () =>
  (await pool.query<{ source: string; text: string | null; own: boolean; mentions_reader: boolean; channel_id: string; channel_name: string | null; sender_name: string | null; sender_id: string | null }>(
    'SELECT source, text, own, mentions_reader, channel_id, channel_name, sender_name, sender_id FROM slack_messages ORDER BY created_at, ts',
  )).rows;
const posted = () => browser.fetches.filter((f) => f.url.endsWith('/ingest/slack')).flatMap((f) => (f.body as { items: Record<string, unknown>[] }).items);
const everythingSent = () => JSON.stringify(browser.fetches);
const everythingKept = async () =>
  JSON.stringify([
    [...browser.local.data.entries()].filter(([name]) => name !== 'pairing'),
    [...browser.session.data.entries()],
    (await pool.query('SELECT * FROM slack_messages')).rows,
    (await pool.query('SELECT * FROM slack_workspaces')).rows,
    (await pool.query('SELECT * FROM companion_devices')).rows,
    (await pool.query('SELECT * FROM companion_workspace_status')).rows,
    (await pool.query('SELECT * FROM slack_names')).rows,
  ]);

describe('what the extension is allowed to do', () => {
  const manifest = JSON.parse(source('manifest.json')) as {
    manifest_version: number;
    permissions: string[];
    host_permissions: string[];
    optional_permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts: { matches: string[]; js: string[]; world?: string; run_at: string }[];
  };
  const files = readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.js'));

  it('asks Chrome for app.slack.com and nothing that reaches a cookie, a request or another site', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual(['https://app.slack.com/*']);
    expect(manifest.permissions.sort()).toEqual(['alarms', 'storage']);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    for (const script of manifest.content_scripts) expect(script.matches).toEqual(['https://app.slack.com/*']);
    expect(manifest.content_scripts.find((s) => s.world === 'MAIN')).toMatchObject({ js: ['tap.js'], run_at: 'document_start' });
  });

  it('has no code that reads a cookie or a page store, sends on a socket, or calls anything but Patcher', () => {
    expect(files.sort()).toEqual(['background.js', 'content.js', 'lib.js', 'options.js', 'tap.js']);
    const code = (file: string) =>
      source(file)
        .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
        .replace(/^\s*\/\/.*$/gm, '');
    for (const file of files) {
      const text = code(file);
      for (const forbidden of ['document.cookie', 'chrome.cookies', 'localStorage', 'sessionStorage', 'indexedDB', 'XMLHttpRequest', 'chrome.debugger', 'chrome.webRequest', 'chrome.scripting', 'innerHTML', 'eval(', '.click(', 'executeScript']) {
        expect(text, `${file} must not use ${forbidden}`).not.toContain(forbidden);
      }
      if (file !== 'background.js') expect(text, `${file} makes no request`).not.toMatch(/\bfetch\(/);
    }
    // The page-world script never looks at a socket's address or what the page sends, and sends nothing itself.
    const tap = code('tap.js');
    for (const forbidden of ['.url', '.send(', 'args[', 'postMessage', 'fetch(', 'chrome.']) expect(tap).not.toContain(forbidden);
    // The one request the worker makes goes to the paired address.
    const worker = code('background.js');
    expect(worker.match(/\bfetch\(/g)).toHaveLength(1);
    expect(worker).toContain('fetch(`${pairing.baseUrl}${path}`');
    expect(worker).toContain("credentials: 'omit'");
    expect(worker).not.toMatch(/https:\/\/(?!app\.slack\.com\/\*)[a-z.]*slack\.com/);
  });
});

describe('listening to the page', () => {
  it('passes on a message with the listed fields only, and counts everything else by its type', () => {
    const tab = browser.tab().load();
    const heard: Record<string, unknown>[] = [];
    tab.document.addEventListener('patcher-companion:frame', (event) => heard.push(JSON.parse((event as CustomEvent<string>).detail) as Record<string, unknown>));
    const socket = tab.socket();
    expect(socket).toBeInstanceOf(FakeSocket);

    socket.push({ type: 'hello', region: 'made-up' });
    socket.push({ type: 'user_typing', channel: CHANNEL, user: DANA });
    socket.push({ type: 'pref_change', name: 'made-up-pref', value: `d=${COOKIE}` });
    socket.push({ type: 'reaction_added', user: DANA, reaction: 'eyes', item: { channel: CHANNEL, ts: '1800000000.000100' } });
    socket.push({ type: 'A type nobody has seen', text: ASK });
    socket.push({ text: ASK, channel: CHANNEL, ts: '1800000000.000100' });
    socket.push(frame({ ts: '1800000000.000100', blocks: [{ type: 'rich_text' }], files: [{ url_private: 'https://files.slack.test/secret' }], client_msg_id: 'abc', secret_field: SOCKET_TOKEN, user_profile: { display_name: 'Dana Reyes', email: 'dana@acme.test' } }));
    socket.push({ type: 'desktop_notification', channel: CHANNEL, msg: '1800000000.000100', title: 'Acme', subtitle: '#project-portal', content: `Dana Reyes: ${ASK}`, avatarImage: 'https://ca.slack-edge.test/x', launchUri: 'slack://channel?team=T0ACME' });
    socket.push('{not json');
    socket.push(new ArrayBuffer(8));
    socket.push(JSON.stringify(['an', 'array']));

    expect(heard).toHaveLength(2);
    expect(heard[0]).toEqual({ type: 'message', channel: CHANNEL, user: DANA, text: ASK, ts: '1800000000.000100', team: ACME, name: 'Dana Reyes', socket: 1, live: 1, at: expect.any(Number) });
    expect(heard[1]).toEqual({ type: 'desktop_notification', channel: CHANNEL, ts: '1800000000.000100', title: 'Acme', subtitle: '#project-portal', content: `Dana Reyes: ${ASK}`, socket: 1, live: 1, at: expect.any(Number) });

    let stats: Record<string, any> = {};
    tab.document.addEventListener('patcher-companion:stats', (event) => (stats = JSON.parse((event as CustomEvent<string>).detail) as Record<string, any>));
    tab.document.dispatchEvent(new CustomEvent('patcher-companion:ask'));
    expect(stats).toMatchObject({ sockets: 1, socketsOpen: 1, frames: 11, messageFrames: 1, notificationFrames: 1, binary: 1, unparsed: 2, liveSockets: 1 });
    expect(stats.types).toEqual({ hello: 1, user_typing: 1, pref_change: 1, reaction_added: 1, other: 2, message: 1, desktop_notification: 1 });
    expect(JSON.stringify(stats)).not.toContain(COOKIE);
  });

  it("never reads a socket's address, a cookie or a page store, and never sends on a socket", async () => {
    const { tab, socket } = await paired('page');
    const second = tab.socket('wss://wss-backup.slack.test/?token=xoxc-another-made-up-token');
    second.close();
    socket.push(frame());
    socket.push(frame({ text: `My token is ${SOCKET_TOKEN}, do not share` }));
    await browser.idle();
    await browser.alarm();

    expect(FakeSocket.addressReads).toBe(0);
    expect(FakeSocket.sends).toBe(0);
    expect(tab.onStorageTouched).toBe(0);
    expect(await stored()).toHaveLength(2);
    for (const haystack of [everythingSent(), await everythingKept()]) {
      expect(haystack).not.toContain('xoxc-');
      expect(haystack).not.toContain(COOKIE);
      expect(haystack).not.toContain('wss-primary');
    }
    expect((await stored())[1]!.text).toBe('My token is [removed], do not share');
  });

  it('leaves the page its sockets and workers exactly as they were', () => {
    const tab = browser.tab().load();
    const Socket = tab.window.WebSocket as typeof FakeSocket;
    class Custom extends Socket {
      extra = true;
    }
    const made = new Custom('wss://made-up.test/');
    expect(made).toBeInstanceOf(FakeSocket);
    expect(made).toBeInstanceOf(Custom);
    expect(made.extra).toBe(true);
    expect(Socket.prototype).toBe(FakeSocket.prototype);
    const Worker = tab.window.Worker as new () => object;
    new Worker();
    expect(tab.workersStarted).toBe(1);
    let stats: Record<string, any> = {};
    tab.document.addEventListener('patcher-companion:stats', (event) => (stats = JSON.parse((event as CustomEvent<string>).detail) as Record<string, any>));
    tab.document.dispatchEvent(new CustomEvent('patcher-companion:ask'));
    expect(stats).toMatchObject({ sockets: 1, workers: 1 });
  });
});

describe('what leaves the tab', () => {
  it('sends nothing at all until it is paired, and still counts for the readout', async () => {
    const tab = browser.tab().load();
    const socket = tab.socket();
    socket.push(frame());
    socket.push(frame({ channel: DM }));
    await browser.alarm();
    expect(browser.fetches).toEqual([]);
    const status = await browser.fromOptions({ kind: 'status' });
    expect(status.pairing).toBeNull();
    expect(status.last.tabs[0]).toMatchObject({ team: ACME, state: 'open', sockets: 1, messageFrames: 2, frames: 2 });
    expect(status.summary.teams[ACME]).toMatchObject({ seen: 2, sent: 0 });
    expect(JSON.stringify([...browser.local.data.entries(), ...browser.session.data.entries()])).not.toContain('invoice');
  });

  it('ignores a workspace that is not switched on in Patcher, without keeping its messages even in memory', async () => {
    const tab = browser.tab().load();
    const socket = tab.socket();
    expect(await browser.fromOptions({ kind: 'pair', baseUrl: BASE_URL, key: await key() })).toEqual({ ok: true });
    // The reader reported the workspace; Patcher added it switched off.
    expect(await workspaceByTeam(pool, ACME)).toMatchObject({ enabled: false, companionEnabled: true });
    socket.push(frame({ channel: DM }));
    socket.push(frame({ text: `<@${ME}> ${ASK}` }));
    await browser.alarm();
    expect(posted()).toEqual([]);
    expect(await stored()).toEqual([]);
    const report = (await tab.deliver({ kind: 'report' })) as { held: number; counts: Record<string, { seen: number; sent: number }> };
    expect(report.held).toBe(0);
    expect(report.counts[ACME]).toMatchObject({ seen: 2, sent: 0 });
  });

  it('at the notification level sends a direct message, a mention, and what Slack asks a notification for', async () => {
    const { socket, tab } = await paired('notifications');
    tab.elements.set('[data-qa-channel-sidebar-channel-id]', [{ attributes: { 'data-qa-channel-sidebar-channel-id': CHANNEL }, textContent: 'project-portal' }]);
    tab.elements.set('[data-qa="message_sender_name"]', [{ attributes: { 'data-message-sender': DANA }, textContent: 'Dana Reyes' }]);
    const quiet = ts();
    const loud = ts();
    socket.push(frame({ channel: DM, channel_type: 'im', text: 'Do you have five minutes?' }));
    socket.push(frame({ ts: quiet, text: 'Lunch at noon?' }));
    socket.push(frame({ text: `<@${ME}> ${ASK}` }));
    socket.push(frame({ ts: loud, text: 'The release is out, <!here>.' }));
    socket.push({ type: 'desktop_notification', channel: CHANNEL, msg: loud, title: 'Acme', subtitle: '#project-portal', content: 'Dana Reyes: The release is out, @here.' });
    // The reader's own reply in a direct message goes without its words; in a channel it does not go at all.
    socket.push(frame({ channel: DM, channel_type: 'im', user: ME, text: 'Yes, call me.' }));
    socket.push(frame({ user: ME, text: 'Sounds good.' }));
    await browser.idle();

    expect(posted().map((i) => i.text)).toEqual(['Do you have five minutes?', `<@${ME}> ${ASK}`, 'The release is out, <!here>.', '']);
    expect(everythingSent()).not.toContain('Lunch at noon');
    expect(everythingSent()).not.toContain('Sounds good');
    expect(everythingSent()).not.toContain('call me');
    const rows = await stored();
    expect(rows.map((r) => [r.source, r.own, r.mentions_reader, r.text])).toEqual([
      ['companion_notification', false, false, 'Do you have five minutes?'],
      ['companion_notification', false, true, `<@${ME}> ${ASK}`],
      ['companion_notification', false, true, 'The release is out, <!here>.'],
      ['companion_notification', true, false, null],
    ]);
    expect(rows[1]).toMatchObject({ channel_id: CHANNEL, channel_name: 'project-portal', sender_name: 'Dana Reyes', sender_id: DANA });

    // An edit or a deletion is passed on only for a message that was sent.
    socket.push(frame({ subtype: 'message_changed', ts: ts(), message: { ts: quiet, text: 'Lunch at one?', user: DANA }, previous_message: { ts: quiet, text: 'Lunch at noon?' } }));
    socket.push(frame({ subtype: 'message_changed', ts: ts(), message: { ts: loud, text: 'The release is out and tested.', user: DANA }, previous_message: { ts: loud, text: 'The release is out, <!here>.' } }));
    await browser.idle();
    expect(posted().filter((i) => i.kind === 'edit')).toEqual([{ kind: 'edit', teamId: ACME, channelId: CHANNEL, ts: loud, text: 'The release is out and tested.' }]);
    expect((await stored())[2]!.text).toBe('The release is out and tested.');
  });

  it('uses the notification alone when the message itself was not heard', async () => {
    const { socket } = await paired('notifications', null);
    const at = ts();
    socket.push({ type: 'desktop_notification', channel: CHANNEL, msg: at, title: 'Acme', subtitle: '#project-portal', content: `Dana Reyes: ${ASK}` });
    socket.push({ type: 'desktop_notification', channel: CHANNEL, msg: at, title: 'Acme', subtitle: '#project-portal', content: `Dana Reyes: ${ASK}` });
    await browser.idle();
    expect(posted()).toEqual([{ kind: 'message', teamId: ACME, channelId: CHANNEL, channelType: 'channel', ts: at, text: ASK, notified: true, via: 'notification', channelName: 'project-portal', senderName: 'Dana Reyes' }]);
    expect(await stored()).toMatchObject([{ source: 'companion_notification', text: ASK, sender_name: 'Dana Reyes', channel_name: 'project-portal', mentions_reader: true }]);
  });

  it('at the page level sends every message once, applies edits and deletions, and never the owner\'s own words', async () => {
    const { socket } = await paired('page');
    const first = ts();
    const second = ts();
    socket.push(frame({ ts: first, text: 'Lunch at noon?' }));
    socket.push(frame({ ts: first, text: 'Lunch at noon?' }));
    socket.push(frame({ ts: second, text: 'The staging deploy is done.', thread_ts: first }));
    socket.push(frame({ user: ME, text: 'I will look at it today.' }));
    socket.push(frame({ subtype: 'channel_join', text: 'joined the channel' }));
    socket.push(frame({ subtype: 'message_replied', hidden: true, message: { ts: first, text: 'Lunch at noon?' } }));
    await browser.idle();
    expect(posted()).toHaveLength(4);
    expect(everythingSent()).not.toContain('I will look at it today');
    expect((await stored()).map((r) => [r.own, r.text])).toEqual([
      [false, 'Lunch at noon?'],
      [false, 'The staging deploy is done.'],
      [true, null],
    ]);

    socket.push(frame({ subtype: 'message_changed', ts: ts(), message: { ts: first, text: 'Lunch at one?', user: DANA }, previous_message: { ts: first, text: 'Lunch at noon?' } }));
    socket.push(frame({ subtype: 'message_deleted', ts: ts(), deleted_ts: second, previous_message: { ts: second, text: 'The staging deploy is done.' } }));
    // A thread's first message is "changed" when a reply is added: the text is the same, so nothing is sent.
    socket.push(frame({ subtype: 'message_changed', ts: ts(), message: { ts: first, text: 'Lunch at one?', user: DANA }, previous_message: { ts: first, text: 'Lunch at one?' } }));
    await browser.idle();
    expect(posted().slice(4)).toEqual([
      { kind: 'edit', teamId: ACME, channelId: CHANNEL, ts: first, text: 'Lunch at one?' },
      { kind: 'delete', teamId: ACME, channelId: CHANNEL, ts: second },
    ]);
    expect((await stored()).map((r) => r.text)).toEqual(['Lunch at one?', null]);
  });

  it('files a message under the workspace its tab shows, whatever the frame names', async () => {
    const { socket } = await paired('page');
    socket.push(frame({ team: GLOBEX, user_team: GLOBEX, source_team: GLOBEX }));
    await browser.idle();
    expect(posted().map((i) => i.teamId)).toEqual([ACME]);
    const status = await browser.fromOptions({ kind: 'tick' });
    expect(status.last.tabs[0].teams).toEqual({ [GLOBEX]: 1 });
  });

  it('sends nothing from a tab in which two sockets carry messages at once', async () => {
    const { tab, socket } = await paired('page');
    const other = tab.socket('wss://wss-primary.slack.test/?token=xoxc-made-up-other-workspace');
    socket.push(frame({ text: 'From the first socket.' }));
    other.push(frame({ text: 'From the second socket.' }));
    socket.push(frame({ text: 'From the first socket again.' }));
    await browser.idle();
    expect(posted().map((i) => i.text)).toEqual(['From the first socket.']);
    const status = await browser.fromOptions({ kind: 'tick' });
    expect(status.last.tabs[0]).toMatchObject({ liveSockets: 2, ambiguous: 2 });

    // The second socket closes: the tab has one live socket again and capture resumes.
    other.close();
    socket.push(frame({ text: 'One socket again.' }));
    await browser.idle();
    expect(posted().map((i) => i.text)).toEqual(['From the first socket.', 'One socket again.']);
  });

  it('stops sending within a minute of a workspace being switched off, and forgets what it held', async () => {
    const { socket, tab, workspaceId } = await paired('notifications');
    socket.push(frame({ text: 'Lunch at noon?' }));
    expect(((await tab.deliver({ kind: 'report' })) as { held: number }).held).toBe(1);
    await pool.query('UPDATE slack_workspaces SET companion_enabled = false WHERE id = $1', [workspaceId]);
    await browser.alarm();
    expect(((await tab.deliver({ kind: 'report' })) as { held: number }).held).toBe(0);
    socket.push(frame({ channel: DM, channel_type: 'im' }));
    await browser.idle();
    expect(posted()).toEqual([]);
  });
});

describe('the background worker', () => {
  it('pairs only with a Patcher that accepts the key, and never shows the key again', async () => {
    browser.tab().load();
    const deviceKey = await key();
    expect((await browser.fromOptions({ kind: 'pair', baseUrl: 'http://patcher.example.com', key: deviceKey })).error).toContain('starting with https://');
    expect((await browser.fromOptions({ kind: 'pair', baseUrl: 'https://app.slack.com', key: deviceKey })).error).toContain('starting with https://');
    expect((await browser.fromOptions({ kind: 'pair', baseUrl: BASE_URL, key: 'not-a-key' })).error).toContain('not a device key');
    expect((await browser.fromOptions({ kind: 'pair', baseUrl: BASE_URL, key: `pdk_${'x'.repeat(32)}` })).error).toContain('does not accept this key');
    expect(browser.local.data.has('pairing')).toBe(false);

    expect(await browser.fromOptions({ kind: 'pair', baseUrl: BASE_URL, key: deviceKey })).toEqual({ ok: true });
    const status = await browser.fromOptions({ kind: 'status' });
    expect(status.pairing).toMatchObject({ baseUrl: BASE_URL, revoked: false });
    expect(JSON.stringify(status)).not.toContain(deviceKey);
    expect(browser.local.accessLevel).toBe('TRUSTED_CONTEXTS');
    for (const call of browser.fetches) {
      expect(call.url.startsWith(`${BASE_URL}/ingest/slack`)).toBe(true);
      expect(call.credentials).toBe('omit');
    }
  });

  it('answers a Slack tab only with the list of workspaces, and takes only messages from it', async () => {
    const { tab } = await paired('page');
    for (const kind of ['status', 'pair', 'unpair', 'tick', 'previews', 'preview', 'clearLog']) {
      expect(await browser.fromTab(tab, { kind, baseUrl: 'https://evil.example', key: `pdk_${'y'.repeat(32)}`, on: true })).toBeUndefined();
    }
    expect((browser.local.data.get('pairing') as { baseUrl: string }).baseUrl).toBe(BASE_URL);
    const hello = (await browser.fromTab(tab, { kind: 'hello' })) as Record<string, unknown>;
    expect(Object.keys(hello).sort()).toEqual(['config', 'preview']);
    expect(JSON.stringify(hello)).not.toContain('pdk_');
    // A tab cannot make the worker send a message for a workspace that is not switched on.
    await browser.fromTab(tab, { kind: 'items', items: [{ kind: 'message', teamId: GLOBEX, channelId: 'C0GLOBEX', ts: ts(), text: 'Made up' }] });
    await browser.idle();
    expect(posted()).toEqual([]);
  });

  it('reports every minute what each workspace is doing, and Patcher draws coverage from it', async () => {
    const { socket, tab } = await paired('page');
    tab.elements.set('a.c-timestamp[href*="/archives/"]', [{ href: 'https://acme-co.slack.com/archives/C0ACMEPORTAL/p1800000000000100' }]);
    tab.elements.set('[data-qa="user-button"] img', [{ src: `https://ca.slack-edge.test/${ACME}-${ME}-0123abcd-48` }]);
    socket.push(frame());
    socket.push(frame());
    await browser.idle();
    await browser.alarm();
    const beat = browser.fetches.filter((f) => f.url.endsWith('/heartbeat')).at(-1)!.body as { version: string; workspaces: Record<string, unknown>[]; diagnostics: { tabs: Record<string, unknown>[] } };
    expect(beat.version).toBe('0.1.0');
    expect(beat.workspaces).toEqual([{ teamId: ACME, state: 'open', seen: 2, sent: 2, name: 'Acme', domain: 'acme-co', selfUserId: ME, lastFrameAt: expect.any(String) }]);
    expect(beat.diagnostics.tabs[0]).toMatchObject({ team: ACME, state: 'open', pinned: true, notification: 'denied', sockets: 1, socketsOpen: 1, frames: 2, messageFrames: 2, types: { message: 2 } });
    expect(await workspaceByTeam(pool, ACME)).toMatchObject({ name: 'Acme', domain: 'acme-co' });
    const coverage = (await pool.query<{ seen: number; sent: number; stored: number; open_beats: number }>('SELECT seen, sent, stored, open_beats FROM companion_coverage')).rows;
    expect(coverage).toEqual([{ seen: 2, sent: 2, stored: 2, open_beats: expect.any(Number) }]);
    expect(coverage[0]!.open_beats).toBeGreaterThanOrEqual(1);
    expect((await pool.query<{ suggested_user_id: string }>('SELECT suggested_user_id FROM companion_workspace_status')).rows).toEqual([{ suggested_user_id: ME }]);

    // The next report carries only what is new.
    await browser.alarm();
    expect((browser.fetches.filter((f) => f.url.endsWith('/heartbeat')).at(-1)!.body as typeof beat).workspaces[0]).toMatchObject({ seen: 0, sent: 0 });
  });

  it('tells a signed-out workspace, a sleeping tab and a closed one apart', async () => {
    const { tab } = await paired('page');
    const states = async () => {
      await browser.alarm();
      const beat = browser.fetches.filter((f) => f.url.endsWith('/heartbeat')).at(-1)!.body as { workspaces: { teamId: string; state: string; detail?: string }[] };
      return beat.workspaces.map((w) => [w.state, w.detail]);
    };
    expect(await states()).toEqual([['open', undefined]]);

    tab.discarded = true;
    expect(await states()).toEqual([['asleep', 'Chrome discarded the tab']]);
    tab.discarded = false;

    tab.location.pathname = '/signin';
    expect(await states()).toEqual([['signed_out', 'the tab shows a sign-in page']]);
    expect(await states()).toEqual([['signed_out', 'the tab shows a sign-in page']]);
    expect(browser.badge).toBe('!');
    tab.location.pathname = `/client/${ACME}/${CHANNEL}`;
    expect(await states()).toEqual([['open', undefined]]);
    expect(browser.badge).toBe('');

    // Slack sends the tab to the workspace's own address to sign in: the tab is still there, on a page the extension may not see.
    browser.leave(tab);
    expect(await states()).toEqual([['signed_out', 'the tab left app.slack.com']]);
    browser.elsewhere.clear();
    expect(await states()).toEqual([['closed', undefined]]);

    // A tab that was open before the extension was loaded has no script in it.
    const stale = browser.tab();
    stale.injected = false;
    stale.load();
    expect(await states()).toEqual([['asleep', 'no answer: reload the tab']]);
    const events = (await pool.query<{ from_state: string | null; to_state: string }>(`SELECT from_state, to_state FROM companion_events WHERE kind = 'state' ORDER BY id`)).rows.map((e) => `${e.from_state}>${e.to_state}`);
    expect(events).toEqual(['null>open', 'open>asleep', 'asleep>signed_out', 'signed_out>open', 'open>signed_out', 'signed_out>closed', 'closed>asleep']);
  });

  it('keeps messages while Patcher cannot be reached and sends them when it can, also after Chrome restarted the worker', async () => {
    const { socket } = await paired('page');
    offline = true;
    socket.push(frame({ text: 'Sent while Patcher was down.' }));
    await browser.idle();
    expect(await stored()).toEqual([]);
    expect((await browser.fromOptions({ kind: 'status' })).queue).toBe(1);
    expect((await browser.fromOptions({ kind: 'status' })).pairing.lastError).toBe('Patcher could not be reached.');

    browser.restartWorker();
    offline = false;
    await browser.alarm();
    expect((await stored()).map((r) => r.text)).toEqual(['Sent while Patcher was down.']);
    const status = await browser.fromOptions({ kind: 'status' });
    expect(status).toMatchObject({ queue: 0, starts: 2 });
    expect(status.pairing.lastError).toBeNull();
  });

  it('stops and forgets its queue when the key is revoked', async () => {
    const { socket } = await paired('page');
    offline = true;
    socket.push(frame({ text: 'Waiting to be sent.' }));
    await browser.idle();
    offline = false;
    await pool.query('UPDATE companion_devices SET revoked_at = now()');
    await browser.alarm();
    const status = await browser.fromOptions({ kind: 'status' });
    expect(status).toMatchObject({ queue: 0, pairing: { revoked: true }, config: null });
    const before = browser.fetches.length;
    socket.push(frame({ text: 'After the key was revoked.' }));
    await browser.idle();
    await browser.alarm();
    expect(browser.fetches.length).toBe(before);
    expect(await stored()).toEqual([]);
    expect(browser.badge).toBe('!');

    expect(await browser.fromOptions({ kind: 'unpair' })).toEqual({ ok: true });
    expect(browser.local.data.has('pairing')).toBe(false);
  });

  it('shows the start of what a tab heard only when asked, and only from the tab\'s memory', async () => {
    const tab = browser.tab().load();
    const socket = tab.socket();
    socket.push(frame({ text: 'Before the preview was on.' }));
    expect(await browser.fromOptions({ kind: 'previews' })).toEqual([{ team: ACME, previews: [] }]);
    await browser.fromOptions({ kind: 'preview', on: true });
    socket.push(frame({ text: `${'A long message. '.repeat(20)}` }));
    const [shown] = (await browser.fromOptions({ kind: 'previews' })) as { previews: { text: string; channel: string }[] }[];
    expect(shown!.previews).toHaveLength(1);
    expect(shown!.previews[0]!.text).toHaveLength(80);
    expect(JSON.stringify([...browser.local.data.entries(), ...browser.session.data.entries()])).not.toContain('A long message');
    expect(browser.fetches).toEqual([]);
    await browser.fromOptions({ kind: 'preview', on: false });
    expect(await browser.fromOptions({ kind: 'previews' })).toEqual([{ team: ACME, previews: [] }]);
  });
});

describe('the readout for the spike', () => {
  const lib = loadLib();

  it('finds the silences, the minutes in each state and the sign-outs in the minute log', () => {
    const minute = 60_000;
    const t0 = 1_800_000_000_000;
    const ticks = [
      { t: t0, w: { [ACME]: ['open', 2, 1] } },
      { t: t0 + minute, w: { [ACME]: ['open', 0, 0] } },
      { t: t0 + 2 * minute, w: { [ACME]: ['signed_out', 0, 0] } },
      { t: t0 + 50 * minute, w: { [ACME]: ['open', 5, 5], [GLOBEX]: ['closed', 0, 0] } },
    ];
    const summary = lib.summariseTicks(ticks, 150_000);
    expect(summary).toMatchObject({ from: t0, to: t0 + 50 * minute, ticks: 4, gaps: [{ from: t0 + 2 * minute, to: t0 + 50 * minute, minutes: 48 }] });
    expect(summary.teams[ACME]).toMatchObject({ minutes: { open: 3, signed_out: 1 }, seen: 7, sent: 6, signOuts: 1 });
    expect(summary.teams[ACME].changes.map((c: { from: string; to: string }) => `${c.from}>${c.to}`)).toEqual(['open>signed_out', 'signed_out>open']);
    expect(summary.teams[GLOBEX].minutes.closed).toBe(1);
  });

  it('does not count a "Check now" as a minute', () => {
    const t0 = 1_800_000_000_000;
    const ticks = [0, 60, 62, 64, 66, 120].map((s) => ({ t: t0 + s * 1000, w: { [ACME]: ['open', 0, 0] } }));
    expect(lib.summariseTicks(ticks, 150_000).teams[ACME].minutes.open).toBe(3);
  });

  it('logs a line a minute with counts and states and no text, and can be cleared', async () => {
    const { socket } = await paired('page');
    socket.push(frame());
    await browser.idle();
    await browser.alarm();
    const ticks = browser.local.data.get('ticks') as { t: number; w: Record<string, [string, number, number]> }[];
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.at(-1)!.w[ACME]).toEqual(['open', 1, 1]);
    expect(JSON.stringify(ticks)).not.toContain('invoice');
    await browser.fromOptions({ kind: 'clearLog' });
    expect(browser.local.data.get('ticks')).toEqual([]);
  });

  it('reads the workspace from the address of a client page and nothing from any other page', () => {
    expect(lib.teamFromPath('/client/T0ACME/C0ACMEPORTAL')).toBe('T0ACME');
    expect(lib.teamFromPath('/client/E0GRID')).toBe('E0GRID');
    expect(lib.teamFromPath('/client/')).toBeNull();
    expect(lib.teamFromPath('/signin')).toBeNull();
    expect(lib.pageKind('/client/T0ACME')).toBe('client');
    expect(lib.pageKind('/workspace-signin')).toBe('signin');
    expect(lib.pageKind('/')).toBe('other');
    expect(lib.cleanBaseUrl('https://patcher.example.com/inbox?x=1')).toBe('https://patcher.example.com');
    expect(lib.cleanBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(lib.cleanBaseUrl('https://user:pass@patcher.example.com')).toBeNull();
    expect(lib.cleanBaseUrl('https://acme.slack.com')).toBeNull();
    expect(lib.cleanBaseUrl('javascript:alert(1)')).toBeNull();
  });
});
