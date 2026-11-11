import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool } from '../db/pool.js';
import { isConfigured } from '../integrations/status.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Queryable } from '../db/pool.js';
import { getSetting, isPaused } from '../settings/settings.js';

/** A run still marked running after this long was interrupted. */
export const STALE_RUN_MINUTES = 90;
/** How long past its allowed wait a run may sit in analysis before it is taken for dead. */
const STALE_ANALYSIS_GRACE_MINUTES = 30;

/** How old a run waiting for the model can be before nothing will come of it. */
export async function staleAnalysisMinutes(db: Queryable): Promise<number> {
  return STALE_RUN_MINUTES + (await getSetting(db, 'ai.audit.wait_minutes')) + STALE_ANALYSIS_GRACE_MINUTES;
}

export type AuditRequest = { started: true } | { started: false; reason: string };

/**
 * "Run audit now", from the UI or `/ops audit now`. The public service only asks; the worker
 * runs it. Refused while paused, like every other pipeline.
 */
export async function requestAudit(deps: { pool: Pool; queue: Enqueuer }, actor: Actor): Promise<AuditRequest> {
  if (await isPaused(deps.pool)) return { started: false, reason: 'Patcher is paused, so no audit was started.' };
  if (!(await isConfigured(deps.pool, 'railway'))) {
    return { started: false, reason: 'Railway is not configured: RAILWAY_API_TOKEN is not set on the worker.' };
  }
  const running = await deps.pool.query(
    `SELECT 1 FROM audit_runs WHERE status = 'running' AND started_at > now() - make_interval(mins => $1) LIMIT 1`,
    [STALE_RUN_MINUTES],
  );
  if (running.rowCount) return { started: false, reason: 'An audit is already running.' };
  const analyzing = await deps.pool.query(
    `SELECT 1 FROM audit_runs WHERE status = 'analyzing' AND started_at > now() - make_interval(mins => $1) LIMIT 1`,
    [await staleAnalysisMinutes(deps.pool)],
  );
  if (analyzing.rowCount) {
    return { started: false, reason: 'The last audit is still waiting for the model. Its report follows; start another after that.' };
  }
  await deps.queue.enqueue('audit.run', { trigger: 'manual', requestedBy: actor });
  await recordAudit(deps.pool, { actor, action: 'audit.run_now' });
  return { started: true };
}
