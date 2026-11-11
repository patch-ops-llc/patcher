import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../src/audit/auditLog.js';
import { recordConfigured } from '../src/integrations/status.js';
import { syncInventory } from '../src/railway/inventory.js';
import { postRecommendation, syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { getRecommendation, listRecommendations } from '../src/recommendations/service.js';
import { RegistryError, addCheck, addLink, createProject, getProject, importRailwayProjects, linkedRepos, listProjects, normalizeRepo, projectForRepo } from '../src/registry/registry.js';
import { setSetting } from '../src/settings/settings.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { proposeFixFor } from '../src/weekly/analyze.js';
import { getAuditRun, postAuditReport } from '../src/weekly/delivery.js';
import { getFinding } from '../src/weekly/findings.js';
import { runAudit } from '../src/weekly/run.js';
import { createApp } from '../src/web/app.js';
import { FakeCursor } from './fixtures/cursor.js';
import { ACME_REPO, GLOBEX_REPO, NOW, fakeRailway, service, workspace } from './fixtures/railway.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, SIGNING_SECRET, VIEWER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

const pool = testPool();
const CHANNEL = 'C0AUDIT';
// Railway ids are UUIDs; the registry links a Railway project by its id.
const RW_ACME = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const RW_GLOBEX = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let h: Harness;
let cursor: FakeCursor;
let app: ReturnType<typeof createApp>;
let deps: ReturnType<typeof webDeps>;

/** A workspace with one crashing service, so the audit has a fixable finding to report. */
function crashingRailway() {
  return fakeRailway({
    projectEvents: (v) => ({
      events: {
        edges:
          v.projectId === 'p-acme'
            ? [1, 2, 3, 4].map((hours) => ({
                node: { object: 'Deployment', action: 'crashed', severity: 'CRITICAL', createdAt: new Date(NOW.getTime() - hours * 3600_000).toISOString(), environmentId: 'e-acme-prod', payload: { serviceId: 's-api' } },
              }))
            : [],
        pageInfo: { hasNextPage: false },
      },
    }),
  });
}

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'audit', CHANNEL);
  cursor = new FakeCursor();
  const integrations = testIntegrations({ railway: crashingRailway(), cursor });
  // The worker records what is configured at boot; the public service only reads it.
  await recordConfigured(pool, integrations.status);
  h = harness(pool, { integrations });
  deps = webDeps(h);
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
  const post = (path: string, fields: Record<string, string | string[]> = {}) =>
    agent.post(path).type('form').send({ _csrf: csrf, ...fields });
  /** Posts, follows the redirect and returns the page, which shows the outcome message. */
  const submit = async (path: string, fields: Record<string, string | string[]> = {}) => {
    const res = await post(path, fields).expect(303);
    const location = res.headers.location!;
    return { location, page: (await agent.get(location.split('#')[0]!)).text };
  };
  return { agent, post, submit };
}

function slackPost(path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  return request(app)
    .post(path)
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', String(ts))
    .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, body))
    .send(body);
}

const command = (text: string, userId = APPROVER) =>
  slackPost('/slack/commands', new URLSearchParams({ command: '/ops', text, user_id: userId, team_id: HUB }).toString());

async function audited() {
  const projectId = await createProject(pool, { name: 'Acme Portal' }, OWNER);
  await addLink(pool, projectId, 'repo', ACME_REPO, OWNER);
  const { runId } = await runAudit(h.worker, 'schedule', 'system', NOW);
  expect(await postAuditReport(h.worker, runId!)).toBe('posted');
  const run = (await getAuditRun(pool, runId!))!;
  h.queue.clear();
  return { run, projectId, top: run.report!.top };
}

