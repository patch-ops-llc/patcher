import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { receiveCaptured } from '../src/inbox/capture.js';
import { runDigest } from '../src/inbox/delivery.js';
import { processBundle } from '../src/inbox/pipeline.js';
import { READER_SCOPES, createSlackReaderOAuth, missingHistoryScopes } from '../src/inbox/reader.js';
import { getBundle, getWorkspace, listBundles, listDigests, listRules, listWorkspaces, readerHealth } from '../src/inbox/store.js';
import { backfillAfterGap, checkWorkspace, lastBackfill, requestBackfill, runBackfill } from '../src/inbox/workspace.js';
import { recordConfigured } from '../src/integrations/status.js';
import { getRecommendation } from '../src/recommendations/service.js';
import { getAllSettings, setSetting } from '../src/settings/settings.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { seedRegistry, testSecrets } from './fixtures/calls.js';
import {
  ASK,
  DANA,
  DM_CHANNEL,
  FakeReader,
  GENERAL_CHANNEL,
  MAIL_SECRET,
  OUTAGE,
  PORTAL_CHANNEL,
  READER_TOKEN,
  SAM,
  StubReaderOAuth,
  captured,
  connectHub,
  mailWorkspace,
  notificationMail,
  nowTs,
  recommendAnswer,
  triageAnswer,
  work,
} from './fixtures/inbox.js';
import { FakeModel } from './fixtures/model.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, SIGNING_SECRET, VIEWER, addUser, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The Slack inbox screens, connecting PatchOps for reading, and what the worker does with
 * the connection: the check, the catch-up, a revoked authorisation, switching off. Slack,
 * its OAuth, the model and the mail service are stand-ins; nothing here reached a network.
 */
const pool = testPool();
let h: Harness;
let model: FakeModel;
let reader: FakeReader;
let oauth: StubReaderOAuth;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;
let projects: { acme: string; globex: string };

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'inbox', 'C0INBOX');
  await routeTo(pool, 'errors', 'C0ERRORS');
  await setSetting(pool, 'inbox.enabled', true, OWNER);
  await setSetting(pool, 'inbox.settle_seconds', 0, OWNER);
  await setSetting(pool, 'inbox.quiet_hours', '', OWNER);
  projects = await seedRegistry(pool, OWNER);
  model = new FakeModel();
  reader = new FakeReader();
  oauth = new StubReaderOAuth();
  const integrations = testIntegrations({ model, slackReader: () => reader });
  await recordConfigured(pool, integrations.status);
  h = harness(pool, { integrations, secrets: testSecrets().box });
  deps = webDeps(h, { readerOAuth: oauth, seal: testSecrets().seal, inboundEmailSecret: MAIL_SECRET });
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
    const location = res.headers.location!;
    return { location, page: (await agent.get(location.split('#')[0]!)).text };
  };
  /** Starts the authorisation and comes back from Slack with a code. */
  const connect = async (query: Record<string, string> = {}) => {
    await agent.get('/inbox/connect').expect(302);
    const res = await agent.get('/auth/slack/reader/callback').query({ code: 'reader-code', state: oauth.lastState, ...query }).expect(303);
    return (await agent.get(res.headers.location!)).text;
  };
  return { agent, post, submit, connect };
}

async function item(message: Parameters<typeof captured>[1] = {}, triage: Record<string, unknown> = {}, words: Record<string, unknown> = {}): Promise<string> {
  const hub = (await listWorkspaces(pool)).find((w) => w.teamId === HUB)!.id;
  model.on('record_triage', triageAnswer(triage)).on('record_recommendation', recommendAnswer(words));
  await receiveCaptured(h.worker, captured(hub, message));
  const [bundle] = await listBundles(pool, { statuses: ['open'] });
  h.queue.jobs = h.queue.jobs.filter((j) => j.name !== 'inbox.bundle');
  await processBundle(h.worker, bundle!.id);
  return bundle!.id;
}

