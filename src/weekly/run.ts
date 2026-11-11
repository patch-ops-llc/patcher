import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Actor } from '../audit/auditLog.js';
import { withTx } from '../db/pool.js';
import type { GitHubClient } from '../github/client.js';
import { markError, markOk } from '../integrations/status.js';
import { getSetting } from '../settings/settings.js';
import { customCheckResults, probeSummaries } from '../probes/run.js';
import { collectSnapshot } from '../railway/collect.js';
import { syncInventory } from '../railway/inventory.js';
import type { Checked, WorkspaceSnapshot } from '../railway/types.js';
import { checked, notChecked } from '../railway/types.js';
import type { WorkerDeps } from '../worker/deps.js';
import { completeAudit, startAnalysis, tryAuditLock } from './analyze.js';
import { buildServiceGroups } from './assess.js';
import type { CheckContext, RepoFacts } from './checks.js';
import { evaluate, projectScope, serviceScope } from './checks.js';
import type { TrackedFinding } from './findings.js';
import { rank, saveFindings } from './findings.js';
import type { AuditCounts, AuditReport } from './report.js';
import { RULES_NOTE, toReportFinding } from './report.js';
import { STALE_RUN_MINUTES, staleAnalysisMinutes } from './request.js';


const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * What GitHub knows about each service that deploys from a repository: how far its deployed
 * commit is behind the default branch, and open critical dependency alerts. One set of
 * requests per repository, however many services deploy from it.
 */
export async function collectRepoFacts(
  github: GitHubClient | null,
  snapshot: WorkspaceSnapshot,
): Promise<Checked<Map<string, Checked<RepoFacts>>>> {
  if (!github) return notChecked('the GitHub App is not configured');
  const facts = new Map<string, Checked<RepoFacts>>();
  const branches = new Map<string, Promise<Checked<string>>>();
  const alerts = new Map<string, Promise<Checked<number>>>();
  const attempt = async <T>(fn: () => Promise<T>): Promise<Checked<T>> => {
    try {
      return checked(await fn());
    } catch (err) {
      return notChecked(reasonOf(err));
    }
  };

  for (const service of snapshot.services) {
    const repo = service.repo?.toLowerCase();
    if (!repo) continue;
    if (!branches.has(repo)) branches.set(repo, attempt(() => github.defaultBranch(repo)));
    if (!alerts.has(repo)) alerts.set(repo, attempt(() => github.openCriticalAlerts(repo)));
    const branch = await branches.get(repo)!;
    if (!branch.ok) {
      facts.set(serviceScope(service.environmentId, service.serviceId), notChecked(branch.reason));
      continue;
    }
    const commit = service.commitHash;
    facts.set(
      serviceScope(service.environmentId, service.serviceId),
      checked({
        defaultBranch: branch.value,
        behindBy: commit
          ? await attempt(() => github.commitsAhead(repo, commit, branch.value))
          : notChecked('the deployed commit is not known'),
        criticalAlerts: await alerts.get(repo)!,
      }),
    );
  }
  return checked(facts);
}

export function countFindings(snapshot: WorkspaceSnapshot, open: TrackedFinding[], other: { muted: number; accepted: number; resolved: number }): AuditCounts {
  const troubled = new Set<string>();
  for (const f of open) {
    if (f.severity !== 'info' && f.scope.serviceId) troubled.add(serviceScope(f.scope.environmentId ?? '', f.scope.serviceId));
  }
  return {
    projects: snapshot.projects.length,
    services: snapshot.services.length,
    critical: open.filter((f) => f.severity === 'critical').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    healthy: snapshot.services.filter((s) => !troubled.has(serviceScope(s.environmentId, s.serviceId))).length,
    ...other,
  };
}

export interface AuditOutcome {
  runId: string | null;
  summary: string;
}

/**
 * The weekly audit (design section 7): read the workspace through Railway's API, evaluate the
 * checks and match findings against earlier weeks. That is the evidence. The model steps in
 * `analyze.ts` then assess, rank and word it; where they cannot run, the rules' own ranking
 * and wording go out instead. Everything done at Railway is a read; the only thing the audit
 * can start is a recommendation, which does nothing until a person approves it.
 */