describe('phase 1 milestone: the report in Slack, a fix approved there, an agent started', () => {
  it('approves "Fix 1 via agent" from the report message and starts one agent on the linked repository', async () => {
    const { run } = await audited();
    const message = h.slack.of('postMessage')[0]!;
    const button = (message.blocks as { elements?: { action_id: string; value?: string }[] }[])[1]!.elements![0]!;
    expect(button.action_id).toBe('rec_approve:1');

    const payload = {
      type: 'block_actions',
      team: { id: HUB },
      user: { id: APPROVER, team_id: HUB, name: 'april' },
      trigger_id: 't',
      response_url: 'https://hooks.slack.com/actions/T0HUB/1/abc',
      actions: [{ action_id: button.action_id, value: button.value }],
    };
    await slackPost('/slack/interactions', new URLSearchParams({ payload: JSON.stringify(payload) }).toString()).expect(200);

    const [rec] = await listRecommendations(pool, ['approved'], 10);
    expect(rec).toMatchObject({ kind: 'audit_fix', carrierId: run.id });
    for (const job of h.queue.of('action.execute')) expect(await executeAction(h.worker, job.actionId)).toBe('done');
    for (const job of h.queue.of('recommendation.sync')) await syncMessage(h.worker, job.recommendationId);

    expect(cursor.started.map((s) => s.repo)).toEqual([ACME_REPO]);
    expect((await getRecommendation(pool, rec!.id))!.status).toBe('done');
    const log = await listAudit(pool, 50);
    expect(log.find((e) => e.action === 'recommendation.approve')).toMatchObject({ actor: APPROVER, target: rec!.id });
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['audit.report.post', 'recommendation.approve', 'action.done']));

    // A second click on the old button changes nothing: the recommendation is no longer waiting.
    await slackPost('/slack/interactions', new URLSearchParams({ payload: JSON.stringify(payload) }).toString()).expect(200);
    expect(cursor.started).toHaveLength(1);
  });

  it('refuses a viewer who clicks the fix button', async () => {
    await audited();
    const button = (h.slack.of('postMessage')[0]!.blocks as { elements?: { action_id: string; value?: string }[] }[])[1]!.elements![0]!;
    const payload = {
      type: 'block_actions',
      team: { id: HUB },
      user: { id: VIEWER, team_id: HUB, name: 'vic' },
      trigger_id: 't',
      response_url: 'https://hooks.slack.com/actions/T0HUB/1/abc',
      actions: [{ action_id: button.action_id, value: button.value }],
    };
    await slackPost('/slack/interactions', new URLSearchParams({ payload: JSON.stringify(payload) }).toString()).expect(200);
    expect(await listRecommendations(pool, ['approved'], 10)).toEqual([]);
    expect(h.queue.of('action.execute')).toEqual([]);
  });
});

