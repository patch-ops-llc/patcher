import type { ModelClient } from '../ai/client.js';
import { ModelApiError } from '../ai/client.js';
import { costUsd, estimateTokens } from '../ai/models.js';
import { loadPrompt } from '../ai/prompts.js';
import type { ModelDeps } from '../ai/run.js';
import { buildRequest, callModel, readReply, recordCall, spentSince } from '../ai/run.js';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { fixAvailability, proposeFix } from '../fix/agentFix.js';
import type { DraftedBrief } from '../fix/brief.js';
import { draftBrief } from '../fix/brief.js';
import { markError, markOk } from '../integrations/status.js';
import type { Recommendation } from '../recommendations/types.js';
import { projectForRepo } from '../registry/registry.js';
import { getSetting } from '../settings/settings.js';
import type { WorkerDeps } from '../worker/deps.js';
import type { ServiceGroup } from './assess.js';
import { SERVICE_TASK, checkAssessments } from './assess.js';
import { AUDIT_CARRIER } from './delivery.js';
import type { Finding, TrackedFinding } from './findings.js';
import { findingsByIds, getFinding, rank, saveAssessment, track } from './findings.js';
import type { AnalysisInfo, AnalysisStep, AuditCounts, AuditReport, FixInfo, ReportFinding, RulesReason } from './report.js';
import { RULES_DETAIL, TOP_FINDINGS, toReportFinding, topLine } from './report.js';
import { ROLLUP_TASK, applyRollup, buildRollupInput } from './rollup.js';

/**
 * The model steps of the audit (design 7.3 and section 10), on top of the rule-based checks:
 *
 *   1. per service, as one batch: what each finding most likely means and what to do about it
 *   2. the rollup: the order of the report and the wording of its Slack lines
 *   3. per proposed fix: the brief for the agent
 *
 * The model drafts and classifies. It is given text and returns JSON; code decides what of
 * that JSON is used, and nothing it returns can start an action. Whenever a step cannot run
 * (no key, switched off, over budget, the provider down, an unusable reply) the audit goes
 * on with what the rules wrote, and the report says so.
 */

/** One audit at a time, in either of its stages. The id is arbitrary and only has to be stable. */
const AUDIT_LOCK = 4_170_001;
const POLL_SECONDS = 60;
const FEATURE = 'audit';

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Takes the audit lock on its own connection. Null when another audit stage holds it. */
export async function tryAuditLock(pool: Pool): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [AUDIT_LOCK]);
    if (!got.rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    await client.query('SELECT pg_advisory_unlock($1)', [AUDIT_LOCK]).catch(() => undefined);
    client.release();
  };
}

export type Gate = { ok: true; client: ModelClient } | { ok: false; reason: Exclude<RulesReason, 'failed'> };

/**
 * Whether the audit may call the model now: a key is set, the switch is on, and the budget
 * has room for `estimate` more dollars.
 */
export async function modelGate(deps: Pick<WorkerDeps, 'pool' | 'integrations'>, estimate = 0): Promise<Gate> {
  const client = deps.integrations.model;
  if (!client) return { ok: false, reason: 'not_configured' };
  if (!(await getSetting(deps.pool, 'ai.audit.enabled'))) return { ok: false, reason: 'disabled' };
  const [daily, monthly] = await Promise.all([
    getSetting(deps.pool, 'ai.audit.daily_budget_usd'),
    getSetting(deps.pool, 'ai.audit.monthly_budget_usd'),
  ]);
  if (daily > 0 && (await spentSince(deps.pool, FEATURE, 24)) + estimate >= daily) return { ok: false, reason: 'budget' };
  if (monthly > 0 && (await spentSince(deps.pool, FEATURE, 24 * 30)) + estimate >= monthly) return { ok: false, reason: 'budget' };
  return { ok: true, client };
}

const skipped = (key: AnalysisStep['key'], reason: Exclude<RulesReason, 'failed'>): AnalysisStep => ({
  key,
  status: 'skipped',
  detail: `Not run: ${RULES_DETAIL[reason]}.`,
});

/** What is kept on the run while its batch is with the provider. Ids only: no prompt text and no log lines. */
interface PendingAnalysis {
  batchId: string;
  submittedAt: string;
  model: string;
  promptVersion: string;
  groups: Pick<ServiceGroup, 'customId' | 'refs'>[];
  /** Set once the replies are read and recorded, so a retried poll does not read and record them twice. */
  collected?: AnalysisStep;
}

