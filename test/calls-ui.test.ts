import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { analyzeCall, suggestForCall } from '../src/calls/analyze.js';
import { listConnections, removeConnection, setupConnection } from '../src/calls/connections.js';
import { postCall } from '../src/calls/delivery.js';
import { ingestTranscript } from '../src/calls/ingest.js';
import { carriedRecommendations, getCall, listMatches, listProjectTasks, listTranscripts } from '../src/calls/store.js';
import { recordConfigured } from '../src/integrations/status.js';
import { decide } from '../src/recommendations/service.js';
import { executeAction } from '../src/recommendations/executor.js';
import { getProject } from '../src/registry/registry.js';
import { getAllSettings, setSetting } from '../src/settings/settings.js';
import { createApp } from '../src/web/app.js';
import { FakeSource, PORTAL_REPO, QUOTES, briefAnswer, matchAnswer, people, seedRegistry, suggestionsAnswer, testSecrets, transcript } from './fixtures/calls.js';
import { FakeCursor } from './fixtures/cursor.js';
import { FakeModel } from './fixtures/model.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, VIEWER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The control UI for calls: the list, a call's page, corrections, the paste upload, the
 * sources and settings, and what approved tasks leave on a project. Calendly, Fathom, the
 * model, Slack and Cursor are stand-ins.
 */
const pool = testPool();
const secrets = testSecrets();
const LATER = () => new Date(Date.now() + 5 * 3600_000);
const MADE_UP_KEY = 'made-up-fathom-key-for-tests';

let h: Harness;
let model: FakeModel;
let fathom: FakeSource;
let calendly: FakeSource;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;
let ids: { acme: string; globex: string };

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'calls', 'C0CALLS');
  await setSetting(pool, 'calls.internal_domains', 'agency.example', OWNER);
  ids = await seedRegistry(pool, OWNER);
  model = new FakeModel();
  fathom = new FakeSource('fathom');
  calendly = new FakeSource('calendly');
  const integrations = testIntegrations({ model, cursor: new FakeCursor(), transcripts: { calendly, fathom } });
  await recordConfigured(pool, integrations.status);
  h = harness(pool, { integrations, secrets: secrets.box, appBaseUrl: 'https://patcher.example' });
  deps = webDeps(h, { seal: secrets.seal });
  app = createApp(deps);
});
afterAll(() => pool.end());

const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)![1]!;

async function signIn(userId: string, on = app, using = deps) {
  using.oidc.identity = { teamId: HUB, userId, name: null, email: null };
  const agent = request.agent(on);
  await agent.get('/auth/slack');
  await agent.get('/auth/slack/callback').query({ code: 'c', state: using.oidc.lastState }).expect(302);
  const csrf = csrfOf((await agent.get('/settings').expect(200)).text);
  const post = (path: string, fields: Record<string, string | string[]> = {}) => agent.post(path).type('form').send({ _csrf: csrf, ...fields });
  /** Posts, follows the redirect and returns the page, which shows the outcome message. */
  const submit = async (path: string, fields: Record<string, string | string[]> = {}) => {
    const res = await post(path, fields).expect(303);
    const location = res.headers.location!;
    return { location, page: (await agent.get(location.split('#')[0]!)).text };
  };
  return { agent, post, submit };
}

async function received(overrides = {}): Promise<string> {
  const result = await ingestTranscript(h, transcript(overrides), null);
  return (result as { callId: string }).callId;
}

/** A matched call with posted suggestions. */
async function analysed(): Promise<string> {
  const callId = await received({ url: 'https://fathom.example/calls/made-up-1' });
  model.on('record_call_match', matchAnswer()).on('record_suggestions', suggestionsAnswer()).on('record_call_brief', briefAnswer());
  await analyzeCall(h.worker, callId, LATER());
  await suggestForCall(h.worker, callId);
  await postCall(h.worker, callId);
  h.queue.clear();
  return callId;
}

async function unsure(): Promise<string> {
  const callId = await received({ externalId: 'rec-intro', title: 'Intro chat', startedAt: new Date('2026-11-10T09:00:00Z'), attendees: [people.host, people.kit],
    text: 'Morgan Host: Thanks for the intro, tell me what you are after.\nKit Stranger: Mostly this: can we get a CSV export on the reports page? We are not sure which system it is in.',
  });
  model.on('record_call_match', { summary: 'A first talk.', matches: [{ project: 'P1', confidence: 0.6, quote: QUOTES.csv }] });
  await analyzeCall(h.worker, callId, LATER());
  h.queue.clear();
  return callId;
}

