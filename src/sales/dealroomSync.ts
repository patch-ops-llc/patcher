import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { markError, markOk } from '../integrations/status.js';
import { getSetting } from '../settings/settings.js';
import type { WorkerDeps } from '../worker/deps.js';

/**
 * The `dealroom.sync` schedule. Looks at each deal room pull request Patcher opened and is
 * still open, and records when a person merged or closed it, so the sales message says so.
 * It only reads: merging and closing stay with people in GitHub.
 */
export async function syncDealRoom(deps: Pick<WorkerDeps, 'pool' | 'queue' | 'integrations' | 'log'>): Promise<string> {
  if (await getSetting(deps.pool, 'paused')) return 'Skipped: paused.';
  const adapter = deps.integrations.dealRoom;
  if (!adapter) return 'Skipped: the deal room GitHub App is not configured.';
  const { rows } = await deps.pool.query<{ id: string; repo: string | null; pr_number: number | null; call_id: string | null }>(
    `SELECT u.id, u.repo, u.pr_number, p.call_id
       FROM deal_room_updates u JOIN proposals p ON p.id = u.proposal_id
      WHERE u.status = 'pr_open' AND u.route = $1
      ORDER BY u.updated_at LIMIT 50`,
    [adapter.route],
  );
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.repo) continue;
    let state: 'open' | 'merged' | 'closed' | null;
    try {
      state = await adapter.check(row.repo, { prNumber: row.pr_number });
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn('deal room pull request not read', { updateId: row.id, reason });
      await markError(deps.pool, 'dealroom', reason);
      continue;
    }
    if (state !== 'merged' && state !== 'closed') continue;
    const updated = await deps.pool.query(`UPDATE deal_room_updates SET status = $2, updated_at = now() WHERE id = $1 AND status = 'pr_open'`, [row.id, state]);
    if (!updated.rowCount) continue;
    changed += 1;
    await recordAudit(deps.pool, { actor: SYSTEM_ACTOR, action: `dealroom.pr.${state}`, target: row.id, before: { status: 'pr_open' }, after: { status: state } });
    if (row.call_id) await deps.queue.enqueue('sales.post', { callId: row.call_id });
  }
  if (rows.length && !failed) await markOk(deps.pool, 'dealroom');
  return `${rows.length} open, ${changed} changed${failed ? `, ${failed} not read` : ''}`;
}