export type AnalysisStart = { waiting: true } | { waiting: false; step: AnalysisStep };

/**
 * Stage 1, after the checks are saved: sends the per-service requests as one batch and
 * leaves the run waiting for it. When there is nothing to send, or the model may not or
 * cannot be called, it says which and the caller finishes the audit straight away.
 */
export async function startAnalysis(deps: WorkerDeps, runId: string, groups: ServiceGroup[]): Promise<AnalysisStart> {
  if (!groups.length) {
    return { waiting: false, step: { key: 'service', status: 'skipped', detail: 'Not run: no service has a finding above informational.' } };
  }
  const model = await getSetting(deps.pool, 'ai.audit.model_service');
  const requests = groups.map((group) => ({ customId: group.customId, ...buildRequest(SERVICE_TASK, model, group.user) }));
  const inputTokens = requests.reduce((n, r) => n + estimateTokens(r.request.system) + estimateTokens(r.request.user), 0);
  // An estimate before spending: the real input, and a typical reply per request.
  const estimate = costUsd(model, { inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: requests.length * 1200 }, { batch: true }) ?? 0;
  const gate = await modelGate(deps, estimate);
  if (!gate.ok) return { waiting: false, step: skipped('service', gate.reason) };

  let batchId: string;
  try {
    ({ id: batchId } = await gate.client.createBatch(requests.map((r) => ({ customId: r.customId, request: r.request }))));
    await markOk(deps.pool, 'anthropic');
  } catch (err) {
    if (err instanceof ModelApiError) await markError(deps.pool, 'anthropic', err.message);
    deps.log.warn('could not submit the analysis batch', { auditRunId: runId, err });
    return { waiting: false, step: { key: 'service', status: 'failed', detail: `The requests could not be sent: ${reasonOf(err)}` } };
  }

  const pending: PendingAnalysis = {
    batchId,
    submittedAt: new Date().toISOString(),
    model,
    promptVersion: requests[0]!.promptVersion,
    groups: groups.map((g) => ({ customId: g.customId, refs: g.refs })),
  };
  await withTx(deps.pool, async (tx) => {
    await tx.query(`UPDATE audit_runs SET status = 'analyzing', analysis = $2 WHERE id = $1 AND status = 'running'`, [
      runId,
      JSON.stringify(pending),
    ]);
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'audit.analysis.start',
      target: runId,
      after: { batchId, requests: groups.length, model, promptVersion: pending.promptVersion },
    });
    await deps.queue.enqueue('audit.analyze', { runId }, { tx, startAfter: POLL_SECONDS });
  });
  return { waiting: true };
}

/** Reads the batch's replies, checks each entry and stores the ones that pass. */
async function collectAssessments(deps: WorkerDeps, client: ModelClient, runId: string, pending: PendingAnalysis): Promise<AnalysisStep> {
  const results = await client.batchResults(pending.batchId);
  const byId = new Map(pending.groups.map((g) => [g.customId, g]));
  const findings = new Map(
    (await findingsByIds(deps.pool, pending.groups.flatMap((g) => Object.values(g.refs)))).map((f) => [f.id, f]),
  );
  const base = { feature: FEATURE, task: SERVICE_TASK.task, promptVersion: pending.promptVersion, model: pending.model, batch: true, latencyMs: null, runId };
  let assessed = 0;
  let dropped = 0;
  let failedRequests = 0;
  for (const result of results) {
    const group = byId.get(result.customId);
    if (!group) continue;
    byId.delete(result.customId);
    if ('error' in result) {
      failedRequests += 1;
      await recordCall(deps.pool, { ...base, reply: null, ok: false, error: result.error });
      continue;
    }
    const read = readReply(SERVICE_TASK, result.reply);
    await recordCall(deps.pool, { ...base, reply: result.reply, ok: read.ok, error: read.ok ? null : `Invalid output: ${read.problem}` });
    if (!read.ok) {
      failedRequests += 1;
      continue;
    }
    const checked = checkAssessments(read.value, group.refs, findings, { runId, model: result.reply.model || pending.model, promptVersion: pending.promptVersion });
    dropped += checked.dropped.length;
    if (checked.dropped.length) deps.log.info('assessment entries dropped', { auditRunId: runId, request: group.customId, dropped: checked.dropped });
    for (const { findingId, assessment } of checked.accepted) {
      if (await saveAssessment(deps.pool, findingId, assessment)) assessed += 1;
    }
  }
  // A request the provider returned nothing for.
  failedRequests += byId.size;

  const total = pending.groups.reduce((n, g) => n + Object.keys(g.refs).length, 0);
  const parts = [`${assessed} of ${plural(total, 'finding')} assessed in ${plural(pending.groups.length, 'service')}, by ${pending.model} (prompt ${SERVICE_TASK.task}/${pending.promptVersion})`];
  if (failedRequests) parts.push(`${plural(failedRequests, 'request')} failed or returned an unusable reply`);
  if (dropped) parts.push(`${plural(dropped, 'entry', 'entries')} dropped by the evidence check`);
  return {
    key: 'service',
    status: assessed === 0 ? 'failed' : failedRequests || dropped ? 'partial' : 'done',
    detail: `${parts.join('; ')}. Findings without an assessment keep the rule's wording.`,
  };
}

