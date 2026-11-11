import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentIdFor, fixBrief, pollAgentRun } from '../src/fix/agentFix.js';
import { listIntegrations, recordConfigured } from '../src/integrations/status.js';
import type { ReadQueryName } from '../src/railway/queries.js';
import { postRecommendation, syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { runExpiry } from '../src/recommendations/expiry.js';
import { decide, getRecommendation, listRecommendations } from '../src/recommendations/service.js';
import { addLink, createProject, updateProject } from '../src/registry/registry.js';
import { setSetting } from '../src/settings/settings.js';
import { MAX_BUTTONS, MAX_LINES, decodeRef } from '../src/slack/messages.js';
import { AUDIT_CARRIER, getAuditRun, postAuditReport, resumeHeldReports } from '../src/weekly/delivery.js';
import { getFinding, listFindings, setFindingState } from '../src/weekly/findings.js';
import { renderMarkdown } from '../src/weekly/report.js';
import { runAudit } from '../src/weekly/run.js';
import { scheduleHandlers } from '../src/worker/handlers.js';
import { FakeCursor } from './fixtures/cursor.js';
import type { Handler } from './fixtures/railway.js';
import { ACME, ACME_PROD, ACME_REPO, API, DB, GLOBEX_PROD, GLOBEX_REPO, NOW, SYNC, fakeRailway, healthyWorkspace } from './fixtures/railway.js';
import type { Harness } from './helpers.js';
import { APPROVER, OWNER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool } from './helpers.js';

const pool = testPool();
const WEEK = 7 * 24 * 3600 * 1000;
const CHANNEL = 'C0AUDIT';

let cursor: FakeCursor;
let h: Harness;

/** What is wrong in the made-up workspace. Each test switches problems on and off. */
interface Trouble {
  crashes: number;
  configFile: boolean;
  vulnerability: boolean;
  metricsDown: boolean;
  memoryFull: boolean;
}
let trouble: Trouble;

function railway(now: Date) {
  const healthy = healthyWorkspace();
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString();
  const overrides: Partial<Record<ReadQueryName, Handler>> = {
    projectEvents: (v) => ({
      events: {
        edges:
          v.projectId === ACME
            ? [
                ...Array.from({ length: trouble.crashes }, (_, i) => ({
                  node: { object: 'Deployment', action: 'crashed', severity: 'CRITICAL', createdAt: at(i + 1), environmentId: ACME_PROD, payload: { serviceId: API } },
                })),
                ...(trouble.vulnerability
                  ? [{ node: { object: 'PostgresVuln', action: 'triggered', severity: 'WARNING', createdAt: at(400), environmentId: ACME_PROD, payload: { serviceId: DB, cveIds: ['CVE-2099-0001'] } } }]
                  : []),
              ]
            : [],
        pageInfo: { hasNextPage: false },
      },
    }),
    environment: (v) => {
      const data = healthy.environment(v) as { environment: { serviceInstances: { edges: { node: Record<string, unknown> }[] } } | null };
      if (v.id === GLOBEX_PROD && trouble.configFile && data.environment) {
        data.environment.serviceInstances.edges[0]!.node.resolvedFileConfig = { configFile: '/railway.json' };
      }
      return data;
    },
    metrics: (v) => {
      if (trouble.metricsDown) throw new Error('Railway returned HTTP 502');
      const data = healthy.metrics(v) as { metrics: { measurement: string; tags: { serviceId: string }; values: { value: number }[] }[] };
      if (trouble.memoryFull) {
        for (const series of data.metrics) {
          if (series.measurement === 'MEMORY_USAGE_GB' && series.tags.serviceId === SYNC) series.values.forEach((p) => (p.value = 7.8));
        }
      }
      return data;
    },
  };
  return fakeRailway(overrides);
}

function setup(now: Date = NOW, options: { cursor?: boolean } = {}) {
  h = harness(pool, { integrations: testIntegrations({ railway: railway(now), cursor: options.cursor === false ? null : cursor }) });
  return h;
}

async function register(name: string, repo: string): Promise<string> {
  const id = await createProject(pool, { name }, OWNER);
  await addLink(pool, id, 'repo', repo, OWNER);
  return id;
}

/** Runs the audit and has the worker post its report, as the two jobs would. */
async function audit(now: Date = NOW) {
  setup(now);
  const outcome = await runAudit(h.worker, 'schedule', 'system', now);
  expect(outcome.runId).not.toBeNull();
  const posted = await postAuditReport(h.worker, outcome.runId!);
  return { runId: outcome.runId!, summary: outcome.summary, posted, run: (await getAuditRun(pool, outcome.runId!))! };
}

const lines = (message: Record<string, unknown>): string[] =>
  ((message.blocks as { text?: { text: string } }[])[0]!.text!.text).split('\n');
const buttons = (message: Record<string, unknown>) =>
  ((message.blocks as { elements?: { action_id: string; value?: string; url?: string; text: { text: string } }[] }[])[1]!.elements ?? []);

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'audit', CHANNEL);
  cursor = new FakeCursor();
  trouble = { crashes: 4, configFile: true, vulnerability: true, metricsDown: false, memoryFull: false };
});
afterAll(() => pool.end());