describe('Audits in the control UI', () => {
  it('shows the report, its findings and what could not be checked', async () => {
    const { run, top } = await audited();
    const viewer = await signIn(VIEWER);

    const list = (await viewer.agent.get('/audits').expect(200)).text;
    expect(list).toContain('crashed 4 times in the last 7 days');
    expect(list).toContain(`/audits/${run.id}`);
    expect(list).toContain('disabled>Run audit now</button>');

    const report = (await viewer.agent.get(`/audits/${run.id}`).expect(200)).text;
    expect(report).toContain('2 projects · 4 services · <strong>1 critical · 0 warnings · 3 healthy</strong>');
    expect(report).toContain('What was checked');
    expect(report).toContain('the GitHub App is not configured');

    const finding = (await viewer.agent.get(`/audits/findings/${top[0]!.findingId}`).expect(200)).text;
    expect(finding).toContain('Acme Portal');
    expect(finding).toContain('crashed 4 times in the last 7 days');
    expect(finding).toContain('Evidence');

    await viewer.agent.get('/audits/00000000-0000-4000-8000-000000000000').expect(404);
    await viewer.agent.get('/audits/findings/not-a-uuid').expect(404);
  });

  it('lets an approver start an audit, and refuses a viewer, a pause and a missing token', async () => {
    const viewer = await signIn(VIEWER);
    await viewer.post('/audits/run').expect(403);
    await request(app).post('/audits/run').type('form').send({}).expect(401);

    const approver = await signIn(APPROVER);
    expect((await approver.submit('/audits/run')).page).toContain('Audit started.');
    expect(h.queue.of('audit.run')).toEqual([{ trigger: 'manual', requestedBy: APPROVER }]);
    expect(await auditActions(pool)).toContain('audit.run_now');

    await setSetting(pool, 'paused', true, OWNER);
    expect((await approver.submit('/audits/run')).page).toContain('Patcher is paused, so no audit was started.');
    await setSetting(pool, 'paused', false, OWNER);

    await recordConfigured(pool, testIntegrations().status);
    expect((await approver.submit('/audits/run')).page).toContain('Railway is not configured: RAILWAY_API_TOKEN is not set on the worker.');
    expect(h.queue.of('audit.run')).toHaveLength(1);
  });

  it('refuses a form without the CSRF token', async () => {
    const approver = await signIn(APPROVER);
    await approver.agent.post('/audits/run').type('form').send({}).expect(403);
    expect(h.queue.of('audit.run')).toEqual([]);
  });

  it('starts an audit from /ops audit now for an approver only', async () => {
    expect((await command('audit')).body.text).toBe('<http://patcher.test/audits|Open the latest audit> · `/ops audit now` starts one');
    expect((await command('audit now', VIEWER)).body.text).toBe('Only an approver or owner can start an audit.');
    expect((await command('audit now')).body.text).toBe('Audit started. The report is posted when it finishes, in a few minutes.');
    expect(h.queue.of('audit.run')).toEqual([{ trigger: 'manual', requestedBy: APPROVER }]);
  });

  it('mutes, accepts and reopens a finding, with who and why', async () => {
    const { top } = await audited();
    const id = top[0]!.findingId;
    const viewer = await signIn(VIEWER);
    await viewer.post(`/audits/findings/${id}/state`, { state: 'muted' }).expect(403);

    const approver = await signIn(APPROVER);
    expect((await approver.submit(`/audits/findings/${id}/state`, { state: 'muted', note: 'Being replaced next month' })).page).toContain('Muted.');
    expect(await getFinding(pool, id)).toMatchObject({ state: 'muted', stateBy: APPROVER, stateNote: 'Being replaced next month' });
    expect((await approver.agent.get('/audits?state=muted')).text).toContain('crashed 4 times');
    expect((await approver.agent.get('/audits')).text).not.toContain('crashed 4 times');

    await approver.submit(`/audits/findings/${id}/state`, { state: 'open' });
    expect(await getFinding(pool, id)).toMatchObject({ state: 'open' });
    expect((await approver.submit(`/audits/findings/${id}/state`, { state: 'resolved' })).page).toContain('Unknown state.');
  });

  it('proposes a fix from a finding, which then goes through the normal approval message', async () => {
    // No Cursor at audit time, so nothing was proposed; it is configured afterwards.
    await recordConfigured(pool, testIntegrations({ railway: crashingRailway() }).status);
    h = harness(pool, { integrations: testIntegrations({ railway: crashingRailway() }) });
    deps = webDeps(h);
    app = createApp(deps);
    const { top } = await audited();
    const id = top[0]!.findingId;
    const approver = await signIn(APPROVER);
    expect((await approver.submit(`/audits/findings/${id}/fix`)).page).toContain('A fix cannot be proposed: Cursor is not configured (CURSOR_API_KEY).');

    await recordConfigured(pool, testIntegrations({ railway: crashingRailway(), cursor }).status);
    // The public service only asks. The worker drafts the brief and the recommendation.
    h.queue.clear();
    expect((await approver.submit(`/audits/findings/${id}/fix`)).page).toContain('The fix is being drafted.');
    expect(h.queue.of('audit.fix.propose')).toEqual([{ findingId: id, requestedBy: APPROVER }]);
    expect((await pool.query('SELECT 1 FROM recommendations')).rowCount).toBe(0);
    const w = harness(pool, { integrations: testIntegrations({ railway: crashingRailway(), cursor }) });
    const recId = (await proposeFixFor(w.worker, id, APPROVER))!.id;
    expect(await getRecommendation(pool, recId)).toMatchObject({ kind: 'audit_fix', status: 'drafted', carrierType: null });
    expect((await listAudit(pool, 50)).find((e) => e.action === 'recommendation.create')).toMatchObject({ actor: APPROVER, target: recId });
    expect(w.queue.of('recommendation.post')).toEqual([{ recommendationId: recId }]);
    expect(await postRecommendation(w.worker, recId)).toBe('posted');
    const message = w.slack.of('postMessage').at(-1)!;
    expect(message.channel).toBe(CHANNEL);
    expect(message.text).toContain('Fix Acme Portal api: crashed 4 times in the last 7 days');
    // Asked twice (a double click, or a retried job), it is still one recommendation.
    expect((await proposeFixFor(w.worker, id, APPROVER))).toBeNull();

    // One open proposal per finding.
    expect((await approver.submit(`/audits/findings/${id}/fix`)).page).toContain('A fix cannot be proposed');
    expect((await pool.query('SELECT 1 FROM recommendations')).rowCount).toBe(1);
  });

  it('posts a held report again on request', async () => {
    await pool.query('DELETE FROM channel_routes');
    const { runId } = await runAudit(h.worker, 'schedule', 'system', NOW);
    expect(await postAuditReport(h.worker, runId!)).toBe('held');
    h.queue.clear();
    const approver = await signIn(APPROVER);
    expect((await approver.agent.get(`/audits/${runId!}`)).text).toContain('Waiting: no channel is set for Audit reports.');
    await approver.post(`/audits/${runId!}/post`).expect(303);
    expect(h.queue.of('audit.report.post')).toEqual([{ runId }]);
  });

  it('reports integrations on /health by name, configured or not, and nothing else', async () => {
    const { body } = await request(app).get('/health').expect(200);
    expect(body.integrations).toEqual({
      railway: { configured: true, lastOkAt: null },
      github: { configured: false, lastOkAt: null },
      cursor: { configured: true, lastOkAt: null },
      anthropic: { configured: false, lastOkAt: null },
    });
  });
});