describe('the calls list', () => {
  it('is in the navigation and says what to do when nothing is connected', async () => {
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get('/calls').expect(200)).text;
    expect(page).toContain('<a href="/calls"');
    expect(page).toContain('No call source is connected.');
    expect(page).toContain('None.');
    // Adding a transcript is for approvers.
    expect(page).not.toContain('Add a transcript');
    await agent.get('/calls/upload').expect(403);
  });

  it('lists calls with their project, status and suggestions, and filters them', async () => {
    const matched = await analysed();
    const asking = await unsure();
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get('/calls').expect(200)).text;
    expect(page).toContain(`<a href="/calls/${matched}">Acme weekly sync</a>`);
    expect(page).toContain(`<a href="/calls/${asking}">Intro chat</a>`);
    expect(page).toContain('Acme Portal');
    expect(page).toContain('(3 pending)');
    expect(page).toContain('All (2)');
    expect(page).toContain('Needs answer (1)');

    const needs = (await agent.get('/calls?show=needs_answer').expect(200)).text;
    expect(needs).toContain('Intro chat');
    expect(needs).not.toContain('Acme weekly sync');
    // An unknown filter shows everything rather than failing.
    expect((await agent.get('/calls?show=nonsense').expect(200)).text).toContain('Acme weekly sync');
  });

  it('says so when calls are switched off', async () => {
    await setSetting(pool, 'calls.enabled', false, OWNER);
    const { agent } = await signIn(VIEWER);
    expect((await agent.get('/calls').expect(200)).text).toContain('Calls are switched off');
  });
});

