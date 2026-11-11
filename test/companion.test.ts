import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { companionHealth, heartbeat, issueDevice, plainDiagnostics, purgeCompanion, scrub } from '../src/inbox/companion.js';
import { watchCompanion } from '../src/inbox/companionWatch.js';
import { processBundle } from '../src/inbox/pipeline.js';
import { getWorkspace, listBundles, listWorkspaces, workspaceByTeam } from '../src/inbox/store.js';
import { getRecommendation } from '../src/recommendations/service.js';
import { setSetting } from '../src/settings/settings.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { scheduleHandlers } from '../src/worker/handlers.js';
import { seedRegistry, testSecrets } from './fixtures/calls.js';
import { ASK, DANA, FakeReader, MAIL_SECRET, OUTAGE, PORTAL_CHANNEL, connectHub, mailWorkspace, messageEvent, notificationMail, nowTs, recommendAnswer, triageAnswer, work } from './fixtures/inbox.js';
import { FakeModel } from './fixtures/model.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, SIGNING_SECRET, VIEWER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';
import { issueAlias } from '../src/inbox/email.js';

/**
 * The browser companion as Patcher sees it: device keys, the three ingest routes, the
 * workspaces a reader reports, what is kept at each capture level, the notices, and the
 * screen. The extension is played by plain HTTP requests with made-up frames; no request
 * here reached Slack, and no real workspace, person or message appears.
 */
const pool = testPool();
let h: Harness;
let model: FakeModel;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;

const ACME = 'T0ACME';
const GLOBEX = 'T0GLOBEX';
const ME = 'U0MEATACME';
const ACME_DM = 'D0ACMEDANA';
const ACME_CHANNEL = 'C0ACMEPORTAL';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const MADE_UP_TOKEN = 'xoxc-1111111111-2222222222-made-up-not-a-token';

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'inbox', 'C0INBOX');
  await routeTo(pool, 'errors', 'C0ERRORS');
  await setSetting(pool, 'inbox.enabled', true, OWNER);
  await setSetting(pool, 'inbox.settle_seconds', 0, OWNER);
  await setSetting(pool, 'inbox.quiet_hours', '', OWNER);
  await seedRegistry(pool, OWNER);
  model = new FakeModel();
  const reader = new FakeReader();
  h = harness(pool, { integrations: testIntegrations({ model, slackReader: () => reader }), secrets: testSecrets().box });
  deps = webDeps(h, { inboundEmailSecret: MAIL_SECRET });
  app = createApp(deps);
});
afterAll(() => pool.end());

const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)![1]!;

async function signIn(userId: string) {
  deps.oidc.identity = { teamId: HUB, userId, name: null, email: null };
  const agent = request.agent(app);
  await agent.get('/auth/slack');
  await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState }).expect(302);
  const csrf = csrfOf((await agent.get('/settings').expect(200)).text);
  const post = (path: string, fields: Record<string, string> = {}) => agent.post(path).type('form').send({ _csrf: csrf, ...fields });
  const submit = async (path: string, fields: Record<string, string> = {}) => {
    const res = await post(path, fields).expect(303);
    return (await agent.get(res.headers.location!.split('#')[0]!)).text;
  };
  return { agent, post, submit };
}

const pair = async (label = 'Reader profile') => (await issueDevice(pool, { label }, OWNER)).key;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

interface Beat {
  teamId: string;
  state?: string;
  seen?: number;
  sent?: number;
  name?: string;
  domain?: string;
  detail?: string;
  selfUserId?: string;
  lastFrameAt?: string;
}
const beat = (key: string, workspaces: Beat[], diagnostics: unknown = undefined) =>
  request(app)
    .post('/ingest/slack/heartbeat')
    .set(bearer(key))
    .send({ version: '0.1.0', workspaces: workspaces.map((w) => ({ state: 'open', seen: 0, sent: 0, ...w })), diagnostics });

const send = (key: string, items: Record<string, unknown>[]) => request(app).post('/ingest/slack').set(bearer(key)).send({ items });

const message = (overrides: Record<string, unknown> = {}) => ({ kind: 'message', teamId: ACME, channelId: ACME_CHANNEL, channelType: 'channel', ts: nowTs(), userId: DANA, text: ASK, ...overrides });

/** A client workspace the reader has reported and the owner has switched on. */
async function acme(options: { level?: 'notifications' | 'page'; member?: string | null } = {}): Promise<{ key: string; id: string }> {
  const key = await pair();
  await beat(key, [{ teamId: ACME, name: 'Acme', domain: 'acme-co' }]).expect(200);
  const id = (await workspaceByTeam(pool, ACME))!.id;
  await pool.query('UPDATE slack_workspaces SET enabled = true, capture_level = $2, reader_user_id = $3 WHERE id = $1', [id, options.level ?? 'notifications', options.member === undefined ? ME : options.member]);
  return { key, id };
}