describe('the project registry', () => {
  async function inventory() {
    await syncInventory(
      pool,
      workspace([
        service({ projectId: RW_ACME, projectName: 'Acme Portal' }),
        service({ projectId: RW_ACME, projectName: 'Acme Portal', serviceId: 's-web', serviceName: 'web', instanceId: 'i-web', repo: 'Example-Org/Acme-Web' }),
        service({ projectId: RW_GLOBEX, projectName: 'Globex Sync', serviceId: 's-sync', serviceName: 'sync', instanceId: 'i-sync', environmentId: 'e-globex', repo: GLOBEX_REPO }),
        service({ projectId: RW_GLOBEX, projectName: 'Globex Sync', serviceId: 's-shared', serviceName: 'shared', instanceId: 'i-shared', environmentId: 'e-globex', repo: ACME_REPO }),
      ]),
      [],
      NOW,
    );
  }

  it('writes a repository one way, whatever was pasted', () => {
    expect(normalizeRepo('Example-Org/Acme-Portal')).toBe(ACME_REPO);
    expect(normalizeRepo(' https://github.com/example-org/acme-portal.git ')).toBe(ACME_REPO);
    expect(normalizeRepo('https://github.com/example-org/acme-portal/')).toBe(ACME_REPO);
    for (const bad of ['acme-portal', 'a/b/c', 'https://gitlab.com/a/b', 'owner/name with space', '']) {
      expect(() => normalizeRepo(bad), bad).toThrow(RegistryError);
    }
  });

  it('links a repository to one project only, and counts it only while the project is active', async () => {
    const acme = await createProject(pool, { name: 'Acme Portal' }, OWNER);
    const globex = await createProject(pool, { name: 'Globex Sync' }, OWNER);
    await addLink(pool, acme, 'repo', 'https://github.com/Example-Org/Acme-Portal', OWNER);
    await addLink(pool, acme, 'repo', ACME_REPO, OWNER);
    expect((await getProject(pool, acme))!.links.map((l) => [l.kind, l.externalId])).toEqual([['repo', ACME_REPO]]);
    await expect(addLink(pool, globex, 'repo', ACME_REPO, OWNER)).rejects.toThrow(`${ACME_REPO} is already linked to another project.`);
    await expect(addLink(pool, globex, 'railway_project', 'p-globex', OWNER)).rejects.toThrow('A Railway project is linked by its id.');
    await expect(createProject(pool, { name: 'acme portal' }, OWNER)).rejects.toThrow('A project with that name already exists.');

    expect(await projectForRepo(pool, 'Example-Org/Acme-Portal')).toEqual({ id: acme, name: 'Acme Portal', description: '' });
    expect(await linkedRepos(pool)).toEqual(new Set([ACME_REPO]));
    await pool.query(`UPDATE projects SET status = 'paused' WHERE id = $1`, [acme]);
    expect(await projectForRepo(pool, ACME_REPO)).toBeNull();
    expect(await linkedRepos(pool)).toEqual(new Set());
  });

  it('accepts only checks a probe may reach', async () => {
    const acme = await createProject(pool, { name: 'Acme Portal' }, OWNER);
    for (const url of ['http://portal.example.test/health', 'https://10.0.0.8/health', 'https://db.railway.internal/', 'https://localhost/x']) {
      await expect(addCheck(pool, acme, { name: 'Bad', url }, OWNER), url).rejects.toThrow(RegistryError);
    }
    await addCheck(pool, acme, { name: 'Order sync', url: 'https://portal.example.test/api/sync-status', expectJson: { ok: true } }, OWNER);
    expect((await getProject(pool, acme))!.checks).toEqual([
      expect.objectContaining({ name: 'Order sync', url: 'https://portal.example.test/api/sync-status', expectStatus: 200, expectJson: { ok: true }, enabled: true }),
    ]);
  });

  it('imports Railway projects with their repositories, once', async () => {
    await inventory();
    expect(await importRailwayProjects(pool, [RW_ACME, RW_GLOBEX, 'cccccccc-3333-4333-8333-cccccccccccc'], OWNER)).toEqual({ created: 2, skipped: [] });
    const projects = await listProjects(pool);
    const links = (name: string) => projects.find((p) => p.name === name)!.links.map((l) => `${l.kind}:${l.externalId}`).sort();
    expect(links('Acme Portal')).toEqual([`railway_project:${RW_ACME}`, 'repo:example-org/acme-portal', 'repo:example-org/acme-web']);
    // A repository two Railway projects deploy from stays with the first that claimed it.
    expect(links('Globex Sync')).toEqual([`railway_project:${RW_GLOBEX}`, `repo:${GLOBEX_REPO}`]);
    expect(await importRailwayProjects(pool, [RW_ACME, RW_GLOBEX], OWNER)).toEqual({ created: 0, skipped: [] });
    expect(await listProjects(pool)).toHaveLength(2);
  });

  it('does not merge an import into a project that only shares the name', async () => {
    await inventory();
    await createProject(pool, { name: 'acme portal' }, OWNER);
    expect(await importRailwayProjects(pool, [RW_ACME], OWNER)).toEqual({ created: 0, skipped: ['Acme Portal'] });
    expect(await linkedRepos(pool)).toEqual(new Set());
  });

  it('is edited by owners only, through the Projects screen', async () => {
    await inventory();
    const approver = await signIn(APPROVER);
    const projectsPage = (await approver.agent.get('/projects').expect(200)).text;
    expect(projectsPage).toContain('Acme Portal');
    await approver.post('/projects', { name: 'Initech' }).expect(403);
    await approver.post('/projects/import', { all: '1' }).expect(403);

    const owner = await signIn(OWNER);
    expect((await owner.submit('/projects/import', { railway_project: [RW_ACME] })).page).toContain('1 imported.');
    expect((await owner.submit('/projects/import')).page).toContain('Nothing was selected.');
    expect((await owner.submit('/projects/import', { all: '1' })).page).toContain('1 imported.');

    const { location, page } = await owner.submit('/projects', { name: 'Initech', client: 'Initech Inc' });
    expect(page).toContain('Project added.');
    const id = location.split('/').pop()!;
    expect((await owner.submit(`/projects/${id}/links`, { kind: 'repo', external_id: 'example-org/initech-api' })).page).toContain('Linked.');
    expect((await owner.submit(`/projects/${id}/links`, { kind: 'repo', external_id: ACME_REPO })).page).toContain(
      `Not saved. ${ACME_REPO} is already linked to another project.`,
    );
    expect((await owner.submit(`/projects/${id}/checks`, { name: 'Health', url: 'http://10.0.0.1/', expect_status: '200' })).page).toContain('Not saved. Only https addresses are probed.');
    expect((await owner.submit(`/projects/${id}/checks`, { name: 'Health', url: 'https://initech.example.test/health', expect_json: '[1]' })).page).toContain(
      'The expected JSON must be an object',
    );
    expect((await owner.submit(`/projects/${id}/checks`, { name: 'Health', url: 'https://initech.example.test/health', expect_json: '{"ok":true}' })).page).toContain('Check added.');

    const project = (await getProject(pool, id))!;
    expect(project).toMatchObject({ name: 'Initech', client: 'Initech Inc', status: 'active' });
    expect(project.checks.map((c) => c.expectJson)).toEqual([{ ok: true }]);

    await owner.submit(`/projects/${id}`, { name: 'Initech', client: 'Initech Inc', status: 'archived', aliases: 'initech, tps', domains: 'initech.example.test' });
    expect(await getProject(pool, id)).toMatchObject({ status: 'archived', aliases: ['initech', 'tps'], domains: ['initech.example.test'] });
    expect(await projectForRepo(pool, 'example-org/initech-api')).toBeNull();

    await owner.submit(`/projects/${id}/links/${project.links[0]!.id}/remove`);
    await owner.submit(`/projects/${id}/checks/${project.checks[0]!.id}/remove`);
    expect(await getProject(pool, id)).toMatchObject({ links: [], checks: [] });
    expect((await owner.submit(`/projects/${id}/delete`)).page).toContain('Project removed.');
    expect(await getProject(pool, id)).toBeNull();
    expect(await auditActions(pool)).toEqual(
      expect.arrayContaining(['project.create', 'project.link', 'project.unlink', 'project.check.add', 'project.check.remove', 'project.update', 'project.delete']),
    );
  });
});