export type AnalysisPoll = 'waiting' | 'done' | 'busy' | 'not_waiting';

/**
 * Stage 2, once a minute while a run is waiting: asks the provider whether the batch has
 * ended. When it has, or when the time allowed has passed, the audit is finished with
 * whatever the model returned.
 */
export async function pollAnalysis(deps: WorkerDeps, runId: string, now: Date = new Date()): Promise<AnalysisPoll> {
  const unlock = await tryAuditLock(deps.pool);
  if (!unlock) {
    await deps.queue.enqueue('audit.analyze', { runId }, { startAfter: POLL_SECONDS });
    return 'busy';
  }
  try {
    const { rows } = await deps.pool.query<{ status: string; analysis: PendingAnalysis | null }>(
      'SELECT status, analysis FROM audit_runs WHERE id = $1',
      [runId],
    );
    const run = rows[0];
    if (run?.status !== 'analyzing' || !run.analysis) return 'not_waiting';
    const pending = run.analysis;
    const client = deps.integrations.model;
    const waitMinutes = await getSetting(deps.pool, 'ai.audit.wait_minutes');
    const overdue = now.getTime() - Date.parse(pending.submittedAt) > waitMinutes * 60_000;

    let step: AnalysisStep | undefined = pending.collected;
    if (step) {
      // Read on an earlier attempt that did not get as far as finishing the audit.
    } else if (!client) {
      step = { key: 'service', status: 'failed', detail: 'The model key was removed while the analysis was running.' };
    } else {
      try {
        const batch = await client.getBatch(pending.batchId);
        await markOk(deps.pool, 'anthropic');
        if (batch.ended) {
          step = await collectAssessments(deps, client, runId, pending);
          await deps.pool.query(`UPDATE audit_runs SET analysis = analysis || $2::jsonb WHERE id = $1 AND status = 'analyzing'`, [
            runId,
            JSON.stringify({ collected: step }),
          ]);
        }
      } catch (err) {
        if (err instanceof ModelApiError) await markError(deps.pool, 'anthropic', err.message);
        // A failed poll is not a failed analysis. Keep asking until the time allowed has passed.
        deps.log.warn('analysis poll failed', { auditRunId: runId, err });
      }
      if (!step && overdue) {
        await client.cancelBatch(pending.batchId).catch((err: unknown) => deps.log.warn('could not cancel the batch', { auditRunId: runId, err }));
        step = { key: 'service', status: 'failed', detail: `No result from the model after ${waitMinutes} minutes, so the batch was cancelled.` };
      }
    }
    if (!step) {
      await deps.queue.enqueue('audit.analyze', { runId }, { startAfter: POLL_SECONDS });
      return 'waiting';
    }
    await completeAudit(deps, runId, step);
    return 'done';
  } finally {
    await unlock();
  }
}

/** The model's brief for a fix, or undefined when the model may not be called or its draft was not usable. */
async function briefFor(deps: WorkerDeps, finding: Finding, runId: string | null): Promise<{ brief?: DraftedBrief; problem?: string; reason?: Exclude<RulesReason, 'failed'> }> {
  const gate = await modelGate(deps);
  if (!gate.ok) return { reason: gate.reason };
  try {
    const model = await getSetting(deps.pool, 'ai.audit.model_brief');
    const project = finding.repo ? await projectForRepo(deps.pool, finding.repo) : null;
    const modelDeps: ModelDeps = { pool: deps.pool, client: gate.client, log: deps.log };
    return { brief: await draftBrief(modelDeps, finding, { model, runId }, project) };
  } catch (err) {
    deps.log.warn('could not draft a fix brief', { findingId: finding.id, err });
    return { problem: reasonOf(err) };
  }
}