describe('a call\'s page', () => {
  it('shows the match with its evidence, each suggestion with the words from the call, and the transcript', async () => {
    const callId = await analysed();
    const recs = await carriedRecommendations(pool, callId);
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get(`/calls/${callId}`).expect(200)).text;
    expect(page).toContain('Weekly sync on the portal.');
    expect(page).toContain(`<a href="/projects/${ids.acme}">Acme Portal</a>`);
    expect(page).toContain('0.93');
    expect(page).toContain(QUOTES.csv);
    expect(page).toContain('acme.example');
    expect(page).toContain('1. Add CSV export to the reports page');
    expect(page).toContain(`<code>${PORTAL_REPO}</code>`);
    expect(page).toContain(`<a href="/approvals/${recs[0]!.id}">`);
    expect(page).toContain('for awareness, nothing to approve');
    expect(page).toContain('Brief for the agent, as drafted');
    expect(page).toContain('Drafted message');
    expect(page).toContain('Transcript that was analysed');
    expect(page).toContain('Open at source');
    // A viewer reads; the forms that change things are not offered.
    expect(page).not.toContain('Save project');
    expect(page).not.toContain('Analyse again');
    await agent.get('/calls/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('escapes what a call says', async () => {
    const callId = await received({ title: '<script>alert(1)</script> sync', text: 'Morgan Host: <img src=x onerror=alert(1)> shall we look at the portal?\nDana Client: Yes please, can we get a CSV export on the reports page?' });
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get(`/calls/${callId}`).expect(200)).text;
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;script&gt;');
  });

  it('lets an approver set the project of a call that was asked about', async () => {
    const callId = await unsure();
    const { submit, agent } = await signIn(APPROVER);
    const before = (await agent.get(`/calls/${callId}`).expect(200)).text;
    expect(before).toContain('Asked in Slack: which of these?');
    expect(before).toContain('Set the project');
    // Teaching the registry is the owner's, so an approver is not offered it.
    expect(before).not.toContain('Teach the registry');

    const { page } = await submit(`/calls/${callId}/project`, { project_id: ids.globex, save_domain: 'unknown.example', save_alias: 'intro' });
    expect(page).toContain('Moved to Globex Site. Suggestions are being drafted.');
    expect(await getCall(pool, callId)).toMatchObject({ status: 'matched', projectSetBy: APPROVER });
    expect(h.queue.of('calls.suggest')).toEqual([{ callId }]);
    // The fields an approver is not offered do nothing when sent anyway.
    expect((await getProject(pool, ids.globex))!.domains).toEqual(['globex.example']);
    expect(await auditActions(pool)).toContain('call.project.set');
  });

  it('lets an owner correct a match and teach the registry, so the next call matches by itself', async () => {
    const callId = await unsure();
    const { submit, agent } = await signIn(OWNER);
    expect((await agent.get(`/calls/${callId}`).expect(200)).text).toContain('Save <code>unknown.example</code> as an e-mail domain of the project');

    // A domain that is not on this call is not saved, whatever the form sends.
    const { page } = await submit(`/calls/${callId}/project`, { project_id: ids.globex, save_domain: ['unknown.example', 'elsewhere.example'], save_alias: 'the booking site' });
    expect(page).toContain('The project was updated, so similar calls match by themselves.');
    const project = (await getProject(pool, ids.globex))!;
    expect(project.domains).toEqual(['globex.example', 'unknown.example']);
    expect(project.aliases).toEqual(['the booking site']);

    const none = await submit(`/calls/${callId}/project`, { project_id: 'none' });
    expect(none.page).toContain('Marked as belonging to no listed project.');
    expect((await getCall(pool, callId))!.status).toBe('unmatched');
    expect(await listMatches(pool, callId)).toEqual([]);

    expect((await submit(`/calls/${callId}/project`, {})).page).toContain('Choose a project');
    expect((await submit(`/calls/${callId}/project`, { project_id: '00000000-0000-4000-8000-000000000000' })).page).toContain('flash-error');
  });

  it('analyses a call again on request, closing what was waiting', async () => {
    const callId = await analysed();
    const { submit } = await signIn(APPROVER);
    const { page } = await submit(`/calls/${callId}/analyze`);
    expect(page).toContain('Analysing again.');
    expect(await getCall(pool, callId)).toMatchObject({ status: 'received', version: 2 });
    expect((await carriedRecommendations(pool, callId)).filter((r) => r.status === 'posted')).toEqual([]);
    expect(h.queue.of('calls.analyze')).toEqual([{ callId }]);
  });

  it('refuses changes from a viewer', async () => {
    const callId = await analysed();
    const { post } = await signIn(VIEWER);
    await post(`/calls/${callId}/project`, { project_id: ids.globex }).expect(403);
    await post(`/calls/${callId}/analyze`).expect(403);
    await post(`/calls/${callId}/post`).expect(403);
    await post('/calls/upload', { title: 'x', text: 'y' }).expect(403);
    expect((await getCall(pool, callId))!.version).toBe(1);
  });

  it('says why a call has not reached Slack, and posts it on request', async () => {
    const callId = await received();
    model.on('record_call_match', matchAnswer()).on('record_suggestions', suggestionsAnswer()).on('record_call_brief', briefAnswer());
    await analyzeCall(h.worker, callId, LATER());
    await suggestForCall(h.worker, callId);
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'calls'`);
    await postCall(h.worker, callId);
    h.queue.clear();

    const { agent, submit } = await signIn(APPROVER);
    expect((await agent.get(`/calls/${callId}`).expect(200)).text).toContain('Waiting: no channel is set for Calls reports.');
    expect((await submit(`/calls/${callId}/post`)).page).toContain('Posting to Slack.');
    expect(h.queue.of('calls.post')).toEqual([{ callId }]);
  });
});

describe('adding a transcript by hand', () => {
  it('takes a pasted transcript, analyses it like any other call and records who added it', async () => {
    const { submit, agent } = await signIn(APPROVER);
    expect((await agent.get('/calls/upload').expect(200)).text).toContain('Add a transcript');
    const text = '[00:00:05] Morgan Host: Thanks for making time for the portal review.\n[00:01:00] Dana Client: Can the reports page get a CSV export this month?';
    const { location, page } = await submit('/calls/upload', { title: 'Portal review', started_at: '2026-11-10T15:00', text });
    expect(page).toContain('Added. It is matched to a project within a few minutes.');
    const callId = location.split('/').at(-1)!;
    expect(await getCall(pool, callId)).toMatchObject({ title: 'Portal review', status: 'received' });
    expect((await listTranscripts(pool, callId))[0]).toMatchObject({ source: 'upload', hasSpeakers: true, hasTimestamps: true });
    expect(h.queue.of('calls.analyze')).toEqual([{ callId }]);
    expect(await auditActions(pool)).toContain('call.upload');

    expect((await submit('/calls/upload', { title: 'Portal review', started_at: '2026-11-10T15:00', text })).page).toContain('That transcript was already here.');
    expect((await submit('/calls/upload', { title: 'Too short', text: 'Hello.' })).page).toContain('too little text');
    expect((await submit('/calls/upload', { title: 'Bad date', started_at: 'yesterday-ish', text })).page).toContain('not a date');
  });

  it('accepts a long transcript and refuses one beyond the limit', async () => {
    const { post } = await signIn(APPROVER);
    const line = 'Dana Client: We talked through the portal reports and the export for a while longer.\n';
    await post('/calls/upload', { title: 'Long call', text: line.repeat(4000) }).expect(303);
    await post('/calls/upload', { title: 'Far too long', text: line.repeat(40_000) }).expect(413);
  });
});

describe('call sources in Settings', () => {
  it('connects a source: the key is sealed on the way in, never shown, and checked by the worker', async () => {
    const { submit, agent } = await signIn(OWNER);
    const first = (await agent.get('/settings').expect(200)).text;
    expect(first).toContain('No source is connected.');
    expect(first).toContain('Calendly (personal access token)');

    const { page } = await submit('/settings/calls/connections', { source: 'fathom:team', owner: 'Morgan', key: ` ${MADE_UP_KEY}\n`, import_days: '3' });
    expect(page).toContain('Saved. The key is being checked');
    expect(page).toContain('Checking');
    expect(page).not.toContain(MADE_UP_KEY);
    const [connection] = await listConnections(pool);
    expect(connection).toMatchObject({ source: 'fathom', scope: 'team', owner: 'Morgan', status: 'pending', hasKey: true });
    // What is stored can be opened only with the worker's private key.
    const stored = JSON.stringify((await pool.query('SELECT * FROM transcript_connections')).rows);
    expect(stored).not.toContain(MADE_UP_KEY);
    expect(JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows)).not.toContain(MADE_UP_KEY);
    expect(h.queue.of('calls.connection.setup')).toEqual([{ connectionId: connection!.id }]);

    expect(await setupConnection(h.worker, connection!.id)).toBe('connected');
    expect(fathom.keys).toContain(MADE_UP_KEY);
    const after = (await agent.get('/settings').expect(200)).text;
    expect(after).toContain('Connected');
    expect(after).toContain('Registered');
    expect(after).toContain('team key');
    expect(after).not.toContain(MADE_UP_KEY);
    expect(after).not.toContain(fathom.webhooks[0]!.url.split('/').at(-1));
    expect(await auditActions(pool)).toContain('calls.connection.add');
  });

  it('shows a refused key with a way to check it again, and removes a source', async () => {
    const { submit } = await signIn(OWNER);
    fathom.rejectKey();
    await submit('/settings/calls/connections', { source: 'fathom:personal', owner: 'Riley', key: MADE_UP_KEY });
    const [connection] = await listConnections(pool);
    await setupConnection(h.worker, connection!.id);
    h.queue.clear();

    fathom.keyError = undefined;
    const retry = await submit(`/settings/calls/connections/${connection!.id}/retry`);
    expect(retry.page).toContain('Checking the key again.');
    expect(h.queue.of('calls.connection.setup')).toEqual([{ connectionId: connection!.id }]);
    expect(await setupConnection(h.worker, connection!.id)).toBe('connected');

    const removed = await submit(`/settings/calls/connections/${connection!.id}/remove`);
    expect(removed.page).toContain('Removing.');
    await removeConnection(h.worker, connection!.id, OWNER);
    expect(await listConnections(pool)).toEqual([]);
    expect(fathom.deleted).toEqual([fathom.webhooks[0]!.ref]);
  });

  it('refuses what cannot be a key, a second Calendly connection, and anyone but an owner', async () => {
    const owner = await signIn(OWNER);
    expect((await owner.submit('/settings/calls/connections', { source: 'fathom:team', owner: 'Morgan', key: 'short' })).page).toContain('That does not look like a token or an API key.');
    await owner.submit('/settings/calls/connections', { source: 'calendly', owner: 'Agency', key: 'made-up-calendly-token' });
    expect((await owner.submit('/settings/calls/connections', { source: 'calendly', owner: 'Agency', key: 'made-up-calendly-token-2' })).page).toContain('Not connected.');
    expect((await owner.submit('/settings/calls/connections', { source: 'zoom', owner: 'Agency', key: 'made-up-other-token' })).page).toContain('Not connected.');
    expect(await listConnections(pool)).toHaveLength(1);

    const approver = await signIn(APPROVER);
    await approver.post('/settings/calls/connections', { source: 'fathom:team', owner: 'Morgan', key: MADE_UP_KEY }).expect(403);
    await approver.post('/settings/calls', { 'calls.enabled': '1' }).expect(403);
    const page = (await approver.agent.get('/settings').expect(200)).text;
    expect(page).toContain('id="calls"');
    expect(page).not.toContain('name="key"');
  });

  it('says what is missing when the web service cannot seal a key, and stores nothing', async () => {
    const unsealed = webDeps(h, { seal: null });
    const { submit, agent } = await signIn(OWNER, createApp(unsealed), unsealed);
    expect((await agent.get('/settings').expect(200)).text).toContain('<code>TOKEN_PUBLIC_KEY</code> is not set on the web service');
    expect((await submit('/settings/calls/connections', { source: 'fathom:team', owner: 'Morgan', key: MADE_UP_KEY })).page).toContain('A key cannot be stored yet');
    expect(await listConnections(pool)).toEqual([]);
  });

  it('saves the call settings, validated, with an audit entry', async () => {
    const { submit } = await signIn(OWNER);
    const fields = {
      'calls.enabled': '1',
      'ai.calls.enabled': '1',
      'calls.settle_minutes': '10',
      'calls.preferred_copy': 'fathom',
      'calls.retention_days': '30',
      'calls.internal_domains': 'agency.example, studio.example',
      'ai.calls.auto_match_confidence': '0.9',
      'ai.calls.ask_confidence': '0.6',
      'ai.calls.max_suggestions': '3',
      'ai.calls.daily_budget_usd': '2.5',
    };
    expect((await submit('/settings/calls', fields)).page).toContain('Saved.');
    expect(await getAllSettings(pool)).toMatchObject({
      'calls.enabled': true,
      'calls.settle_minutes': 10,
      'calls.preferred_copy': 'fathom',
      'calls.retention_days': 30,
      'calls.internal_domains': 'agency.example, studio.example',
      'ai.calls.auto_match_confidence': 0.9,
      'ai.calls.ask_confidence': 0.6,
      'ai.calls.max_suggestions': 3,
      'ai.calls.daily_budget_usd': 2.5,
    });
    expect(await auditActions(pool)).toContain('setting.update');

    // Unticked switches are off; the thresholds cannot cross; a number out of range is refused.
    const { 'calls.enabled': _on, ...withoutSwitch } = fields;
    await submit('/settings/calls', withoutSwitch);
    expect((await getAllSettings(pool))['calls.enabled']).toBe(false);
    expect((await submit('/settings/calls', { ...fields, 'ai.calls.ask_confidence': '0.95' })).page).toContain('cannot be above');
    expect((await submit('/settings/calls', { ...fields, 'ai.calls.max_suggestions': '9' })).page).toContain('Not saved.');
    expect((await getAllSettings(pool))['ai.calls.max_suggestions']).toBe(3);
  });

  it('routes calls to a channel on the same screen as the other reports', async () => {
    const { agent } = await signIn(OWNER);
    const page = (await agent.get('/settings').expect(200)).text;
    expect(page).toMatch(/Calls[\s\S]*C0CALLS/);
  });
});

describe('what approved suggestions leave on the project', () => {
  it('lists tasks and follow-ups on the project page and lets an approver tick them off', async () => {
    const callId = await analysed();
    const recs = await carriedRecommendations(pool, callId);
    const followup = recs[2]!;
    await decide(h, { id: followup.id, hash: followup.actionHash, actor: APPROVER, via: 'ui', decision: 'approve' });
    for (const job of h.queue.of('action.execute')) await executeAction(h.worker, job.actionId);

    const { agent, submit } = await signIn(APPROVER);
    const page = (await agent.get(`/projects/${ids.acme}`).expect(200)).text;
    expect(page).toContain('Tasks and follow-ups from calls');
    expect(page).toContain('Send Dana the staging link');
    expect(page).toContain('Follow-up to send');
    expect(page).toContain(`<a href="/calls/${callId}">The call</a>`);
    expect(page).toContain('Mark sent');

    const [task] = await listProjectTasks(pool, ids.acme);
    expect((await submit(`/projects/${ids.acme}/tasks/${task!.id}/done`)).page).toContain('Marked done.');
    expect((await listProjectTasks(pool, ids.acme))[0]).toMatchObject({ status: 'done', doneBy: APPROVER });
    expect((await submit(`/projects/${ids.acme}/tasks/${task!.id}/reopen`)).page).toContain('Reopened.');
    // A task is ticked off on its own project only.
    expect((await submit(`/projects/${ids.globex}/tasks/${task!.id}/done`)).page).toContain('Nothing changed.');

    const viewer = await signIn(VIEWER);
    await viewer.post(`/projects/${ids.acme}/tasks/${task!.id}/done`).expect(403);
    expect((await viewer.agent.get(`/projects/${ids.acme}`).expect(200)).text).not.toContain('Mark sent');
  });
});
