import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { CursorClient } from '../cursor/client.js';
import { TERMINAL_RUN_STATUSES } from '../cursor/client.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { markError, markOk } from '../integrations/status.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Catalog } from '../recommendations/catalog.js';
import { renderRecommendation, threadPrefix } from '../recommendations/delivery.js';
import type { LoopDeps } from '../recommendations/service.js';
import { createRecommendation, getRecommendation } from '../recommendations/service.js';
import type { Recommendation } from '../recommendations/types.js';
import { linkedRepos, projectForRepo } from '../registry/registry.js';
import { getSetting } from '../settings/settings.js';
import { SlackApiError } from '../slack/client.js';
import { clip, escapeMrkdwn } from '../slack/messages.js';
import type { Finding } from '../weekly/findings.js';
import { redact } from '../security/redact.js';
import type { FixInfo } from '../weekly/report.js';
import { subject } from '../weekly/types.js';
import type { WorkerDeps } from '../worker/deps.js';
import type { DraftedBrief } from './brief.js';
import { ruleBrief } from './brief.js';

export const FIX_KIND = 'audit_fix';
export const FIX_ACTION = 'cursor.launch_agent';

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export const fixParams = z
  .object({
    /** The audit finding this fixes, so the pull request can be shown next to it. */
    findingId: z.string().uuid().nullable().default(null),
    repo: z.string().regex(REPO, 'The repository is written owner/name, in lower case.'),
    /** Branch to start from. Null: the repository's default branch. */
    ref: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w./-]+$/, 'Not a branch name.')
      .nullable()
      .default(null),
    /** The brief the agent is given, exactly as approved. */
    prompt: z.string().trim().min(20, 'The brief is too short to act on.').max(6000),
  })
  .strict();
export type FixParams = z.infer<typeof fixParams>;

/** What the action needs at run time. The public service registers it without one. */
export interface FixRuntime {
  pool: Pool;
  queue: Enqueuer;
  cursor: CursorClient | null;
}

/** A stable `bc-<uuid>` for one approved version, so a repeated request starts no second agent. */
export function agentIdFor(idempotencyKey: string): string {
  const hex = createHash('sha256').update(`patcher:${idempotencyKey}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

const POLL_SECONDS = 60;

/**
 * Adds the audit's kind and its one action to the catalog. Approval starts a Cursor agent on
 * a repository that is linked in the registry; the agent works on its own branch and opens a
 * pull request. Nothing here merges, deploys or touches Railway.
 */
export function registerFixCatalog(catalog: Catalog, runtime: FixRuntime | null): Catalog {
  return catalog.registerKind({ kind: FIX_KIND, label: 'Audit', defaultReportType: 'audit' }).registerAction({
    type: FIX_ACTION,
    params: fixParams,
    describe: (p) =>
      `Start a Cursor agent on ${p.repo}${p.ref ? ` from ${p.ref}` : ''} with the brief below. It opens a pull request and never merges. Brief: ${p.prompt}`,
    async execute(params, ctx) {
      if (!runtime) throw new Error('This action runs in the worker only.');
      if (!runtime.cursor) throw new Error('Cursor is not configured: set CURSOR_API_KEY on the worker, then retry.');
      // Checked again here, not only when the fix was proposed: the registry may have changed.
      const project = await projectForRepo(runtime.pool, params.repo);
      if (!project) throw new Error(`${params.repo} is not linked to an active project in the registry, so no agent was started.`);

      let agent;
      try {
        agent = await runtime.cursor.startAgent({
          agentId: agentIdFor(ctx.idempotencyKey),
          name: `Patcher fix · ${project.name}`,
          prompt: params.prompt,
          repo: params.repo,
          startingRef: params.ref ?? undefined,
        });
        await markOk(runtime.pool, 'cursor');
      } catch (err) {
        await markError(runtime.pool, 'cursor', err instanceof Error ? err.message : String(err));
        throw err;
      }

      await withTx(runtime.pool, async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO agent_runs (recommendation_id, finding_id, agent_id, run_id, agent_url, repo)
           VALUES ($1, (SELECT id FROM audit_findings WHERE id = $2), $3, $4, $5, $6)
           ON CONFLICT (agent_id) DO NOTHING
           RETURNING id`,
          [ctx.recommendationId, params.findingId, agent.agentId, agent.runId, agent.url, params.repo],
        );
        const agentRunId = inserted.rows[0]?.id;
        if (agentRunId) await runtime.queue.enqueue('agent.poll', { agentRunId }, { tx, startAfter: POLL_SECONDS });
      });
      ctx.log.info('cursor agent started', { agentId: agent.agentId, repo: params.repo });
      return { externalRef: agent.url, summary: 'Agent started. The pull request is posted here when it is ready.' };
    },
  });
}

export interface ProposeOptions {
  carrier?: { type: string; id: string };
  createdBy?: Actor;
  /** Makes a second proposal for the same finding and occasion a no-op. */
  dedupeKey: string;
  /** The brief the model drafted. Without one, the rule's brief is used. */
  brief?: Pick<DraftedBrief, 'prompt' | 'summary'> | undefined;
}