export async function runAudit(
  deps: WorkerDeps,
  trigger: 'schedule' | 'manual',
  requestedBy: Actor = SYSTEM_ACTOR,
  now: Date = new Date(),
): Promise<AuditOutcome> {
  const railway = deps.integrations.railway;
  if (!railway) return { runId: null, summary: 'Skipped: Railway is not configured (RAILWAY_API_TOKEN).' };

  const unlock = await tryAuditLock(deps.pool);
  if (!unlock) return { runId: null, summary: 'Skipped: another audit is still running.' };
  let runId: string | null = null;
  try {
    // A run that never finished (the worker was restarted mid-audit) would otherwise show as running forever.
    await deps.pool.query(
      `UPDATE audit_runs SET status = 'failed', finished_at = now(), error = 'Interrupted before it finished.'
        WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
      [STALE_RUN_MINUTES],
    );
    // The same for a run whose analysis never came back and whose poll has stopped.
    await deps.pool.query(
      `UPDATE audit_runs SET status = 'failed', finished_at = now(), analysis = NULL, error = 'The analysis never finished.'
        WHERE status = 'analyzing' AND started_at < now() - make_interval(mins => $1)`,
      [await staleAnalysisMinutes(deps.pool)],
    );
    const waiting = await deps.pool.query(`SELECT 1 FROM audit_runs WHERE status = 'analyzing' LIMIT 1`);
    if (waiting.rowCount) return { runId: null, summary: 'Skipped: the last audit is still waiting for its analysis.' };

    const created = await deps.pool.query<{ id: string }>(
      'INSERT INTO audit_runs (trigger, started_at) VALUES ($1, $2) RETURNING id',
      [trigger, now],
    );
    runId = created.rows[0]!.id;
    const log = deps.log.child({ auditRunId: runId });
    await recordAudit(deps.pool, { actor: requestedBy, action: 'audit.start', target: runId, after: { trigger } });

    let collected;
    try {
      collected = await collectSnapshot(railway, { now, log });
      await markOk(deps.pool, 'railway');
    } catch (err) {
      await markError(deps.pool, 'railway', reasonOf(err));
      throw err;
    }
    const { snapshot, unread } = collected;

    const github = await collectRepoFacts(deps.integrations.github, snapshot);
    if (deps.integrations.github && github.ok) {
      const failures = [...github.value.values()].filter((f) => !f.ok);
      if (failures.length && failures.length === github.value.size) {
        await markError(deps.pool, 'github', failures[0]!.ok ? '' : failures[0]!.reason);
      } else {
        await markOk(deps.pool, 'github');
      }
    }

    const windowStart = new Date(snapshot.windowStart);
    const context: CheckContext = {
      now,
      snapshot,
      probes: await probeSummaries(deps.pool, windowStart),
      github,
      customChecks: await customCheckResults(deps.pool, windowStart),
    };
    const evaluation = evaluate(context);

    const liveScopes = new Set<string>([
      ...snapshot.services.map((s) => serviceScope(s.environmentId, s.serviceId)),
      ...snapshot.projects.map((p) => projectScope(p.id)),
      ...context.customChecks.map((c) => projectScope(c.projectId)),
    ]);
    // Where an environment could not be read, its services are not gone; they are unknown.
    if (unread.length) {
      const known = await deps.pool.query<{ environment_id: string; service_id: string }>(
        `SELECT environment_id, service_id FROM railway_inventory
          WHERE kind = 'instance' AND removed_at IS NULL AND environment_id = ANY($1)`,
        [unread.map((u) => u.environmentId)],
      );
      for (const row of known.rows) liveScopes.add(serviceScope(row.environment_id, row.service_id));
    }

    const saved = await withTx(deps.pool, async (tx) => {
      const inventory = await syncInventory(tx, snapshot, unread, now);
      const findings = await saveFindings(tx, {
        runId: runId!,
        now,
        drafts: evaluation.findings,
        checkedScopes: evaluation.checkedScopes,
        liveScopes,
      });
      return { inventory, findings };
    });

    const open = rank(saved.findings.tracked.filter((f) => f.state === 'open'));
    const counts = countFindings(snapshot, open, {
      muted: saved.findings.tracked.filter((f) => f.state === 'muted').length,
      accepted: saved.findings.tracked.filter((f) => f.state === 'accepted').length,
      resolved: saved.findings.resolved,
    });
    // What the rules established, in the rules' order. It is stored before any model is
    // asked, so the run's page shows the findings while the analysis is still out.
    const report: AuditReport = {
      version: 1,
      generatedAt: now.toISOString(),
      windowStart: snapshot.windowStart,
      windowDays: snapshot.windowDays,
      counts,
      findings: open.map((f) => toReportFinding(f, { status: 'none' })),
      top: [],
      inventory: saved.inventory,
      coverage: evaluation.coverage,
      unread,
      integrations: deps.integrations.status,
      railwayRequests: snapshot.requests,
    };
    await deps.pool.query(`UPDATE audit_runs SET counts = $2, report = $3 WHERE id = $1`, [
      runId,
      JSON.stringify(counts),
      JSON.stringify(report),
    ]);

    const tally = `${counts.critical} critical, ${counts.warning} warnings, ${counts.healthy} of ${counts.services} services healthy`;
    const groups = buildServiceGroups({
      snapshot,
      probes: context.probes,
      findings: open,
      logTokenCap: await getSetting(deps.pool, 'ai.audit.log_token_cap'),
    });
    const started = await startAnalysis(deps, runId, groups);
    if (started.waiting) {
      return { runId, summary: `${tally}; the report follows when the model's analysis is back` };
    }
    const { analysis } = await completeAudit(deps, runId, started.step);
    return { runId, summary: analysis.reason ? `${tally}; ${RULES_NOTE[analysis.reason]}` : tally };
  } catch (err) {
    if (runId) {
      await deps.pool
        .query(`UPDATE audit_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'running'`, [
          runId,
          reasonOf(err),
        ])
        .catch(() => undefined);
    }
    throw err;
  } finally {
    await unlock();
  }
}