/**
 * "Propose fix via agent" from a finding's page. The public service only asks; the brief is
 * drafted here, where the model key is, and the recommendation then goes through the
 * ordinary loop.
 */
export async function proposeFixFor(deps: WorkerDeps, findingId: string, requestedBy: Actor): Promise<Recommendation | null> {
  const finding = await getFinding(deps.pool, findingId);
  if (!finding || finding.state !== 'open') return null;
  const fix = (await fixAvailability(deps.pool, [finding], deps.integrations.cursor !== null)).get(finding.id);
  if (fix?.status !== 'available') return null;
  const { brief } = await briefFor(deps, finding, finding.lastRun);
  const { recommendation } = await proposeFix(deps, finding, {
    createdBy: requestedBy,
    // The key carries the last audit that saw the finding: one proposal per finding per audit.
    dedupeKey: `finding:${finding.id}:${finding.lastRun ?? 'none'}`,
    brief,
  });
  return recommendation;
}

interface RunRow {
  status: string;
  trigger: string;
  counts: AuditCounts | null;
  report: AuditReport | null;
  started_at: Date;
}

/**
 * Finishes an audit whose checks are saved: ranks (the model's order when it gives one, the
 * rules' otherwise), proposes fixes for the top findings with a drafted brief each, stores
 * the report and hands it to Slack. `service` is what became of the per-service step.
 */
