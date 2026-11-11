import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool } from '../db/pool.js';
import { isConfigured } from '../integrations/status.js';
import type { Enqueuer } from '../queue/queue.js';
import { isPaused } from '../settings/settings.js';

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
    `SELECT 1 FROM audit_runs WHERE status = 'running' AND started_at > now() - interval '90 minutes' LIMIT 1`,
  );
  if (running.rowCount) return { started: false, reason: 'An audit is already running.' };
  await deps.queue.enqueue('audit.run', { trigger: 'manual', requestedBy: actor });
  await recordAudit(deps.pool, { actor, action: 'audit.run_now' });
  return { started: true };
}