const stored = async () =>
  (await pool.query<{ source: string; text: string | null; own: boolean; mentions_reader: boolean; channel_name: string | null; sender_name: string | null; link: string | null }>(
    'SELECT source, text, own, mentions_reader, channel_name, sender_name, link FROM slack_messages ORDER BY created_at',
  )).rows;
const drops = async () => Object.fromEntries((await pool.query<{ reason: string; n: number }>('SELECT reason, n FROM slack_drop_counts')).rows.map((r) => [r.reason, r.n]));
const posts = (channel: string) => h.slack.of('postMessage').filter((m) => m.channel === channel).map((m) => String(m.text));
const hold = (state: string, minutes: number) => pool.query(`UPDATE companion_workspace_status SET state_since = now() - make_interval(mins => $2) WHERE state = $1`, [state, minutes]);

describe('pairing a reader', () => {
  it('shows the key once to an owner and keeps only its hash', async () => {
    const owner = await signIn(OWNER);
    const res = await owner.post('/inbox/companion/devices', { label: 'Reader profile on the laptop' }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const key = /<code>(pdk_[A-Za-z0-9_-]{32})<\/code>/.exec(res.text)![1]!;
    expect(res.text).toContain('Patcher address: <code>http://patcher.test</code>');

    const everything = JSON.stringify((await pool.query('SELECT * FROM companion_devices')).rows) + JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    expect(everything).not.toContain(key);
    expect((await owner.agent.get('/inbox')).text).not.toContain(key);
    expect((await owner.agent.get('/inbox')).text).toContain('Key not used yet');
    expect(await auditActions(pool)).toContain('inbox.companion.issue');

    await request(app).get('/ingest/slack/config').set(bearer(key)).expect(200);
    expect((await owner.agent.get('/inbox')).text).toContain('Not reporting');
  });

  it('is for owners only, and needs a name', async () => {
    for (const who of [APPROVER, VIEWER]) {
      const person = await signIn(who);
      await person.post('/inbox/companion/devices', { label: 'Mine' }).expect(403);
      expect((await person.agent.get('/inbox')).text).not.toContain('Pair a reader');
    }
    const owner = await signIn(OWNER);
    expect(await owner.submit('/inbox/companion/devices', { label: '   ' })).toContain('Give the reader a name');
    expect((await pool.query('SELECT 1 FROM companion_devices')).rowCount).toBe(0);
  });

  it('refuses a request without a key, with a wrong one, and with a revoked one', async () => {
    const key = await pair();
    await request(app).get('/ingest/slack/config').expect(401);
    await request(app).get('/ingest/slack/config').set(bearer(`pdk_${'x'.repeat(32)}`)).expect(401);
    await request(app).get('/ingest/slack/config').set({ authorization: 'Bearer not-a-key' }).expect(401);
    await request(app).post('/ingest/slack').send({ items: [message()] }).expect(401);
    await request(app).post('/ingest/slack/heartbeat').send({ version: '0.1.0', workspaces: [] }).expect(401);
    await beat(key, [{ teamId: ACME }]).expect(200);

    const owner = await signIn(OWNER);
    const id = (await pool.query<{ id: string }>('SELECT id FROM companion_devices')).rows[0]!.id;
    expect(await owner.submit(`/inbox/companion/devices/${id}/revoke`)).toContain('Revoked.');
    expect(await auditActions(pool)).toContain('inbox.companion.revoke');
    await request(app).get('/ingest/slack/config').set(bearer(key)).expect(401);
    await send(key, [message()]).expect(401);
    await beat(key, [{ teamId: ACME }]).expect(401);
    expect((await pool.query('SELECT 1 FROM companion_workspace_status')).rowCount).toBe(0);
    expect(await owner.submit(`/inbox/companion/devices/${id}/revoke`)).toContain('already revoked');
    const viewer = await signIn(VIEWER);
    await viewer.post(`/inbox/companion/devices/${id}/revoke`).expect(403);
  });

  it('answers an extension from another origin, and no other site', async () => {
    const preflight = await request(app).options('/ingest/slack/heartbeat').set({ origin: EXTENSION, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }).expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(EXTENSION);
    expect(preflight.headers['access-control-allow-headers']).toBe('authorization, content-type');
    const key = await pair();
    const fromExtension = await request(app).get('/ingest/slack/config').set({ ...bearer(key), origin: EXTENSION }).expect(200);
    expect(fromExtension.headers['access-control-allow-origin']).toBe(EXTENSION);
    expect(fromExtension.headers['cache-control']).toBe('no-store');
    for (const origin of ['https://app.slack.com', 'https://evil.example', 'chrome-extension://short']) {
      const res = await request(app).get('/ingest/slack/config').set({ ...bearer(key), origin });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('which workspaces a reader may capture', () => {
  it('adds a workspace the reader reports switched off, and captures nothing until an owner switches it on', async () => {
    const key = await pair();
    const first = await beat(key, [{ teamId: ACME, name: 'Acme', domain: 'acme-co', selfUserId: ME }]).expect(200);
    expect(first.body).toMatchObject({ ok: true, reading: true, workspaces: [] });
    const row = (await workspaceByTeam(pool, ACME))!;
    expect(row).toMatchObject({ name: 'Acme', domain: 'acme-co', enabled: false, readMode: 'companion', companionEnabled: true, captureLevel: 'notifications', readerUserId: null });

    // What the extension sends anyway is dropped here too.
    expect((await send(key, [message({ channelId: ACME_DM, channelType: 'im' })]).expect(200)).body).toMatchObject({ stored: 0, outcomes: { workspace_off: 1 } });
    expect(await stored()).toEqual([]);

    const owner = await signIn(OWNER);
    const page = (await owner.agent.get('/inbox')).text;
    expect(page).toContain('<strong>Acme</strong>');
    expect(page).toContain(`The reader's page suggests <code>${ME}</code>`);
    await owner.submit(`/inbox/workspaces/${row.id}`, { enabled: '1', read_dms: '1', channel_default: 'include', companion_enabled: '1', capture_level: 'notifications', reader_user_id: ME.toLowerCase() });
    expect((await beat(key, [{ teamId: ACME }])).body.workspaces).toEqual([{ teamId: ACME, name: 'Acme', level: 'notifications', selfUserId: ME }]);
    expect((await send(key, [message({ channelId: ACME_DM, channelType: 'im' })])).body).toMatchObject({ stored: 1 });
  });

  it('joins a workspace already known from mail by its address, and leaves the companion off for it', async () => {
    const known = await mailWorkspace(pool, 'acme-co', 'Acme from mail');
    const key = await pair();
    expect((await beat(key, [{ teamId: ACME, name: 'Acme', domain: 'acme-co' }])).body.workspaces).toEqual([]);
    expect(await listWorkspaces(pool)).toHaveLength(1);
    expect(await getWorkspace(pool, known)).toMatchObject({ teamId: ACME, name: 'Acme from mail', enabled: true, readMode: 'email_only', companionEnabled: false });
    expect((await send(key, [message({ channelId: ACME_DM, channelType: 'im' })])).body.outcomes).toEqual({ companion_off: 1 });
    expect(await stored()).toEqual([]);

    const owner = await signIn(OWNER);
    await owner.submit(`/inbox/workspaces/${known}`, { enabled: '1', read_dms: '1', channel_default: 'include', companion_enabled: '1', capture_level: 'page', reader_user_id: ME });
    expect(await getWorkspace(pool, known)).toMatchObject({ readMode: 'companion', companionEnabled: true, captureLevel: 'page', readerUserId: ME });
    await owner.submit(`/inbox/workspaces/${known}`, { enabled: '1', read_dms: '1', channel_default: 'include', capture_level: 'page', reader_user_id: ME });
    expect(await getWorkspace(pool, known)).toMatchObject({ readMode: 'email_only', companionEnabled: false });
  });

  it('lists only workspaces that are switched on for the companion, and none while the reader is off', async () => {
    const { key, id } = await acme({ level: 'page' });
    await connectHub(pool);
    await beat(key, [{ teamId: ACME }, { teamId: GLOBEX, name: 'Globex' }]);
    const config = (await request(app).get('/ingest/slack/config').set(bearer(key)).expect(200)).body;
    expect(config).toEqual({ ok: true, device: { label: 'Reader profile' }, reading: true, heartbeatSeconds: 60, maxItems: 100, workspaces: [{ teamId: ACME, name: 'Acme', level: 'page', selfUserId: ME }] });

    await pool.query('UPDATE slack_workspaces SET companion_enabled = false WHERE id = $1', [id]);
    expect((await request(app).get('/ingest/slack/config').set(bearer(key))).body.workspaces).toEqual([]);
    await pool.query('UPDATE slack_workspaces SET companion_enabled = true WHERE id = $1', [id]);
    await setSetting(pool, 'inbox.enabled', false, OWNER);
    expect((await request(app).get('/ingest/slack/config').set(bearer(key))).body).toMatchObject({ reading: false, workspaces: [] });
    expect((await send(key, [message({ channelId: ACME_DM, channelType: 'im' })])).body.outcomes).toEqual({ off: 1 });
  });

  it('takes a member ID only in its own shape, and never changes the one the app authorised', async () => {
    const { id } = await acme({ member: null });
    const hub = await connectHub(pool);
    const owner = await signIn(OWNER);
    expect(await owner.submit(`/inbox/workspaces/${id}`, { enabled: '1', companion_enabled: '1', reader_user_id: 'dana@example.com' })).toContain('A member ID looks like');
    expect((await getWorkspace(pool, id))!.readerUserId).toBeNull();
    await owner.submit(`/inbox/workspaces/${hub}`, { enabled: '1', read_dms: '1', companion_enabled: '1', capture_level: 'page', reader_user_id: 'U0SOMEONEELSE' });
    expect(await getWorkspace(pool, hub)).toMatchObject({ readerUserId: OWNER, readMode: 'api', companionEnabled: true, captureLevel: 'page' });
  });
});

describe('messages at the notification level', () => {
  it('keeps a direct message and a mention, and drops everything else', async () => {
    const { key } = await acme();
    const res = await send(key, [
      message({ channelId: ACME_DM, channelType: 'im', senderName: 'Dana Reyes' }),
      message({ text: 'Lunch at noon?', channelName: 'project-portal' }),
      message({ text: `<@${ME}> ${OUTAGE}`, channelName: '#project-portal', senderName: 'Dana Reyes' }),
      message({ text: 'Release notes are up, <!here>.', notified: true }),
    ]).expect(200);
    expect(res.body).toEqual({ ok: true, received: 4, stored: 3, outcomes: { stored: 3, above_level: 1 } });
    const rows = await stored();
    expect(rows.map((r) => r.source)).toEqual(['companion_notification', 'companion_notification', 'companion_notification']);
    expect(rows.map((r) => r.mentions_reader)).toEqual([false, true, true]);
    expect(rows[1]).toMatchObject({ channel_name: 'project-portal', sender_name: 'Dana Reyes' });
    expect(rows[1]!.link).toMatch(/^https:\/\/acme-co\.slack\.com\/archives\/C0ACMEPORTAL\/p\d{16}$/);
    expect(JSON.stringify(rows)).not.toContain('Lunch at noon');
    expect(await drops()).toEqual({ above_level: 1 });
    expect((await listBundles(pool)).map((b) => b.addressed)).toEqual(expect.arrayContaining([true, true, true]));
  });

  it('keeps a message known only from the notification Slack asked for', async () => {
    const { key } = await acme({ member: null });
    const res = await send(key, [message({ userId: undefined, senderName: 'Dana Reyes', channelName: 'project-portal', notified: true, via: 'notification' })]);
    expect(res.body.outcomes).toEqual({ stored: 1 });
    expect(await stored()).toMatchObject([{ source: 'companion_notification', text: ASK, sender_name: 'Dana Reyes', mentions_reader: true }]);
  });

  it('remembers names only for what it kept', async () => {
    const { key } = await acme();
    await send(key, [
      message({ text: 'Nothing for you here.', channelName: 'random', senderName: 'Sam Okafor', userId: 'U0SAM', channelId: 'C0ACMERANDOM' }),
      message({ text: `<@${ME}> ${ASK}`, channelName: 'project-portal', senderName: 'Dana Reyes' }),
    ]);
    const names = (await pool.query<{ kind: string; external_id: string; name: string }>('SELECT kind, external_id, name FROM slack_names ORDER BY kind')).rows;
    expect(names).toEqual([
      { kind: 'channel', external_id: ACME_CHANNEL, name: 'project-portal' },
      { kind: 'user', external_id: DANA, name: 'Dana Reyes' },
    ]);
  });
});

describe('messages at the page level', () => {
  it('keeps every message, the owner\'s own without its words, and applies an edit and a deletion', async () => {
    const { key, id } = await acme({ level: 'page' });
    const first = nowTs();
    const second = nowTs();
    const res = await send(key, [
      message({ ts: first, text: 'Lunch at noon?' }),
      message({ ts: second, text: 'The staging deploy is done.' }),
      message({ userId: ME, text: '' }),
      message({ text: 'joined the channel', subtype: 'channel_join' }),
      message({ text: 'Build passed', bot: true, userId: undefined }),
    ]).expect(200);
    expect(res.body).toEqual({ ok: true, received: 5, stored: 3, outcomes: { stored: 2, own: 1, system: 1, bot: 1 } });
    const rows = await stored();
    expect(rows.map((r) => [r.source, r.own, r.text])).toEqual([
      ['companion_page', false, 'Lunch at noon?'],
      ['companion_page', false, 'The staging deploy is done.'],
      ['companion_page', true, null],
    ]);
    expect(h.queue.of('inbox.recheck')).toEqual([{ workspaceId: id, channelKey: ACME_CHANNEL }]);

    const changes = await send(key, [
      { kind: 'edit', teamId: ACME, channelId: ACME_CHANNEL, ts: first, text: 'Lunch at one?' },
      { kind: 'delete', teamId: ACME, channelId: ACME_CHANNEL, ts: second },
      { kind: 'edit', teamId: ACME, channelId: ACME_CHANNEL, ts: '1700000000.000001', text: 'Never seen' },
    ]);
    expect(changes.body.outcomes).toEqual({ edited: 1, deleted: 1, ignored: 1 });
    expect((await stored()).map((r) => r.text)).toEqual(['Lunch at one?', null]);
  });

  it('follows the channel rules and the direct-message switch like every other source', async () => {
    const { key, id } = await acme({ level: 'page' });
    await pool.query(`INSERT INTO slack_channel_rules (workspace_id, channel_id, rule, created_by) VALUES ($1, 'C0ACMERANDOM', 'exclude', $2)`, [id, OWNER]);
    await pool.query('UPDATE slack_workspaces SET read_dms = false WHERE id = $1', [id]);
    const res = await send(key, [message({ channelId: 'C0ACMERANDOM' }), message({ channelId: ACME_DM, channelType: 'im' }), message()]);
    expect(res.body.outcomes).toEqual({ excluded: 1, dm_off: 1, stored: 1 });
  });
});

describe('what the ingest route refuses', () => {
  it('drops a message for a workspace it has never heard of, and never creates one from a message', async () => {
    const key = await pair();
    expect((await send(key, [message({ teamId: GLOBEX })])).body).toMatchObject({ stored: 0, outcomes: { no_workspace: 1 } });
    expect(await listWorkspaces(pool)).toEqual([]);
  });

  it('refuses a batch that is malformed or too long', async () => {
    const { key } = await acme({ level: 'page' });
    await send(key, []).expect(400);
    await send(key, [message({ ts: 'yesterday' })]).expect(400);
    await send(key, [message({ teamId: 'acme' })]).expect(400);
    await send(key, [{ kind: 'reaction', teamId: ACME }]).expect(400);
    await send(key, Array.from({ length: 101 }, () => message())).expect(400);
    await request(app).post('/ingest/slack').set(bearer(key)).set('content-type', 'application/json').send('{not json').expect(400);
    expect(await stored()).toEqual([]);
  });

  it('removes anything shaped like a Slack token from what it stores', async () => {
    const { key } = await acme({ level: 'page' });
    await send(key, [message({ text: `Use ${MADE_UP_TOKEN} for the script`, senderName: `Dana ${MADE_UP_TOKEN}`, channelName: 'project-portal' })]).expect(200);
    await beat(key, [{ teamId: ACME, name: `Acme ${MADE_UP_TOKEN}` }], { tabs: [{ team: ACME, note: MADE_UP_TOKEN, sockets: 1 }], cookie: `d=${MADE_UP_TOKEN}` });
    const everything = JSON.stringify([
      (await pool.query('SELECT * FROM slack_messages')).rows,
      (await pool.query('SELECT * FROM slack_names')).rows,
      (await pool.query('SELECT * FROM slack_workspaces')).rows,
      (await pool.query('SELECT * FROM companion_devices')).rows,
      (await pool.query('SELECT * FROM companion_workspace_status')).rows,
    ]);
    expect(everything).not.toContain('xoxc-');
    expect((await stored())[0]!.text).toBe('Use [removed] for the script');
    expect(scrub(`a ${MADE_UP_TOKEN} b xoxb-12345678-abcdefgh`)).toBe('a [removed] b [removed]');
  });

  it('keeps only counts, flags and short labels from the diagnostics', () => {
    expect(
      plainDiagnostics({
        tabs: [{ team: ACME, sockets: 2, pinned: true, notification: 'denied', types: { message: 3, user_typing: 9 }, text: 'Can you confirm the invoice export goes live on Friday? It matters a lot to us and to our customers, so please answer.' }],
        'a key with <markup>': 1,
        nested: { a: { b: { c: { d: 1 } } } },
      }),
    ).toEqual({ tabs: [{ team: ACME, sockets: 2, pinned: true, notification: 'denied', types: { message: 3, user_typing: 9 } }], nested: { a: { b: {} } } });
  });
});

describe('one message from two sources', () => {
  it('is one row when the app and the companion both see it in PatchOps', async () => {
    const hub = await connectHub(pool);
    await pool.query(`UPDATE slack_workspaces SET companion_enabled = true, capture_level = 'page' WHERE id = $1`, [hub]);
    const key = await pair();
    const ts = nowTs();
    const body = JSON.stringify(messageEvent({ ts }));
    const at = Math.floor(Date.now() / 1000);
    await request(app)
      .post('/slack/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', String(at))
      .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, at, body))
      .send(body)
      .expect(200);
    expect((await send(key, [message({ teamId: HUB, channelId: PORTAL_CHANNEL, ts })])).body.outcomes).toEqual({ duplicate: 1 });
    expect((await stored()).map((r) => r.source)).toEqual(['api']);
    expect((await send(key, [message({ teamId: HUB, channelId: PORTAL_CHANNEL })])).body.outcomes).toEqual({ stored: 1 });
    expect((await stored()).map((r) => r.source)).toEqual(['api', 'companion_page']);
  });

  it('drops the notification mail for a message the companion already kept', async () => {
    const { key } = await acme();
    await setSetting(pool, 'inbox.email_address', 'inbox@inbound.example.com', OWNER);
    const token = await issueAlias(pool, OWNER);
    await send(key, [message({ text: `<@${ME}> ${ASK}`, channelName: 'project-portal', senderName: 'Dana Reyes' })]);
    const mail = (text: string) => request(app).post('/ingest/email').set('authorization', `Basic ${Buffer.from(`patcher:${MAIL_SECRET}`).toString('base64')}`).send(notificationMail(token, { TextBody: text }));
    await mail(['Dana Reyes', `@You ${ASK}`, '', 'View in Slack: https://acme-co.slack.com/archives/C0ACMEPORTAL/p1800000000000200'].join('\n')).expect(200);
    expect(await stored()).toHaveLength(1);
    expect((await drops()).duplicate).toBe(1);
    // Mail about something the companion did not see is still read.
    await mail(['Dana Reyes', OUTAGE, '', 'View in Slack: https://acme-co.slack.com/archives/C0ACMEPORTAL/p1800000000000300'].join('\n')).expect(200);
    expect((await stored()).map((r) => r.source)).toEqual(['companion_notification', 'email']);
  });
});

describe('a captured message in the approval loop', () => {
  it('is sorted, recommended and posted to the hub like a message from any other source', async () => {
    const { key } = await acme();
    model.on('record_triage', triageAnswer({ label: 'escalate', urgency: 'now', quote: OUTAGE, project: '' })).on(
      'record_recommendation',
      recommendAnswer({ summary: 'Portal login is down and customers are calling', action: 'reply', draft_reply: 'We are on it.', quote: OUTAGE }),
    );
    await send(key, [message({ channelId: ACME_DM, channelType: 'im', text: OUTAGE, senderName: 'Dana Reyes' })]).expect(200);
    const [bundle] = await listBundles(pool, { statuses: ['open'] });
    expect(bundle).toMatchObject({ source: 'companion_notification', addressed: true });
    h.queue.jobs = h.queue.jobs.filter((j) => j.name !== 'inbox.bundle');
    await processBundle(h.worker, bundle!.id);
    await work(h);
    const done = (await listBundles(pool))[0]!;
    expect([done.status, done.statusDetail]).toEqual(['recommended', null]);
    const rec = (await getRecommendation(pool, done.recommendationId!))!;
    expect(rec.status).toBe('posted');
    const post = h.slack.of('postMessage').find((m) => m.channel === 'C0INBOX')!;
    expect(JSON.stringify(post.blocks)).toContain('Acme Slack');
    expect(JSON.stringify(post.blocks)).toContain('Copy draft');
    // In a client workspace Patcher has no way to post, so there is nothing that sends.
    expect(JSON.stringify(post.blocks)).not.toContain('Send reply');
    // The model was shown this workspace's message and nothing else.
    expect(model.requests.every((r) => !JSON.stringify(r).includes('xox'))).toBe(true);
  });
});

describe('the heartbeat', () => {
  it('records coverage by hour, state changes, and a silence between reports', async () => {
    const { key, id } = await acme();
    await pool.query('TRUNCATE companion_coverage');
    await pool.query('UPDATE companion_devices SET last_heartbeat_at = NULL');
    const reader = { id: (await pool.query<{ id: string }>('SELECT id FROM companion_devices')).rows[0]!.id, label: 'Reader profile' };
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 9, 0, seconds));
    const open = (extra: Record<string, unknown> = {}) => ({ version: '0.1.0', workspaces: [{ teamId: ACME, state: 'open', seen: 0, sent: 0, ...extra }] });
    await heartbeat(pool, reader, open(), at(0));
    await heartbeat(pool, reader, open({ seen: 4, sent: 1, lastFrameAt: at(55).toISOString() }), at(60));
    // "Check now", twice within the same minute: the counts are added, the minute is not counted again.
    await heartbeat(pool, reader, open({ seen: 1 }), at(70));
    await heartbeat(pool, reader, open({ seen: 1 }), at(80));
    await heartbeat(pool, reader, open({ state: 'signed_out', detail: 'the tab shows a sign-in page' }), at(120));
    const coverage = (await pool.query<{ beats: number; open_beats: number; seen: number; sent: number }>('SELECT beats, open_beats, seen, sent FROM companion_coverage')).rows;
    expect(coverage).toEqual([{ beats: 3, open_beats: 2, seen: 6, sent: 1 }]);
    const status = (await pool.query<{ state: string; state_detail: string; last_message_at: Date | null; last_open_at: Date | null }>('SELECT state, state_detail, last_message_at, last_open_at FROM companion_workspace_status')).rows[0]!;
    expect(status).toMatchObject({ state: 'signed_out', state_detail: 'the tab shows a sign-in page' });
    expect(status.last_message_at).toBeInstanceOf(Date);
    expect(status.last_open_at).toBeInstanceOf(Date);

    await pool.query(`UPDATE companion_devices SET last_heartbeat_at = now() - interval '47 minutes'`);
    await beat(key, []).expect(200);
    const events = (await pool.query<{ kind: string; from_state: string | null; to_state: string | null; workspace_id: string | null }>('SELECT kind, from_state, to_state, workspace_id FROM companion_events ORDER BY id')).rows;
    expect(events).toEqual([
      { kind: 'state', from_state: null, to_state: 'open', workspace_id: id },
      { kind: 'state', from_state: 'open', to_state: 'signed_out', workspace_id: id },
      { kind: 'gap', from_state: null, to_state: null, workspace_id: null },
      // The reader no longer mentions the workspace: it has no tab for it.
      { kind: 'state', from_state: 'signed_out', to_state: 'closed', workspace_id: id },
    ]);
    const device = (await pool.query<{ seen_count: string; sent_count: string; version: string }>('SELECT seen_count, sent_count, version FROM companion_devices')).rows[0]!;
    expect(device).toEqual({ seen_count: '6', sent_count: '1', version: '0.1.0' });
  });

  it('refuses a report that is not in the expected shape', async () => {
    const key = await pair();
    await request(app).post('/ingest/slack/heartbeat').set(bearer(key)).send({ version: '0.1.0', workspaces: [{ teamId: ACME, state: 'sleeping', seen: 0, sent: 0 }] }).expect(400);
    await request(app).post('/ingest/slack/heartbeat').set(bearer(key)).send({ version: '<script>', workspaces: [] }).expect(400);
    await request(app).post('/ingest/slack/heartbeat').set(bearer(key)).send({ version: '0.1.0', workspaces: [{ teamId: ACME, state: 'open', seen: -1, sent: 0 }] }).expect(400);
    expect(await listWorkspaces(pool)).toEqual([]);
  });

  it('says in /health how many readers report, with no name in it', async () => {
    expect(await companionHealth(pool)).toEqual({ devices: 0, reporting: 0, lastHeartbeatAt: null });
    const { key } = await acme();
    await pair('A second reader that never reported');
    await beat(key, [{ teamId: ACME }]);
    const health = (await request(app).get('/health').expect(200)).body;
    expect(health.slackReader.companion).toMatchObject({ devices: 2, reporting: 1 });
    expect(JSON.stringify(health)).not.toMatch(/Acme|Reader profile|T0ACME/);
  });
});

describe('what the hub is told', () => {
  const watch = () => watchCompanion(h.worker);

  it('says once, in the inbox channel, that a workspace signed the reader out', async () => {
    const { key } = await acme();
    await beat(key, [{ teamId: ACME, state: 'signed_out' }]);
    // A reload or a restart passes through this state for a moment and says nothing.
    expect(await watch()).toBe('Nothing to tell.');
    await hold('signed_out', 5);
    expect(await watch()).toBe('Told the hub: signed out.');
    expect(posts('C0INBOX')).toHaveLength(1);
    expect(posts('C0INBOX')[0]).toContain('Slack has signed the reader out of *Acme*');
    expect(posts('C0INBOX')[0]).toContain('sign in again in the reader window');
    await beat(key, [{ teamId: ACME, state: 'signed_out' }]);
    await hold('signed_out', 30);
    expect(await watch()).toBe('Nothing to tell.');

    await beat(key, [{ teamId: ACME }]);
    await watch();
    await beat(key, [{ teamId: ACME, state: 'signed_out' }]);
    await hold('signed_out', 5);
    await watch();
    expect(posts('C0INBOX')).toHaveLength(2);
    expect(posts('C0ERRORS')).toEqual([]);
  });

  it('notes a tab that is gone or asleep in the errors channel, after ten minutes', async () => {
    const { key } = await acme();
    await beat(key, [{ teamId: ACME, state: 'asleep', detail: 'Chrome discarded the tab' }]);
    await hold('asleep', 5);
    expect(await watch()).toBe('Nothing to tell.');
    await hold('asleep', 11);
    await watch();
    expect(posts('C0ERRORS')).toHaveLength(1);
    expect(posts('C0ERRORS')[0]).toContain("The reader's tab for Acme is not answering");
    await beat(key, []);
    await hold('closed', 11);
    await watch();
    expect(posts('C0ERRORS')[1]).toContain('The reader has no tab open for Acme');
    expect(posts('C0INBOX')).toEqual([]);
  });

  it('notes a reader that stopped reporting in working hours, once, and not at night', async () => {
    const { key } = await acme();
    await beat(key, [{ teamId: ACME }]);
    await pool.query(`UPDATE companion_devices SET last_heartbeat_at = now() - interval '20 minutes'`);

    const zone = 'America/Chicago';
    const clock = (offsetHours: number) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + offsetHours * 3_600_000));
    await setSetting(pool, 'inbox.quiet_hours', `${clock(-2)}-${clock(2)}`, OWNER);
    expect(await watch()).toBe('Nothing to tell.');
    await setSetting(pool, 'inbox.quiet_hours', '', OWNER);
    expect(await watch()).toBe('Told the hub: silent reader.');
    expect(posts('C0ERRORS')).toHaveLength(1);
    expect(posts('C0ERRORS')[0]).toContain('The Slack reader "Reader profile" has not reported since');
    expect(await watch()).toBe('Nothing to tell.');

    await beat(key, [{ teamId: ACME }]);
    await pool.query(`UPDATE companion_devices SET last_heartbeat_at = now() - interval '20 minutes'`);
    await watch();
    expect(posts('C0ERRORS')).toHaveLength(2);
  });

  it('notes an open reader that sees nothing while messages arrive another way', async () => {
    const { key, id } = await acme();
    await beat(key, [{ teamId: ACME }]);
    await pool.query('UPDATE companion_coverage SET open_beats = 170, beats = 170');
    expect(await watch()).toBe('Nothing to tell.');
    await pool.query(
      `INSERT INTO slack_messages (workspace_id, channel_name, channel_type, sender_name, text, source, dedupe_key, sent_at, purge_after)
       VALUES ($1, 'project-portal', 'channel', 'Dana Reyes', $2, 'email', 'made-up-key', now(), now() + interval '14 days')`,
      [id, ASK],
    );
    expect(await watch()).toBe('Told the hub: capture.');
    expect(posts('C0ERRORS')[0]).toContain('has seen no message, while 1 arrived another way');
    expect(await watch()).toBe('Nothing to tell.');
  });

  it('notes a reader set to send everything that sees messages and sends none', async () => {
    const { key } = await acme({ level: 'page' });
    await beat(key, [{ teamId: ACME, seen: 12, sent: 0 }]);
    await pool.query('UPDATE companion_coverage SET open_beats = 170, beats = 170');
    expect(await watch()).toBe('Told the hub: capture.');
    expect(posts('C0ERRORS')[0]).toContain('saw 12 messages in Acme and sent none');
  });

  it('says nothing about a workspace that is switched off, or while the reader is off', async () => {
    const { key, id } = await acme();
    await beat(key, [{ teamId: ACME, state: 'signed_out' }]);
    await hold('signed_out', 30);
    await pool.query('UPDATE slack_workspaces SET companion_enabled = false WHERE id = $1', [id]);
    expect(await watch()).toBe('Nothing to tell.');
    await pool.query('UPDATE slack_workspaces SET companion_enabled = true WHERE id = $1', [id]);
    await setSetting(pool, 'inbox.enabled', false, OWNER);
    expect(await watch()).toBe('Skipped: the Slack reader is switched off.');
    expect(h.slack.of('postMessage')).toEqual([]);
  });

  it('runs on a schedule, and old coverage is cleared with the other retention work', async () => {
    expect(Object.keys(scheduleHandlers)).toContain('companion.watch');
    expect((await pool.query(`SELECT 1 FROM schedules WHERE key = 'companion.watch'`)).rowCount).toBe(1);
    const { key } = await acme();
    await beat(key, [{ teamId: ACME }]);
    await pool.query(`UPDATE companion_coverage SET hour = hour - interval '40 days'`);
    await pool.query(`UPDATE companion_events SET to_at = to_at - interval '100 days'`);
    await purgeCompanion(pool);
    expect((await pool.query('SELECT 1 FROM companion_coverage')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM companion_events')).rowCount).toBe(0);
  });
});

describe('the companion on the Slack inbox screen', () => {
  it('shows each reader, the health of each workspace, the gaps and the checklist', async () => {
    const { key } = await acme({ level: 'page' });
    await pool.query(`UPDATE companion_devices SET last_heartbeat_at = now() - interval '47 minutes'`);
    await beat(key, [{ teamId: ACME, seen: 7, sent: 7, lastFrameAt: new Date().toISOString() }], {
      tabs: [{ team: ACME, state: 'open', pinned: true, discarded: false, hidden: true, notification: 'denied', sockets: 2, socketsOpen: 1, frames: 420, messageFrames: 7, notificationFrames: 2, binary: 0, unparsed: 0, workers: 1, sharedWorkers: 0, lastFrameAgoS: 3, teams: { [ACME]: 7 }, dom: { channels: 14, messages: 22 } }],
      worker: { starts: 5, queue: 0, dropped: 0 },
    });
    await send(key, [message()]);

    const viewer = await signIn(VIEWER);
    const page = (await viewer.agent.get('/inbox').expect(200)).text;
    const section = page.slice(page.indexOf('id="companion"'), page.indexOf('id="rules"'));
    expect(section).toContain('How it captures has not been proven against Slack');
    expect(section).toContain('<strong>Reader profile</strong>');
    expect(section).toContain('Reporting');
    expect(section).toContain('Every message the reader receives');
    expect(section).toContain('7 seen · 7 sent · 1 kept');
    expect(section).toMatch(/No report for 47 min/);
    expect(section).toContain('cov-strip');
    expect(section).toMatch(/Confirmed<\/span><\/td><td>The Slack tabs are pinned/);
    expect(section).toMatch(/Confirmed<\/span><\/td><td>Slack&#39;s notifications are blocked/);
    expect(section).toMatch(/Check yourself<\/span><\/td><td>app\.slack\.com is on Chrome/);
    expect(section).toContain('420');
    expect(section).toContain('Acme: 7');
    expect(section).not.toContain('Revoke');
    expect(section).not.toContain(ASK);
    expect(page).toContain('Reader: <span class="badge badge-done">Open</span>');
  });

  it('marks what is not set up yet', async () => {
    const { key } = await acme({ member: null });
    await beat(key, [{ teamId: ACME, state: 'signed_out' }], { tabs: [{ state: 'signin', pinned: false, notification: 'default' }] });
    const owner = await signIn(OWNER);
    const page = (await owner.agent.get('/inbox')).text;
    expect(page).toContain('Not open: Acme.');
    expect(page).toContain('1 of 1 not pinned.');
    expect(page).toContain('Missing for: Acme.');
    expect(page).toContain('Signed out');
    expect(page).toContain('Revoke');
  });
});