export async function completeAudit(deps: WorkerDeps, runId: string, service: AnalysisStep): Promise<{ counts: AuditCounts; analysis: AnalysisInfo }> {
  const log = deps.log.child({ auditRunId: runId });
  const { rows } = await deps.pool.query<RunRow>('SELECT status, trigger, counts, report, started_at FROM audit_runs WHERE id = $1', [runId]);
  const run = rows[0];
  if (!run?.report || !run.counts || (run.status !== 'running' && run.status !== 'analyzing')) {
    throw new Error(`Audit ${runId} is not waiting to be finished`);
  }
  const base = run.report;
  const now = new Date(base.generatedAt);

  // The findings this run reported, as they are now: with the assessments that passed.
  const stored = await findingsByIds(deps.pool, base.findings.map((f) => f.id));
  const ruleRanked: TrackedFinding[] = rank(stored.map((f) => track(f, runId, now)));
  const fixes = await fixAvailability(deps.pool, ruleRanked, deps.integrations.cursor !== null);

  // Rollup -----------------------------------------------------------------------------------
  let order = ruleRanked;
  let lines = new Map<string, string>();
  let reason: RulesReason | null = null;
  let rollupStep: AnalysisStep;
  const previous = await deps.pool.query<{ report: AuditReport | null }>(
    `SELECT report FROM audit_runs WHERE status = 'done' AND started_at < $1 ORDER BY started_at DESC LIMIT 1`,
    [run.started_at],
  );
  const input = buildRollupInput(ruleRanked, fixes, previous.rows[0]?.report ?? null);
  const gate = await modelGate(deps);
  if (!gate.ok) {
    // Said in the report even when there was nothing to rank: the model had no part in it.
    reason = gate.reason;
    rollupStep = skipped('rollup', gate.reason);
  } else if (!input) {
    rollupStep = { key: 'rollup', status: 'skipped', detail: 'Not run: no open finding is above informational, so there is nothing to rank.' };
  } else {
    const model = await getSetting(deps.pool, 'ai.audit.model_rollup');
    try {
      const reply = await callModel({ pool: deps.pool, client: gate.client, log }, ROLLUP_TASK, { model, runId }, input.user);
      const rollup = applyRollup(reply, input.refs, ruleRanked, [...new Set(ruleRanked.map((f) => f.scope.projectName))]);
      if (!rollup.ranked) throw new Error('The ranking named none of the findings.');
      ({ order, lines } = rollup);
      const candidates = Object.keys(input.refs).length;
      rollupStep = {
        key: 'rollup',
        status: rollup.ranked < candidates || rollup.rejectedLines ? 'partial' : 'done',
        detail:
          `${rollup.ranked} of ${plural(candidates, 'finding')} ranked by ${model} (prompt ${ROLLUP_TASK.task}/${loadPrompt(ROLLUP_TASK.task).version}); the rest follow in the rules' order.` +
          (rollup.rejectedLines ? ` ${plural(rollup.rejectedLines, 'drafted Slack line')} failed a check and the finding's own wording is used.` : ''),
      };
    } catch (err) {
      log.warn('the rollup failed; ranking by the rules', { err });
      reason = 'failed';
      rollupStep = { key: 'rollup', status: 'failed', detail: `The ranking could not be used: ${reasonOf(err)}. The rules ranked instead.` };
    }
  }

  // Fixes ------------------------------------------------------------------------------------
  // The top findings go in the Slack message. Those an agent can fix get a recommendation,
  // carried by the report message, so "Fix" there is the ordinary approval.
  const top = order.slice(0, TOP_FINDINGS);
  let drafted = 0;
  let proposed = 0;
  const briefProblems: string[] = [];
  // An earlier attempt at finishing this run may have got as far as proposing. Those stand.
  const earlier = await deps.pool.query<{ id: string; source_id: string }>(
    `SELECT id, source_id FROM recommendations WHERE carrier_type = $1 AND carrier_id = $2 AND status = 'drafted'`,
    [AUDIT_CARRIER, runId],
  );
  const already = new Map(earlier.rows.map((r) => [r.source_id, r.id]));
  for (const finding of top) {
    const existing = already.get(finding.id);
    if (existing) {
      fixes.set(finding.id, { status: 'proposed', recommendationId: existing });
      continue;
    }
    if (finding.state !== 'open' || fixes.get(finding.id)?.status !== 'available') continue;
    try {
      const { brief, problem, reason: why } = await briefFor(deps, finding, runId);
      if (brief) drafted += 1;
      else briefProblems.push(problem ?? RULES_DETAIL[why ?? 'not_configured']);
      const { recommendation } = await proposeFix(deps, finding, {
        carrier: { type: AUDIT_CARRIER, id: runId },
        dedupeKey: `audit:${runId}:${finding.id}`,
        brief,
      });
      proposed += 1;
      fixes.set(finding.id, { status: 'proposed', recommendationId: recommendation.id });
    } catch (err) {
      log.warn('could not propose a fix', { findingId: finding.id, err });
      fixes.set(finding.id, { status: 'unavailable', reason: 'the fix could not be drafted' });
    }
  }
  const briefStep: AnalysisStep = !proposed
    ? {
        key: 'brief',
        status: 'skipped',
        detail: already.size ? 'The fixes in this report were drafted on an earlier attempt.' : 'Not run: no fix was proposed in this report.',
      }
    : {
        key: 'brief',
        status: drafted === proposed ? 'done' : drafted ? 'partial' : 'skipped',
        detail:
          drafted === proposed
            ? `${plural(drafted, 'fix brief')} drafted by the model.`
            : `${drafted} of ${plural(proposed, 'fix brief')} drafted by the model; the rest use the rule's brief (${[...new Set(briefProblems)].join('; ')}).`,
      };

  // Report -----------------------------------------------------------------------------------
  const noFix: FixInfo = { status: 'none' };
  const reportFindings: ReportFinding[] = order.map((f) => toReportFinding(f, fixes.get(f.id) ?? noFix));
  const analysis: AnalysisInfo = { ranking: reason === null && input ? 'model' : 'rules', reason, steps: [service, rollupStep, briefStep] };
  const report: AuditReport = {
    ...base,
    findings: reportFindings,
    top: reportFindings.slice(0, TOP_FINDINGS).map((f) => ({
      findingId: f.id,
      line: topLine(f, lines.get(f.id)),
      recommendationId: f.fix.status === 'proposed' ? (f.fix.recommendationId ?? null) : null,
    })),
    analysis,
  };
  await withTx(deps.pool, async (tx) => {
    const done = await tx.query(
      `UPDATE audit_runs SET status = 'done', finished_at = now(), report = $2, analysis = NULL
        WHERE id = $1 AND status IN ('running', 'analyzing')`,
      [runId, JSON.stringify(report)],
    );
    if (!done.rowCount) throw new Error(`Audit ${runId} was finished by someone else`);
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'audit.finish',
      target: runId,
      after: { ...run.counts, ranking: analysis.ranking, ...(reason ? { rankedByRulesBecause: reason } : {}) },
    });
    await deps.queue.enqueue('audit.report.post', { runId }, { tx });
  });
  return { counts: run.counts, analysis };
}