/**
 * Turns a finding into a recommendation in the shared loop. From here on it is approved,
 * edited, dismissed, expired and logged like every other recommendation.
 */
export async function proposeFix(
  deps: LoopDeps,
  finding: Finding,
  options: ProposeOptions,
): Promise<{ recommendation: Recommendation; created: boolean }> {
  if (!finding.repo) throw new Error('The finding has no repository');
  const result = await createRecommendation(deps, {
    kind: FIX_KIND,
    sourceType: 'audit_finding',
    sourceId: finding.id,
    title: clip(`Fix ${subject(finding.scope)}: ${finding.title}`, 150),
    body: clip(options.brief?.summary || finding.recommendation, 300),
    evidence: finding.evidence.length
      ? finding.evidence.slice(0, 10).map((e) => ({ ...e, quote: clip(e.quote, 1500), source: clip(e.source, 280) }))
      : [{ quote: `${subject(finding.scope)} ${finding.title}`, source: 'Patcher weekly audit' }],
    action: {
      type: FIX_ACTION,
      params: { findingId: finding.id, repo: finding.repo.toLowerCase(), ref: finding.branch, prompt: options.brief?.prompt ?? ruleBrief(finding) },
    },
    risk: 'medium',
    dedupeKey: options.dedupeKey,
    ...(options.carrier ? { carrier: options.carrier } : {}),
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
  });
  await deps.pool.query('UPDATE audit_findings SET recommendation_id = $2 WHERE id = $1', [
    finding.id,
    result.recommendation.id,
  ]);
  return result;
}

/** Whether an earlier fix for this finding is still waiting, running or has a pull request. */
export async function fixInProgress(db: Queryable, finding: Pick<Finding, 'recommendationId' | 'prUrl'>): Promise<boolean> {
  if (finding.prUrl) return true;
  if (!finding.recommendationId) return false;
  const { rows } = await db.query<{ status: string; running: boolean }>(
    `SELECT r.status, EXISTS (SELECT 1 FROM agent_runs a WHERE a.recommendation_id = r.id AND a.status = 'running') AS running
       FROM recommendations r WHERE r.id = $1`,
    [finding.recommendationId],
  );
  const row = rows[0];
  return Boolean(row && (['drafted', 'posted', 'approved', 'executing'].includes(row.status) || row.running));
}

/** Decides, per finding, whether a fix by an agent can be offered, and why not when it cannot. */
export async function fixAvailability(
  db: Queryable,
  findings: Pick<Finding, 'id' | 'actionType' | 'repo' | 'recommendationId' | 'prUrl'>[],
  cursorConfigured: boolean,
): Promise<Map<string, FixInfo>> {
  const repos = await linkedRepos(db);
  const out = new Map<string, FixInfo>();
  for (const finding of findings) {
    if (finding.actionType !== 'fix_via_agent') {
      out.set(finding.id, { status: 'none' });
    } else if (await fixInProgress(db, finding)) {
      out.set(finding.id, {
        status: 'in_progress',
        ...(finding.recommendationId ? { recommendationId: finding.recommendationId } : {}),
      });
    } else if (!finding.repo) {
      out.set(finding.id, { status: 'unavailable', reason: 'the service does not deploy from a repository' });
    } else if (!repos.has(finding.repo.toLowerCase())) {
      out.set(finding.id, { status: 'unavailable', reason: `${finding.repo} is not linked to an active project in the registry` });
    } else if (!cursorConfigured) {
      out.set(finding.id, { status: 'unavailable', reason: 'Cursor is not configured (CURSOR_API_KEY)' });
    } else {
      out.set(finding.id, { status: 'available' });
    }
  }
  return out;
}