describe('the weekly audit', () => {
  it('ranks what it finds, stores the report and posts one short message', async () => {
    await register('Acme Portal', ACME_REPO);
    const { run, summary, posted } = await audit();
    expect(posted).toBe('posted');
    expect(summary).toBe('1 critical, 2 warnings, 1 of 4 services healthy');
    expect(run.status).toBe('done');
    expect(run.counts).toMatchObject({ projects: 2, services: 4, critical: 1, warning: 2, healthy: 1, muted: 0, resolved: 0 });

    const report = run.report!;
    // Severity first, then the design's category order: outage, security, deploy hygiene.
    expect(report.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity} ${f.subject} ${f.title}`)).toEqual([
      'critical Acme Portal api crashed 4 times in the last 7 days',
      'warning Acme Portal Postgres has 1 unpatched vulnerability notice from Railway (CVE-2099-0001)',
      'warning Globex Sync sync still reads /railway.json, which Railway stops reading on 2026-12-01',
    ]);
    expect(report.inventory).toEqual({ initial: true, changes: [] });
    expect(report.coverage.find((c) => c.key === 'deploy.behind_default')).toMatchObject({ checked: 0, reasons: { 'the GitHub App is not configured': 3 } });

    const posts = h.slack.of('postMessage');
    expect(posts).toHaveLength(1);
    const message = posts[0]!;
    expect(message.channel).toBe(CHANNEL);
    expect(lines(message)).toEqual([
      '*Weekly Railway audit · 2 projects · 4 services*',
      '1 critical · 2 warnings · 1 healthy',
      '1. Acme Portal api crashed 4 times in the last 7 days',
      '2. Acme Portal Postgres has 1 unpatched vulnerability notice from Railway (CVE-2099-0001)',
      '3. Globex Sync sync still reads /railway.json, which Railway stops reading on 2026-12-01',
    ]);
    expect(lines(message).length).toBeLessThanOrEqual(MAX_LINES);
    const row = buttons(message);
    expect(row.length).toBeLessThanOrEqual(MAX_BUTTONS);
    expect(row.map((b) => b.text.text)).toEqual(['Fix 1 via agent', 'Details 2', 'Details 3', 'Full report']);
    // Slack requires action ids to be unique within a message.
    expect(new Set(row.map((b) => b.action_id)).size).toBe(row.length);
    expect(row[3]!.url).toBe(`http://patcher.test/audits/${run.id}`);
    expect(row[1]!.url).toBe(`http://patcher.test/audits/findings/${report.top[1]!.findingId}`);

    expect(await auditActions(pool)).toEqual(
      expect.arrayContaining(['audit.start', 'recommendation.create', 'audit.finish', 'audit.report.post', 'recommendation.post']),
    );
    expect((await listIntegrations(pool)).find((i) => i.name === 'railway')).toBeUndefined();
  });

  it('proposes a fix only where the repository is in the registry and Cursor is configured', async () => {
    await register('Acme Portal', ACME_REPO);
    const { run } = await audit();
    const fixes = Object.fromEntries(run.report!.findings.map((f) => [f.check, f.fix]));
    expect(fixes['outage.crashes']).toMatchObject({ status: 'proposed' });
    expect(fixes['deploy.config_as_code']).toEqual({ status: 'unavailable', reason: `${GLOBEX_REPO} is not linked to an active project in the registry` });
    expect(fixes['security.database_vulnerability']).toEqual({ status: 'none' });

    const recs = await listRecommendations(pool, ['posted'], 10);
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec).toMatchObject({
      kind: 'audit_fix',
      reportType: 'audit',
      carrierType: AUDIT_CARRIER,
      carrierId: run.id,
      slackChannel: CHANNEL,
      slackTs: run.slackTs,
      title: 'Fix Acme Portal api: crashed 4 times in the last 7 days',
    });
    expect(rec.action).toMatchObject({ type: 'cursor.launch_agent', params: { repo: ACME_REPO, ref: 'main' } });
    expect(rec.expiresAt).not.toBeNull();
    // The carried recommendation is posted by its report, never as a message of its own.
    expect(h.queue.of('recommendation.post')).toEqual([]);
    // The button on the report is this recommendation's approve button, for this exact content.
    expect(decodeRef(buttons(h.slack.of('postMessage')[0]!)[0]!.value!)).toEqual({ id: rec.id, hash: rec.actionHash });
  });

  it('proposes nothing while Cursor is not configured, and says why', async () => {
    await register('Acme Portal', ACME_REPO);
    setup(NOW, { cursor: false });
    const { runId } = await runAudit(h.worker, 'manual', OWNER, NOW);
    const run = (await getAuditRun(pool, runId!))!;
    expect(run.report!.findings[0]!.fix).toEqual({ status: 'unavailable', reason: 'Cursor is not configured (CURSOR_API_KEY)' });
    expect(await listRecommendations(pool, ['drafted', 'posted'], 10)).toEqual([]);
    await postAuditReport(h.worker, run.id);
    expect(buttons(h.slack.of('postMessage')[0]!).map((b) => b.text.text)).toEqual(['Details 1', 'Details 2', 'Details 3', 'Full report']);
  });

  it('skips cleanly when Railway is not configured', async () => {
    h = harness(pool);
    expect(await runAudit(h.worker, 'schedule')).toEqual({ runId: null, summary: 'Skipped: Railway is not configured (RAILWAY_API_TOKEN).' });
    expect(await scheduleHandlers['audit.weekly']!(h.worker)).toBe('Skipped: Railway is not configured (RAILWAY_API_TOKEN).');
    expect(h.queue.jobs).toEqual([]);
    expect((await pool.query('SELECT 1 FROM audit_runs')).rowCount).toBe(0);
  });

  it('is started by its schedule as a job of its own', async () => {
    setup();
    expect(await scheduleHandlers['audit.weekly']!(h.worker)).toBe('Audit started.');
    expect(h.queue.of('audit.run')).toEqual([{ trigger: 'schedule', requestedBy: 'system' }]);
  });

  it('records a failed run and marks the integration, instead of reporting a healthy workspace', async () => {
    await recordConfigured(pool, testIntegrations({ railway: fakeRailway() }).status);
    h = harness(pool, {
      integrations: testIntegrations({
        railway: fakeRailway({
          projects: () => {
            throw new Error('Railway refused the token (HTTP 401)');
          },
        }),
      }),
    });
    await expect(runAudit(h.worker, 'schedule', 'system', NOW)).rejects.toThrow('Railway refused the token');
    const { rows } = await pool.query<{ status: string; error: string }>('SELECT status, error FROM audit_runs');
    expect(rows).toEqual([{ status: 'failed', error: 'Railway refused the token (HTTP 401)' }]);
    expect((await listIntegrations(pool)).find((i) => i.name === 'railway')).toMatchObject({ lastError: 'Railway refused the token (HTTP 401)' });
    expect(h.slack.calls).toEqual([]);
  });
});