describe('connecting PatchOps for reading', () => {
  it('asks Slack for read scopes only, for the hub workspace', () => {
    const real = createSlackReaderOAuth({ clientId: '123.456', clientSecret: 'made-up', teamId: HUB });
    const url = new URL(real.authorizeUrl({ state: 'abc', redirectUri: 'https://patcher.test/auth/slack/reader/callback' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('scope')).toBeNull();
    const scopes = url.searchParams.get('user_scope')!.split(',');
    expect(scopes).toEqual([...READER_SCOPES]);
    expect(scopes.every((s) => /:(history|read)$/.test(s))).toBe(true);
    expect(scopes.some((s) => s.includes('write'))).toBe(false);
    expect(url.searchParams.get('team')).toBe(HUB);
    expect(url.toString()).not.toContain('made-up');
    expect(missingHistoryScopes(['channels:history', 'im:history'])).toEqual(['groups:history', 'mpim:history']);
  });

  it('stores the token sealed, checks it, and reads from then on', async () => {
    const { agent, connect } = await signIn(OWNER);
    const before = (await agent.get('/inbox').expect(200)).text;
    expect(before).toContain('Connect PatchOps');
    const page = await connect();
    expect(page).toContain('PatchOps is connected. New messages are read from now on.');

    const [workspace] = await listWorkspaces(pool);
    expect(workspace).toMatchObject({ teamId: HUB, readMode: 'api', enabled: true, status: 'connected', readerUserId: OWNER, hasToken: true });
    const stored = await pool.query<{ user_token_ct: string; token_scopes: string }>('SELECT user_token_ct, token_scopes FROM slack_workspaces');
    expect(stored.rows[0]!.user_token_ct).not.toContain(READER_TOKEN);
    expect(testSecrets().box.open(stored.rows[0]!.user_token_ct)).toBe(READER_TOKEN);
    expect(await auditActions(pool)).toContain('inbox.workspace.connect');
    const audit = await pool.query<{ after: unknown }>(`SELECT after FROM audit_log WHERE action = 'inbox.workspace.connect'`);
    expect(JSON.stringify(audit.rows)).not.toContain(READER_TOKEN);
    expect(page).not.toContain(READER_TOKEN);

    expect(h.queue.of('inbox.workspace.check')).toEqual([{ workspaceId: workspace!.id }]);
    await work(h);
    expect(reader.of('identity')).toHaveLength(1);
    expect((await getWorkspace(pool, workspace!.id))!.domain).toBe('patchops');
    expect(await readerHealth(pool)).toMatchObject({ connected: true, waiting: 0 });
  });

  it('refuses a grant for another workspace, another person, or without history, and gives the token back', async () => {
    const { connect } = await signIn(OWNER);
    oauth.grant = { ...oauth.grant!, teamId: 'T0CLIENT' };
    expect(await connect()).toContain('That authorisation is for another workspace.');
    oauth.grant = { ...oauth.grant, teamId: HUB, userId: APPROVER };
    expect(await connect()).toContain('Slack authorised a different person');
    oauth.grant = { ...oauth.grant, userId: OWNER, scopes: ['channels:read', 'users:read'] };
    expect(await connect()).toContain('Slack did not grant permission to read messages');
    expect(oauth.revoked).toEqual([READER_TOKEN, READER_TOKEN, READER_TOKEN]);
    expect(await listWorkspaces(pool)).toHaveLength(0);
  });

  it('refuses a callback that did not start in this session, and one Slack refused', async () => {
    const { agent, connect } = await signIn(OWNER);
    await agent.get('/inbox/connect').expect(302);
    const forged = await agent.get('/auth/slack/reader/callback').query({ code: 'x', state: 'guessed' }).expect(303);
    expect((await agent.get(forged.headers.location!)).text).toContain('did not start from this session');

    const other = await signIn(OWNER);
    const crossed = await other.agent.get('/auth/slack/reader/callback').query({ code: 'x', state: oauth.lastState }).expect(303);
    expect((await other.agent.get(crossed.headers.location!)).text).toContain('did not start from this session');

    const denied = await agent.get('/auth/slack/reader/callback').query({ error: 'access_denied', state: oauth.lastState }).expect(303);
    expect((await agent.get(denied.headers.location!)).text).toContain('Slack did not grant the authorisation');
    oauth.grant = null;
    expect(await connect()).toContain('Slack did not complete the authorisation');
    expect(await listWorkspaces(pool)).toHaveLength(0);
  });

  it('is for owners only, and says what is missing when it cannot be done', async () => {
    const approver = await signIn(APPROVER);
    await approver.agent.get('/inbox/connect').expect(403);
    await approver.agent.get('/auth/slack/reader/callback').query({ code: 'x', state: 'y' }).expect(403);
    await request(app).get('/auth/slack/reader/callback').query({ code: 'x', state: 'y' }).expect(302).expect('location', '/login');
    expect((await approver.agent.get('/inbox')).text).toContain('An owner connects PatchOps here.');

    deps = webDeps(h, { readerOAuth: oauth, seal: null });
    app = createApp(deps);
    const owner = await signIn(OWNER);
    expect((await owner.agent.get('/inbox')).text).toContain('PatchOps cannot be connected yet');
    const res = await owner.agent.get('/inbox/connect').expect(303);
    expect((await owner.agent.get(res.headers.location!)).text).toContain('TOKEN_PUBLIC_KEY must be set');
  });

  it('catches up from the last event seen when connected again', async () => {
    const hub = await connectHub(pool, { status: 'disconnected' });
    await pool.query(`UPDATE slack_workspaces SET last_event_at = now() - interval '3 hours', user_token_ct = NULL WHERE id = $1`, [hub]);
    const { connect } = await signIn(OWNER);
    expect(await connect()).toContain('PatchOps is connected again.');
    const backfill = await lastBackfill(pool, hub);
    expect(backfill).toMatchObject({ reason: 'reconnect', status: 'running' });
    expect(Math.round((Date.now() - backfill!.since.getTime()) / 3_600_000)).toBe(3);
  });
});

describe('the connection, in the worker', () => {
  let hub: string;
  beforeEach(async () => {
    hub = await connectHub(pool);
  });

  it('disconnects and says so once when the token is for someone else or Slack no longer accepts it', async () => {
    reader.who = { ...reader.who, userId: 'U0SOMEONE' };
    expect(await checkWorkspace(h.worker, hub)).toBe('mismatch');
    let workspace = (await getWorkspace(pool, hub))!;
    expect(workspace).toMatchObject({ status: 'disconnected', hasToken: false, statusDetail: 'The authorisation is for another workspace or person.' });
    const notices = h.slack.of('postMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.channel).toBe('C0ERRORS');
    expect(String(notices[0]!.text)).toContain('Slack reading stopped for PatchOps');

    await pool.query(`UPDATE slack_workspaces SET status = 'connected', user_token_ct = $2 WHERE id = $1`, [hub, testSecrets().seal(READER_TOKEN)]);
    reader.who = { ...reader.who, userId: OWNER };
    reader.fail('token_revoked');
    expect(await checkWorkspace(h.worker, hub)).toBe('failed');
    workspace = (await getWorkspace(pool, hub))!;
    expect(workspace).toMatchObject({ status: 'disconnected', hasToken: false });
    // A disconnected workspace reads nothing, and the screen says how to fix it.
    expect(await receiveCaptured(h.worker, captured(hub))).toBe('disconnected');
    const { agent } = await signIn(OWNER);
    const page = (await agent.get('/inbox')).text;
    expect(page).toContain('Disconnected');
    expect(page).toContain('Slack no longer accepts the authorisation.');
    expect(page).toContain('<a href="/inbox/connect">Connect</a>');
  });

  it('stops reading when Slack says the authorisation was removed', async () => {
    const send = (body: Record<string, unknown>) => {
      const raw = JSON.stringify(body);
      const ts = Math.floor(Date.now() / 1000);
      return request(app).post('/slack/events').set('content-type', 'application/json').set('x-slack-request-timestamp', String(ts)).set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, raw)).send(raw);
    };
    await send({ type: 'event_callback', team_id: HUB, event_id: 'Ev0OTHER', event: { type: 'tokens_revoked', tokens: { oauth: ['U0SOMEONE'], bot: [] } } }).expect(200);
    await work(h);
    expect((await getWorkspace(pool, hub))!.status).toBe('connected');

    await send({ type: 'event_callback', team_id: HUB, event_id: 'Ev0MINE', event: { type: 'tokens_revoked', tokens: { oauth: [OWNER], bot: [] } } }).expect(200);
    await work(h);
    expect(await getWorkspace(pool, hub)).toMatchObject({ status: 'disconnected', hasToken: false, statusDetail: 'The authorisation was removed in Slack.' });
  });

  it('catches up through the same filter and pipeline as events', async () => {
    const root = nowTs(-3000);
    reader.channels = [
      { id: PORTAL_CHANNEL, name: 'project-portal', type: 'channel' },
      { id: GENERAL_CHANNEL, name: 'general', type: 'channel' },
      { id: 'C0INBOX', name: 'ops-inbox', type: 'channel' },
      { id: DM_CHANNEL, name: null, type: 'im' },
    ];
    reader.messages.set(PORTAL_CHANNEL, [
      { ts: nowTs(-100), user: OWNER, text: 'Mine.' },
      { ts: nowTs(-200), user: DANA, text: ASK },
      { ts: nowTs(-300), bot_id: 'B0BOT', text: 'Build passed.' },
      { ts: nowTs(-400), user: SAM, text: 'joined', subtype: 'channel_join' },
      { ts: root, user: SAM, text: 'An older thread.', latest_reply: nowTs(-250) },
      { ts: nowTs(-90000), user: DANA, text: 'Before the gap.' },
    ]);
    reader.threads.set(`${PORTAL_CHANNEL}:${root}`, [
      { ts: root, user: SAM, text: 'An older thread.' },
      { ts: nowTs(-250), user: DANA, text: 'A reply in the thread during the gap.', thread_ts: root },
    ]);
    reader.messages.set(GENERAL_CHANNEL, [{ ts: nowTs(-150), user: SAM, text: 'Lunch?' }]);
    reader.messages.set(DM_CHANNEL, [{ ts: nowTs(-120), user: DANA, text: OUTAGE }]);
    reader.messages.set('C0INBOX', [{ ts: nowTs(-110), user: DANA, text: 'Talking under a Patcher post.' }]);
    await pool.query(`INSERT INTO slack_channel_rules (workspace_id, channel_id, rule) VALUES ($1, $2, 'exclude')`, [hub, GENERAL_CHANNEL]);

    expect(await requestBackfill(h, { workspaceId: hub, since: new Date(Date.now() - 2 * 3_600_000), reason: 'manual', requestedBy: OWNER })).toBe('started');
    expect(await requestBackfill(h, { workspaceId: hub, since: new Date(), reason: 'manual', requestedBy: OWNER })).toBe('running');
    const [job] = h.queue.of('inbox.backfill');
    h.queue.clear();
    expect(await runBackfill(h.worker, job!.backfillId)).toBe('done');

    // The excluded channel and Patcher's own were not even asked for.
    expect(reader.of('history').map((c) => c[0])).toEqual([PORTAL_CHANNEL, DM_CHANNEL]);
    const stored = await pool.query<{ text: string | null; own: boolean; thread_ts: string | null }>('SELECT text, own, thread_ts FROM slack_messages ORDER BY sent_at');
    expect(stored.rows).toEqual([
      { text: 'An older thread.', own: false, thread_ts: null },
      { text: 'A reply in the thread during the gap.', own: false, thread_ts: root },
      { text: ASK, own: false, thread_ts: null },
      { text: OUTAGE, own: false, thread_ts: null },
      { text: null, own: true, thread_ts: null },
    ]);
    expect(await lastBackfill(pool, hub)).toMatchObject({ status: 'done', channels: 2, messages: 5, error: null });
    expect(h.queue.of('inbox.bundle').length).toBeGreaterThanOrEqual(3);

    // Running it again stores nothing twice.
    await pool.query(`UPDATE slack_backfills SET status = 'running'`);
    await runBackfill(h.worker, job!.backfillId);
    expect((await pool.query('SELECT 1 FROM slack_messages')).rowCount).toBe(5);
  });

  it('waits when Slack limits the rate, and stops when the token is gone', async () => {
    reader.channels = [{ id: PORTAL_CHANNEL, name: 'project-portal', type: 'channel' }];
    await requestBackfill(h, { workspaceId: hub, since: new Date(Date.now() - 3_600_000), reason: 'manual', requestedBy: OWNER });
    const [job] = h.queue.of('inbox.backfill');
    h.queue.clear();
    reader.fail('rate_limited', 40);
    expect(await runBackfill(h.worker, job!.backfillId)).toBe('waiting');
    expect(h.queue.jobs[0]).toMatchObject({ name: 'inbox.backfill', options: { startAfter: 40 } });
    reader.fail('invalid_auth');
    expect(await runBackfill(h.worker, job!.backfillId)).toBe('failed');
    expect(await lastBackfill(pool, hub)).toMatchObject({ status: 'failed', error: 'Slack no longer accepts the authorisation.' });
    expect((await getWorkspace(pool, hub))!.status).toBe('disconnected');
    expect(await requestBackfill(h, { workspaceId: hub, since: new Date(), reason: 'manual', requestedBy: OWNER })).toBe('not_connected');
  });

  it('asks for a catch-up at boot only after a real gap, and never further back than the limit', async () => {
    await pool.query(`UPDATE slack_workspaces SET last_event_at = now() - interval '2 minutes'`);
    expect(await backfillAfterGap(h)).toBe(0);
    await pool.query(`UPDATE slack_workspaces SET last_event_at = now() - interval '30 days'`);
    expect(await backfillAfterGap(h)).toBe(1);
    const backfill = await lastBackfill(pool, hub);
    expect(backfill!.reason).toBe('gap');
    expect(Math.round((Date.now() - backfill!.since.getTime()) / 3_600_000)).toBe(72);
    await setSetting(pool, 'inbox.enabled', false, OWNER);
    await pool.query('DELETE FROM slack_backfills');
    expect(await backfillAfterGap(h)).toBe(0);
  });
});

describe('the Slack inbox screen', () => {
  let hub: string;
  beforeEach(async () => {
    hub = await connectHub(pool);
  });

  it('is in the navigation and shows workspaces, items, the triage log and what was left out', async () => {
    const id = await item();
    await receiveCaptured(h.worker, captured(hub, { origin: 'bot' }));
    model.on('record_triage', triageAnswer({ label: 'none', quote: '', reason: 'People thanking each other.' }));
    await receiveCaptured(h.worker, captured(hub, { text: 'Thanks all!', channelId: GENERAL_CHANNEL }));
    await work(h);

    const { agent } = await signIn(VIEWER);
    const page = (await agent.get('/inbox').expect(200)).text;
    expect(page).toContain('<a href="/inbox" class="active">Slack inbox</a>');
    expect(page).toContain('<strong>PatchOps</strong>');
    expect(page).toContain('patchops.slack.com · Through the app');
    expect(page).toContain(`<a href="/inbox/items/${id}">Dana asks whether the invoice export goes live on Friday</a>`);
    expect(page).toContain('Waiting for the digest');
    expect(page).toContain('People thanking each other');
    expect(page).toContain('Posted by a bot or an integration');
    // A viewer sees it all and can change nothing. The text of a message is on no screen.
    expect(page).not.toContain(ASK);
    expect(page).not.toContain('Thanks all!');
    expect(page).not.toContain('action="/inbox/workspaces"');
    await request(app).get('/inbox').expect(302);
  });

  it('says so when the reader is off or has no channel', async () => {
    await setSetting(pool, 'inbox.enabled', false, OWNER);
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'inbox'`);
    const { agent } = await signIn(OWNER);
    const page = (await agent.get('/inbox')).text;
    expect(page).toContain('The Slack reader is switched off');
    expect(page).toContain('No channel is set for Slack inbox reports');
  });

  it('shows an item with its draft, and takes a dismissal reason', async () => {
    const id = await item({ text: OUTAGE }, { label: 'escalate', urgency: 'now', quote: OUTAGE }, { summary: 'Portal login is down', quote: OUTAGE });
    await work(h);
    const { agent, submit } = await signIn(APPROVER);
    let page = (await agent.get(`/inbox/items/${id}`).expect(200)).text;
    expect(page).toContain('Portal login is down');
    expect(page).toContain('Draft reply');
    expect(page).toContain('Patcher sends nothing.');
    expect(page).toContain(`href="/approvals/${(await getBundle(pool, id))!.recommendationId}"`);
    expect(page).toContain('Open in Slack');
    expect(page).not.toContain(OUTAGE);

    expect((await submit(`/inbox/items/${id}/reason`, { reason: 'not_relevant' })).page).toContain('Only a dismissed item takes a reason.');
    await pool.query(`UPDATE recommendations SET status = 'dismissed', decided_by = $2 WHERE id = $1`, [(await getBundle(pool, id))!.recommendationId, APPROVER]);
    page = (await submit(`/inbox/items/${id}/reason`, { reason: 'not_relevant' })).page;
    expect(page).toContain('Noted.');
    expect(h.queue.of('recommendation.sync')).toHaveLength(1);
    await agent.get('/inbox/items/not-an-id').expect(404);
    await agent.get('/inbox/items/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('shows a digest with its items, and posts one on request', async () => {
    await item();
    const { agent, submit } = await signIn(APPROVER);
    expect((await submit('/inbox/digest/run')).page).toContain('A digest is being put together.');
    expect(h.queue.of('schedule.run')).toMatchObject([{ key: 'slack.digest', trigger: 'manual' }]);
    h.queue.clear();
    await runDigest(h.worker, 'manual');
    await work(h);
    const [digest] = await listDigests(pool);
    const page = (await agent.get(`/inbox/digests/${digest!.id}`).expect(200)).text;
    expect(page).toContain('1 workspace');
    expect(page).toContain('Dana asks whether the invoice export goes live on Friday');
    expect(page).toContain('Pending');
    expect((await agent.get('/inbox')).text).toContain(`/inbox/digests/${digest!.id}`);
    await agent.get('/inbox/digests/00000000-0000-4000-8000-000000000000').expect(404);
    const viewer = await signIn(VIEWER);
    await viewer.post('/inbox/digest/run').expect(403);
  });

  it('retries a post that failed, from the item page', async () => {
    const id = await item({ text: OUTAGE }, { label: 'escalate', urgency: 'now', quote: OUTAGE }, { quote: OUTAGE });
    h.slack.fail('not_in_channel');
    await work(h);
    const { agent, submit } = await signIn(APPROVER);
    expect((await agent.get(`/inbox/items/${id}`)).text).toContain('Slack refused the post (not_in_channel)');
    expect((await submit(`/inbox/items/${id}/post`)).page).toContain('Posting to Slack.');
    await work(h);
    expect((await getRecommendation(pool, (await getBundle(pool, id))!.recommendationId!))!.status).toBe('posted');
    expect((await submit(`/inbox/items/${id}/post`)).page).toContain('That item is not waiting to be posted.');
  });

  it('switches a workspace off, deletes what was stored for it and gives the token back', async () => {
    const id = await item();
    const rec = (await getBundle(pool, id))!.recommendationId!;
    const { submit, post } = await signIn(OWNER);
    const { page } = await submit(`/inbox/workspaces/${hub}`, { read_dms: '1', channel_default: 'include', project_id: '' });
    expect(page).toContain('Switched off. The messages stored for it are deleted.');
    expect((await pool.query('SELECT 1 FROM slack_messages')).rowCount).toBe(0);
    expect((await getRecommendation(pool, rec))!.status).toBe('expired');
    expect(await getBundle(pool, id)).toMatchObject({ draft: null, quote: null });
    expect(h.queue.of('inbox.workspace.off')).toEqual([{ workspaceId: hub, requestedBy: OWNER }]);

    await work(h);
    expect(reader.revoked).toBe(true);
    expect(await getWorkspace(pool, hub)).toMatchObject({ enabled: false, hasToken: false, status: 'disconnected' });
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['inbox.workspace.update', 'inbox.workspace.forget']));
    // Switching the box back on does not bring reading back: it has to be authorised again.
    await post(`/inbox/workspaces/${hub}`, { enabled: '1', read_dms: '1', channel_default: 'include', project_id: '' }).expect(303);
    expect(await receiveCaptured(h.worker, captured(hub))).toBe('disconnected');
  });

  it('saves the switches and the project of a workspace, for owners only', async () => {
    const { submit } = await signIn(OWNER);
    const { page } = await submit(`/inbox/workspaces/${hub}`, { enabled: '1', channel_default: 'exclude', project_id: projects.acme });
    expect(page).toContain('Saved.');
    expect(await getWorkspace(pool, hub)).toMatchObject({ enabled: true, readDms: false, channelDefault: 'exclude', projectId: projects.acme });
    expect((await submit(`/inbox/workspaces/${hub}`, { enabled: '1', channel_default: 'exclude', project_id: 'nope' })).page).toContain('That project does not exist.');
    expect((await submit('/inbox/workspaces/00000000-0000-4000-8000-000000000000', { enabled: '1' })).page).toContain('That workspace does not exist.');
    const approver = await signIn(APPROVER);
    await approver.post(`/inbox/workspaces/${hub}`, { enabled: '1' }).expect(403);
  });

  it('adds a workspace read from email, switched off', async () => {
    const { submit } = await signIn(OWNER);
    expect((await submit('/inbox/workspaces', { domain: 'https://Acme-Co.slack.com/', name: 'Acme' })).page).toContain('Added, switched off.');
    const added = (await listWorkspaces(pool)).find((w) => w.domain === 'acme-co');
    expect(added).toMatchObject({ name: 'Acme', enabled: false, readMode: 'email_only' });
    expect((await submit('/inbox/workspaces', { domain: 'acme-co', name: '' })).page).toContain('That workspace is already listed.');
    expect((await submit('/inbox/workspaces', { domain: 'not a domain', name: '' })).page).toContain('Write the workspace address');
  });

  it('saves, replaces and removes channel rules, and offers the suggested one', async () => {
    const { agent, submit } = await signIn(OWNER);
    expect((await submit('/inbox/rules', { workspace_id: hub, channel: GENERAL_CHANNEL, rule: 'exclude', project_id: '' })).page).toContain('Rule saved.');
    await submit('/inbox/rules', { workspace_id: hub, channel: GENERAL_CHANNEL, rule: 'digest_only', project_id: '' });
    await submit('/inbox/rules', { workspace_id: hub, channel: '#Project-Portal', rule: 'urgent', project_id: projects.acme });
    const rules = await listRules(pool, hub);
    expect(rules.map((r) => [r.channelId, r.channelName, r.rule, r.projectId]).sort()).toEqual(
      [
        [GENERAL_CHANNEL, null, 'digest_only', null],
        [null, 'project-portal', 'urgent', projects.acme],
      ].sort(),
    );
    expect((await submit('/inbox/rules', { workspace_id: hub, channel: '', rule: 'exclude' })).page).toContain('Name a channel');
    expect((await submit('/inbox/rules', { workspace_id: hub, channel: 'general', rule: 'loud' })).page).toContain('Choose a rule.');
    expect((await submit('/inbox/rules', { workspace_id: 'x', channel: 'general', rule: 'exclude' })).page).toContain('Choose a workspace.');

    const page = (await agent.get('/inbox')).text;
    expect(page).toContain('Always urgent');
    expect(page).toContain('Acme Portal');
    expect((await submit(`/inbox/rules/${rules[0]!.id}/remove`)).page).toContain('Rule removed.');
    expect(await listRules(pool, hub)).toHaveLength(1);

    for (let i = 0; i < 3; i += 1) {
      const id = await item({ channelId: 'C0NOISY', text: `${ASK} (${i})` });
      await pool.query(`INSERT INTO triage_feedback (bundle_id, decision, reason) VALUES ($1, 'dismissed', 'wrong_channel')`, [id]);
    }
    const suggested = (await agent.get('/inbox')).text;
    expect(suggested).toContain('was dismissed as "wrong channel"');
    expect(suggested).toContain('name="channel" value="C0NOISY"');
  });

  it('asks for a catch-up within the limit', async () => {
    const { submit } = await signIn(OWNER);
    expect((await submit(`/inbox/workspaces/${hub}/backfill`, { hours: '6' })).page).toContain('Catching up on the last 6 hours.');
    expect(h.queue.of('inbox.backfill')).toHaveLength(1);
    expect((await submit(`/inbox/workspaces/${hub}/backfill`, { hours: '6' })).page).toContain('A catch-up is already running');
    expect((await submit(`/inbox/workspaces/${hub}/backfill`, { hours: '500' })).page).toContain('Choose between 1 and 72 hours.');
  });

  it('shows the forwarding address once, keeps only its hash, and logs mail without its content', async () => {
    const { agent, post, submit } = await signIn(OWNER);
    expect((await agent.get('/inbox')).text).toContain('save the inbound address of the mail service');
    expect((await submit('/inbox/email/alias')).page).toContain('Save the inbound address of the mail service in Settings first.');
    await setSetting(pool, 'inbox.email_address', 'abc123@inbound.example.com', OWNER);

    const issued = await post('/inbox/email/alias').expect(200);
    expect(issued.headers['cache-control']).toBe('no-store');
    const address = /Forward to <code>([^<]+)<\/code>/.exec(issued.text)![1]!;
    expect(address).toMatch(/^abc123\+[0-9a-f]{32}@inbound\.example\.com$/);
    const token = address.slice(7, 39);
    const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM inbound_aliases');
    expect(stored.rows[0]!.token_hash).not.toBe(token);
    expect(JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows)).not.toContain(token);
    const again = (await agent.get('/inbox')).text;
    expect(again).not.toContain(token);
    expect(again).toContain('A forwarding address is in use.');

    await mailWorkspace(pool, 'acme-co', 'Acme');
    const basic = `Basic ${Buffer.from(`x:${MAIL_SECRET}`).toString('base64')}`;
    await request(app).post('/ingest/email').set('authorization', basic).send(notificationMail(token)).expect(200);
    await request(app).post('/ingest/email').set('authorization', basic).send(notificationMail(token, { From: 'noreply@mail.example', FromFull: { Email: 'noreply@mail.example' }, Subject: 'Confirmation code 424242' })).expect(200);
    const page = (await agent.get('/inbox')).text;
    expect(page).toContain('notification@slack.com');
    expect(page).toContain('Confirmation code 424242');
    expect(page).toContain('Not from Slack, not read');
    expect(page).not.toContain(ASK);
    expect(page).not.toContain('New message from Dana Reyes');
  });

  it('lists tasks that belong to no project and marks them done', async () => {
    await pool.query(`INSERT INTO project_tasks (project_id, kind, title, body) VALUES (NULL, 'task', 'Send the signed contract', 'From a direct message.')`);
    const { agent, submit } = await signIn(APPROVER);
    expect((await agent.get('/inbox')).text).toContain('Send the signed contract');
    const id = (await pool.query<{ id: string }>('SELECT id FROM project_tasks')).rows[0]!.id;
    expect((await submit(`/inbox/tasks/${id}/done`, { done: '1' })).page).toContain('<s>Send the signed contract</s>');
    expect((await submit(`/inbox/tasks/${id}/done`, { done: '1' })).page).toContain('Nothing changed.');
    expect(await auditActions(pool)).toContain('inbox.task.done');
  });
});

describe('settings and health', () => {
  it('saves the inbox settings all or nothing, for owners only', async () => {
    const { agent, submit } = await signIn(OWNER);
    const page = (await agent.get('/settings').expect(200)).text;
    expect(page).toContain('id="inbox"');
    expect(page).toContain('Slack inbox');
    expect(page).toContain('slack.digest');
    const fields = {
      'inbox.enabled': '1',
      'ai.inbox.enabled': '1',
      'inbox.settle_seconds': '60',
      'inbox.quiet_hours': '20:00-06:30',
      'inbox.quiet_tz': 'Europe/Berlin',
      'inbox.unanalysed_after_minutes': '15',
      'inbox.retention_days': '7',
      'ai.inbox.model_triage': 'claude-haiku-4-5',
      'ai.inbox.model_recommend': 'claude-sonnet-4-5',
      'ai.inbox.daily_budget_usd': '2.5',
      'ai.inbox.monthly_budget_usd': '40',
      'inbox.email_address': 'ABC123@inbound.example.com',
      'inbox.email_senders': '@slack.com',
    };
    expect((await submit('/settings/inbox', fields)).page).toContain('Saved.');
    expect(await getAllSettings(pool)).toMatchObject({
      'inbox.enabled': true,
      'inbox.digest_only': false,
      'inbox.agent_enabled': false,
      'inbox.settle_seconds': 60,
      'inbox.quiet_hours': '20:00-06:30',
      'inbox.quiet_tz': 'Europe/Berlin',
      'inbox.retention_days': 7,
      'ai.inbox.daily_budget_usd': 2.5,
      'inbox.email_address': 'abc123@inbound.example.com',
      'inbox.email_senders': '@slack.com',
    });

    const bad = await submit('/settings/inbox', { ...fields, 'inbox.settle_seconds': '90', 'inbox.quiet_hours': 'evenings', 'inbox.retention_days': '400' });
    expect(bad.page).toContain('Not saved.');
    expect((await getAllSettings(pool))['inbox.settle_seconds']).toBe(60);
    expect((await submit('/settings/inbox', { ...fields, 'inbox.email_address': 'me+tag@inbound.example.com' })).page).toContain('Not saved.');
    expect((await submit('/settings/inbox', { ...fields, 'inbox.quiet_tz': 'Mars/Olympus' })).page).toContain('Unknown time zone');

    const approver = await signIn(APPROVER);
    await approver.post('/settings/inbox', fields).expect(403);
    await addUser(pool, VIEWER, 'viewer');
    expect((await (await signIn(VIEWER)).agent.get('/settings')).text).toContain('id="inbox"');
  });

  it('posts what waited for a channel once one is set', async () => {
    await connectHub(pool);
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'inbox'`);
    const id = await item({ text: OUTAGE }, { label: 'escalate', urgency: 'now', quote: OUTAGE }, { quote: OUTAGE });
    await work(h);
    expect((await getBundle(pool, id))!.postError).toContain('no channel is set');
    await pool.query(`INSERT INTO slack_channels (team_id, channel_id, name, is_private, is_member) VALUES ($1, 'C0INBOX', 'ops-inbox', false, true)`, [HUB]).catch(() => undefined);
    const { post } = await signIn(OWNER);
    await post('/settings/routes/inbox', { channel_id: 'C0INBOX' }).expect(303);
    expect(h.queue.of('inbox.post')).toEqual([{ bundleId: id }]);
  });

  it('reports the reader on /health with times and counts only', async () => {
    await connectHub(pool);
    await item();
    const res = await request(app).get('/health').expect(200);
    const body = res.body as { features: Record<string, boolean>; slackReader: Record<string, unknown> };
    expect(body.slackReader).toMatchObject({ enabled: true, connected: true, waiting: 0, lastMailAt: null });
    expect(typeof body.slackReader.lastMessageAt).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain(READER_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain('Dana');
  });
});