export interface AgentRunRecord {
  id: string;
  recommendationId: string;
  findingId: string | null;
  agentId: string;
  runId: string;
  agentUrl: string;
  repo: string;
  status: 'running' | 'finished' | 'failed' | 'timed_out';
  prUrl: string | null;
  lastError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

interface AgentRunRow {
  id: string;
  recommendation_id: string;
  finding_id: string | null;
  agent_id: string;
  run_id: string;
  agent_url: string;
  repo: string;
  status: AgentRunRecord['status'];
  pr_url: string | null;
  last_error: string | null;
  started_at: Date;
  finished_at: Date | null;
  reported_at: Date | null;
}

const agentRunFromRow = (r: AgentRunRow): AgentRunRecord => ({
  id: r.id,
  recommendationId: r.recommendation_id,
  findingId: r.finding_id,
  agentId: r.agent_id,
  runId: r.run_id,
  agentUrl: r.agent_url,
  repo: r.repo,
  status: r.status,
  prUrl: r.pr_url,
  lastError: r.last_error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export async function listAgentRuns(db: Queryable, recommendationIds: string[]): Promise<AgentRunRecord[]> {
  if (!recommendationIds.length) return [];
  const { rows } = await db.query<AgentRunRow>(
    'SELECT * FROM agent_runs WHERE recommendation_id = ANY($1) ORDER BY started_at',
    [recommendationIds],
  );
  return rows.map(agentRunFromRow);
}

export type PollOutcome = 'running' | 'finished' | 'failed' | 'timed_out' | 'already_done' | 'not_found' | 'not_configured';

const prNumber = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? '';

function outcomeText(run: AgentRunRow): string {
  const agent = `<${run.agent_url}|agent>`;
  if (run.status === 'finished') {
    return run.pr_url
      ? `Agent finished · <${run.pr_url}|PR${prNumber(run.pr_url) ? ` #${prNumber(run.pr_url)}` : ''}> ready for review`
      : `Agent finished without a pull request · ${agent}`;
  }
  if (run.status === 'timed_out') return `Agent is still running after the time limit; Patcher stopped watching it · ${agent}`;
  return `Agent failed: ${escapeMrkdwn(clip(run.last_error ?? 'unknown error', 160))} · ${agent}`;
}

/**
 * Cursor's v1 API has no webhooks, so the worker asks once a minute until the run ends or
 * the time limit passes. The outcome goes to the thread of the recommendation that started
 * the agent, once.
 */
export async function pollAgentRun(deps: WorkerDeps, agentRunId: string, now: Date = new Date()): Promise<PollOutcome> {
  const { rows } = await deps.pool.query<AgentRunRow>('SELECT * FROM agent_runs WHERE id = $1', [agentRunId]);
  let run = rows[0];
  if (!run) return 'not_found';

  if (run.status === 'running') {
    const cursor = deps.integrations.cursor;
    if (!cursor) return 'not_configured';
    const limitMinutes = await getSetting(deps.pool, 'audit.agent_timeout_minutes');
    let next: { status: AgentRunRow['status']; prUrl: string | null; result: string | null; error: string | null } | undefined;
    try {
      const state = await cursor.getRun(run.agent_id, run.run_id);
      if (TERMINAL_RUN_STATUSES.has(state.status)) {
        const branch =
          state.branches.find((b) => b.prUrl && b.repoUrl.toLowerCase().endsWith(run!.repo)) ?? state.branches.find((b) => b.prUrl);
        next =
          state.status === 'FINISHED'
            ? { status: 'finished', prUrl: branch?.prUrl ?? null, result: state.result, error: null }
            : { status: 'failed', prUrl: branch?.prUrl ?? null, result: state.result, error: `The run ended as ${state.status}.` };
      }
    } catch (err) {
      // A failed poll is not a failed agent. Keep asking until the time limit.
      deps.log.warn('agent poll failed', { agentRunId, err });
    }
    if (!next && now.getTime() - run.started_at.getTime() > limitMinutes * 60_000) {
      next = { status: 'timed_out', prUrl: null, result: null, error: `No result after ${limitMinutes} minutes.` };
    }
    if (!next) {
      await deps.pool.query('UPDATE agent_runs SET last_polled_at = $2 WHERE id = $1', [agentRunId, now]);
      await deps.queue.enqueue('agent.poll', { agentRunId }, { startAfter: POLL_SECONDS });
      return 'running';
    }
    const finished = next;
    run = await withTx(deps.pool, async (tx) => {
      const updated = await tx.query<AgentRunRow>(
        `UPDATE agent_runs
            SET status = $2, pr_url = $3, result = $4, last_error = $5, finished_at = $6, last_polled_at = $6
          WHERE id = $1 AND status = 'running'
          RETURNING *`,
        [agentRunId, finished.status, finished.prUrl, finished.result ? redact(finished.result).slice(0, 2000) : null, finished.error, now],
      );
      const row = updated.rows[0];
      if (!row) return undefined;
      if (row.finding_id && row.pr_url) {
        await tx.query('UPDATE audit_findings SET pr_url = $2 WHERE id = $1', [row.finding_id, row.pr_url]);
      }
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: `agent.${finished.status}`,
        target: row.recommendation_id,
        after: { agentId: row.agent_id, repo: row.repo, prUrl: row.pr_url, error: row.last_error },
      });
      return row;
    });
    if (!run) return 'already_done';
  }

  if (run.reported_at) return 'already_done';
  const rec = await getRecommendation(deps.pool, run.recommendation_id);
  if (rec?.slackChannel && rec.slackTs) {
    try {
      await deps.slack.postMessage({
        channel: rec.slackChannel,
        threadTs: rec.slackTs,
        text: `${await threadPrefix(deps, rec)}${outcomeText(run)}`,
      });
      await renderRecommendation(deps, rec);
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.retryable) throw err;
      deps.log.warn('could not report agent outcome to slack', { agentRunId, code: err.code });
    }
  }
  await deps.pool.query('UPDATE agent_runs SET reported_at = now() WHERE id = $1', [agentRunId]);
  return run.status === 'running' ? 'already_done' : run.status;
}