describe('posting the report', () => {
  it('waits while there is no channel, and posts once one is set', async () => {
    await pool.query('DELETE FROM channel_routes');
    await register('Acme Portal', ACME_REPO);
    const first = await audit();
    expect(first.posted).toBe('held');
    expect(first.run.postError).toBe('Waiting: no channel is set for Audit reports.');
    expect(h.slack.calls).toEqual([]);
    expect((await listRecommendations(pool, ['drafted'], 10)).map((r) => r.status)).toEqual(['drafted']);

    await routeTo(pool, 'audit', CHANNEL);
    h.queue.clear();
    expect(await resumeHeldReports(h.worker)).toBe(1);
    expect(h.queue.of('audit.report.post')).toEqual([{ runId: first.runId }]);
    expect(await postAuditReport(h.worker, first.runId)).toBe('posted');
    expect(await postAuditReport(h.worker, first.runId)).toBe('skipped');
    expect(h.slack.of('postMessage')).toHaveLength(1);
  });

  it('waits while paused, and a drafted fix asks its report to post rather than posting itself', async () => {
    await register('Acme Portal', ACME_REPO);
    await setSetting(pool, 'paused', true, OWNER);
    const { posted, run } = await audit();
    expect(posted).toBe('held');
    expect(run.postError).toBe('Waiting: Patcher is paused.');

    await setSetting(pool, 'paused', false, OWNER);
    const [rec] = await listRecommendations(pool, ['drafted'], 10);
    h.queue.clear();
    expect(await postRecommendation(h.worker, rec!.id)).toBe('carried');
    expect(h.queue.of('audit.report.post')).toEqual([{ runId: run.id }]);
    expect(h.slack.calls).toEqual([]);
  });

  it('holds the report and tells bot-errors when Slack refuses the channel', async () => {
    await routeTo(pool, 'errors', 'C0ERRORS');
    setup();
    const { runId } = await runAudit(h.worker, 'schedule', 'system', NOW);
    h.slack.fail('not_in_channel');
    expect(await postAuditReport(h.worker, runId!)).toBe('held');
    expect((await getAuditRun(pool, runId!))!.postError).toBe('Slack refused the post (not_in_channel). Invite the bot to the channel, then post again.');
    expect(h.slack.of('postMessage')).toEqual([
      expect.objectContaining({ channel: 'C0ERRORS', text: `Could not post the audit report to <#${CHANNEL}>: not_in_channel. Invite the bot to the channel, then post again.` }),
    ]);
  });

  it('does not post a report that a newer audit has replaced', async () => {
    await pool.query('DELETE FROM channel_routes');
    await register('Acme Portal', ACME_REPO);
    const old = await audit(NOW);
    const [stale] = await listRecommendations(pool, ['drafted'], 10);
    const newer = await audit(new Date(NOW.getTime() + WEEK));
    await routeTo(pool, 'audit', CHANNEL);

    expect(await postAuditReport(h.worker, old.runId)).toBe('skipped');
    expect((await getAuditRun(pool, old.runId))!.postError).toBe('Not posted: a newer audit replaced it.');
    expect((await getRecommendation(pool, stale!.id))!.status).toBe('expired');
    expect(await resumeHeldReports(h.worker)).toBe(1);
    expect(await postAuditReport(h.worker, newer.runId)).toBe('posted');
    expect(h.slack.of('postMessage')).toHaveLength(1);
  });

  it('sends one reminder for a report that carries several fixes', async () => {
    await register('Acme Portal', ACME_REPO);
    await register('Globex Sync', GLOBEX_REPO);
    const { run } = await audit();
    const recs = await listRecommendations(pool, ['posted'], 10);
    expect(recs).toHaveLength(2);
    expect(buttons(h.slack.of('postMessage')[0]!).map((b) => b.text.text)).toEqual(['Fix 1 via agent', 'Details 2', 'Fix 3 via agent', 'Full report']);

    const nearExpiry = new Date(recs[0]!.expiresAt!.getTime() - 3600_000);
    expect(await runExpiry(h.worker, nearExpiry)).toBe('2 reminded, 0 expired');
    const replies = h.slack.of('postMessage').filter((m) => m.threadTs === run.slackTs);
    expect(replies).toHaveLength(1);
  });
});

describe('Fix via agent', () => {
  async function approved() {
    const projectId = await register('Acme Portal', ACME_REPO);
    const { run } = await audit();
    const [rec] = await listRecommendations(pool, ['posted'], 10);
    h.queue.clear();
    const result = await decide(h, { id: rec!.id, hash: rec!.actionHash, actor: APPROVER, via: 'slack', decision: 'approve' });
    expect(result.ok).toBe(true);
    const [job] = h.queue.of('action.execute');
    return { run, rec: rec!, actionId: job!.actionId, projectId };
  }

  it('starts an agent on the linked repository after approval, and watches it', async () => {
    const { run, rec, actionId } = await approved();
    expect(cursor.started).toEqual([]);
    h.queue.clear();
    expect(await executeAction(h.worker, actionId)).toBe('done');

    expect(cursor.started).toHaveLength(1);
    const started = cursor.started[0]!;
    expect(started).toMatchObject({ repo: ACME_REPO, startingRef: 'main', name: 'Patcher fix · Acme Portal', agentId: agentIdFor(`rec:${rec.id}:v1`) });
    expect(started.prompt).toContain('Acme Portal api crashed 4 times in the last 7 days');
    expect(started.prompt).toContain('Do not merge it.');

    const { rows } = await pool.query<{ id: string; status: string; repo: string; finding_id: string }>('SELECT id, status, repo, finding_id FROM agent_runs');
    expect(rows).toEqual([{ id: expect.any(String) as string, status: 'running', repo: ACME_REPO, finding_id: run.report!.top[0]!.findingId }]);
    const [poll] = h.queue.jobs.filter((j) => j.name === 'agent.poll');
    expect(poll).toMatchObject({ data: { agentRunId: rows[0]!.id }, options: { startAfter: 60 } });

    // The report is edited in place: the line says what happened and its button is gone.
    const update = h.slack.of('updateMessage').at(-1)!;
    expect(update).toMatchObject({ channel: CHANNEL, ts: run.slackTs });
    expect(lines(update)[2]).toBe(
      `1. Acme Portal api crashed 4 times in the last 7 days · fix approved by <@${APPROVER}> · <https://cursor.com/agents/${started.agentId}|agent running>`,
    );
    expect(lines(update)).toHaveLength(5);
    expect(buttons(update).map((b) => b.text.text)).toEqual(['Details 1', 'Details 2', 'Details 3', 'Full report']);
    // The outcome line goes to the report's thread, like every other recommendation.
    expect(h.slack.of('postMessage').at(-1)).toMatchObject({ threadTs: run.slackTs });
  });

  it('posts the pull request in the thread once, and shows it on the report and the finding', async () => {
    const { run, actionId } = await approved();
    await executeAction(h.worker, actionId);
    const agentRunId = h.queue.of('agent.poll')[0]!.agentRunId;
    h.queue.clear();

    expect(await pollAgentRun(h.worker, agentRunId)).toBe('running');
    expect(h.queue.of('agent.poll')).toEqual([{ agentRunId }]);

    cursor.run = {
      status: 'FINISHED',
      result: 'Fixed the null check in the order handler.',
      branches: [{ repoUrl: `github.com/${ACME_REPO}`, branch: 'cursor/fix-crash', prUrl: `https://github.com/${ACME_REPO}/pull/12` }],
    };
    const before = h.slack.of('postMessage').length;
    expect(await pollAgentRun(h.worker, agentRunId)).toBe('finished');
    const reply = h.slack.of('postMessage').at(-1)!;
    expect(reply).toMatchObject({ channel: CHANNEL, threadTs: run.slackTs, text: `Agent finished · <https://github.com/${ACME_REPO}/pull/12|PR #12> ready for review` });
    expect(lines(h.slack.of('updateMessage').at(-1)!)[2]).toBe(
      `1. Acme Portal api crashed 4 times in the last 7 days · <https://github.com/${ACME_REPO}/pull/12|PR #12> ready for review`,
    );
    expect((await getFinding(pool, run.report!.top[0]!.findingId))!.prUrl).toBe(`https://github.com/${ACME_REPO}/pull/12`);

    expect(await pollAgentRun(h.worker, agentRunId)).toBe('already_done');
    expect(h.slack.of('postMessage')).toHaveLength(before + 1);
    expect(await auditActions(pool)).toContain('agent.finished');
  });

  it('says so when the agent fails, finishes without a pull request, or runs past the time limit', async () => {
    const { actionId } = await approved();
    await executeAction(h.worker, actionId);
    const agentRunId = h.queue.of('agent.poll')[0]!.agentRunId;
    const agentUrl = `https://cursor.com/agents/${cursor.started[0]!.agentId}`;

    // A poll that fails is not a failed agent.
    cursor.failPoll = new Error('Cursor did not answer');
    expect(await pollAgentRun(h.worker, agentRunId)).toBe('running');
    cursor.failPoll = undefined;

    const startedAt = (await pool.query<{ started_at: Date }>('SELECT started_at FROM agent_runs')).rows[0]!.started_at;
    expect(await pollAgentRun(h.worker, agentRunId, new Date(startedAt.getTime() + 181 * 60_000))).toBe('timed_out');
    expect(h.slack.of('postMessage').at(-1)!.text).toBe(`Agent is still running after the time limit; Patcher stopped watching it · <${agentUrl}|agent>`);

    await pool.query(`UPDATE agent_runs SET status = 'running', reported_at = NULL, finished_at = NULL`);
    cursor.run = { status: 'ERROR', result: null, branches: [] };
    expect(await pollAgentRun(h.worker, agentRunId)).toBe('failed');
    expect(h.slack.of('postMessage').at(-1)!.text).toBe(`Agent failed: The run ended as ERROR. · <${agentUrl}|agent>`);

    await pool.query(`UPDATE agent_runs SET status = 'running', reported_at = NULL, finished_at = NULL`);
    cursor.run = { status: 'FINISHED', result: 'Nothing to change.', branches: [] };
    expect(await pollAgentRun(h.worker, agentRunId)).toBe('finished');
    expect(h.slack.of('postMessage').at(-1)!.text).toBe(`Agent finished without a pull request · <${agentUrl}|agent>`);
  });

  it('starts no agent in dry run', async () => {
    const { actionId } = await approved();
    await setSetting(pool, 'dry_run', true, OWNER);
    expect(await executeAction(h.worker, actionId)).toBe('done');
    expect(cursor.started).toEqual([]);
    expect((await pool.query('SELECT 1 FROM agent_runs')).rowCount).toBe(0);
  });

  it('checks the registry again when it runs: an unlinked repository gets no agent', async () => {
    const { rec, actionId, projectId } = await approved();
    await updateProject(pool, projectId, { name: 'Acme Portal', status: 'archived' }, OWNER);
    expect(await executeAction(h.worker, actionId)).toBe('failed');
    expect(cursor.started).toEqual([]);
    expect((await getRecommendation(pool, rec.id))!.lastError).toBe(`${ACME_REPO} is not linked to an active project in the registry, so no agent was started.`);
  });

  it('does not start a second agent when the same approved version runs again', async () => {
    const { rec, actionId } = await approved();
    cursor.failStart = new Error('Cursor did not answer');
    expect(await executeAction(h.worker, actionId)).toBe('failed');
    cursor.failStart = undefined;
    const failed = (await getRecommendation(pool, rec.id))!;
    h.queue.clear();
    const { retryRecommendation } = await import('../src/recommendations/service.js');
    expect((await retryRecommendation(h, { id: rec.id, hash: failed.actionHash, actor: APPROVER, via: 'ui' })).ok).toBe(true);
    for (const job of h.queue.of('action.execute')) expect(await executeAction(h.worker, job.actionId)).toBe('done');
    expect(cursor.started.map((s) => s.agentId)).toEqual([agentIdFor(`rec:${rec.id}:v1`)]);
    expect((await pool.query('SELECT 1 FROM agent_runs')).rowCount).toBe(1);
  });

  it('shows a dismissed fix on the report', async () => {
    await register('Acme Portal', ACME_REPO);
    await audit();
    const [rec] = await listRecommendations(pool, ['posted'], 10);
    await decide(h, { id: rec!.id, hash: rec!.actionHash, actor: OWNER, via: 'slack', decision: 'dismiss' });
    await syncMessage(h.worker, rec!.id);
    const update = h.slack.of('updateMessage').at(-1)!;
    expect(lines(update)[2]).toBe(`1. Acme Portal api crashed 4 times in the last 7 days · fix dismissed by <@${OWNER}>`);
    expect(buttons(update)[0]!.text.text).toBe('Details 1');
    expect(cursor.started).toEqual([]);
  });

  it('derives a stable agent id of the form Cursor accepts, and a brief with no secrets in it', async () => {
    const id = agentIdFor('rec:1:v1');
    expect(id).toMatch(/^bc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(agentIdFor('rec:1:v1')).toBe(id);
    expect(agentIdFor('rec:1:v2')).not.toBe(id);

    await register('Acme Portal', ACME_REPO);
    const { run } = await audit();
    const finding = (await getFinding(pool, run.report!.top[0]!.findingId))!;
    const brief = fixBrief({
      ...finding,
      evidence: [{ quote: 'connect failed postgres://app:hunter2@db.internal:5432/app for ada@example.com', source: 'error logs' }],
    });
    expect(brief).toContain('[connection string]');
    expect(brief).not.toContain('hunter2');
    expect(brief).not.toContain('ada@example.com');
  });
});

describe('findings from week to week', () => {
  it('keeps a finding open across weeks, counts them, and does not propose a second fix while one is open', async () => {
    await register('Acme Portal', ACME_REPO);
    const first = await audit(NOW);
    const second = await audit(new Date(NOW.getTime() + WEEK));
    const third = await audit(new Date(NOW.getTime() + 2 * WEEK));

    expect(third.run.report!.top[0]!.line).toBe('Acme Portal api crashed 4 times in the last 7 days · still open, week 3');
    expect(third.run.report!.findings[0]).toMatchObject({ id: first.run.report!.findings[0]!.id, weeksOpen: 3, isNew: false });
    expect(second.run.report!.findings[0]!.fix.status).toBe('in_progress');
    // One recommendation in three weeks: the first is still waiting for a decision.
    expect((await pool.query('SELECT 1 FROM recommendations')).rowCount).toBe(1);
    expect(buttons(h.slack.of('postMessage')[0]!)[0]!.text.text).toBe('Details 1');
    expect((await pool.query(`SELECT 1 FROM audit_findings WHERE check_key = 'outage.crashes'`)).rowCount).toBe(1);
  });

  it('marks a finding as growing when its number went up', async () => {
    await audit(NOW);
    trouble.crashes = 9;
    const { run } = await audit(new Date(NOW.getTime() + WEEK));
    expect(run.report!.top[0]!.line).toBe('Acme Portal api crashed 9 times in the last 7 days · still open, week 2, growing');
  });

  it('resolves a finding that is gone, and starts over if it comes back', async () => {
    const first = await audit(NOW);
    const id = first.run.report!.findings[0]!.id;
    trouble.crashes = 0;
    const second = await audit(new Date(NOW.getTime() + WEEK));
    expect(second.run.counts).toMatchObject({ critical: 0, resolved: 1 });
    expect(await getFinding(pool, id)).toMatchObject({ state: 'resolved' });

    trouble.crashes = 2;
    const third = await audit(new Date(NOW.getTime() + 2 * WEEK));
    const back = third.run.report!.findings.find((f) => f.id === id)!;
    expect(back).toMatchObject({ weeksOpen: 1, isNew: true, severity: 'warning' });
    expect(await getFinding(pool, id)).toMatchObject({ state: 'open', resolvedAt: null });
  });

  it('does not resolve a finding in a week its check could not run', async () => {
    trouble.memoryFull = true;
    const first = await audit(NOW);
    const memory = first.run.report!.findings.find((f) => f.check === 'capacity.memory')!;
    expect(memory.title).toBe('used 98% of its memory limit');

    trouble.metricsDown = true;
    const second = await audit(new Date(NOW.getTime() + WEEK));
    expect(second.run.report!.findings.some((f) => f.check === 'capacity.memory')).toBe(false);
    expect(second.run.report!.coverage.find((c) => c.key === 'capacity.memory')).toMatchObject({ checked: 0, reasons: { 'Railway returned HTTP 502': 4 } });
    // Not seen, but not checked either: still open, not resolved.
    expect(await getFinding(pool, memory.id)).toMatchObject({ state: 'open' });

    trouble.metricsDown = false;
    trouble.memoryFull = false;
    await audit(new Date(NOW.getTime() + 2 * WEEK));
    expect(await getFinding(pool, memory.id)).toMatchObject({ state: 'resolved' });
  });

  it('keeps muted and accepted findings out of the report until they are reopened', async () => {
    const first = await audit(NOW);
    const [crash, vulnerability] = first.run.report!.findings;
    await setFindingState(pool, crash!.id, 'muted', APPROVER, 'Known; being replaced');
    await setFindingState(pool, vulnerability!.id, 'accepted', OWNER);

    const second = await audit(new Date(NOW.getTime() + WEEK));
    expect(second.run.counts).toMatchObject({ critical: 0, warning: 1, muted: 1, accepted: 1 });
    expect(second.run.report!.findings.map((f) => f.id)).not.toContain(crash!.id);
    expect(lines(h.slack.of('postMessage')[0]!)[1]).toBe('0 critical · 1 warning · 3 healthy');
    expect((await listFindings(pool, ['muted'])).map((f) => [f.id, f.stateBy, f.stateNote])).toEqual([[crash!.id, APPROVER, 'Known; being replaced']]);

    await setFindingState(pool, crash!.id, 'open', OWNER);
    const third = await audit(new Date(NOW.getTime() + 2 * WEEK));
    expect(third.run.report!.findings[0]).toMatchObject({ id: crash!.id, weeksOpen: 3 });
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['finding.mute', 'finding.accept', 'finding.reopen']));
  });

  it('renders the same report as Markdown, with what ran and what could not', async () => {
    const { run } = await audit();
    const markdown = renderMarkdown(run.report!);
    expect(markdown).toContain('# Weekly Railway audit · 2 projects · 4 services');
    expect(markdown).toContain('1. **critical** · Outages · Acme Portal api crashed 4 times in the last 7 days (new)');
    expect(markdown).toContain('## Checks that could not run');
    expect(markdown).toContain('Deploy hygiene: Production behind the default branch: not checked. the GitHub App is not configured (3)');
    expect(markdown).toContain('First inventory: nothing to compare with yet.');
  });
});
