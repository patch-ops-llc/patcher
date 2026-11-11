import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { markError, markOk } from '../integrations/status.js';
import { getSetting } from '../settings/settings.js';
import type { WorkerDeps } from '../worker/deps.js';
import { snapshotOf } from './catalog.js';
import type { RoomSnapshot } from './types.js';

type SyncDeps = Pick<WorkerDeps, 'pool' | 'queue' | 'integrations' | 'log'>;

/**
 * The `dealroom.sync` schedule. It only reads.
 *
 *   - Pull request route: looks at each deal room pull request Patcher opened and is still
 *     open, and records when a person merged or closed it. Merging and closing stay with
 *     people in GitHub.
 *   - Service API route: looks at each room that holds a draft Patcher wrote, or files that
 *     are waiting, and records what a person did to it in the deal room: published it,
 *     closed it, or changed who can open it. Only rooms at the address that is in Settings
 *     now are read, so the token never goes to an address that was replaced.
 */
export async function syncDealRoom(deps: SyncDeps): Promise<string> {
  if (await getSetting(deps.pool, 'paused')) return 'Skipped: paused.';
  const parts = [await syncPullRequests(deps), await syncRooms(deps)].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : 'Skipped: no deal room route is configured on the worker.';
}

async function syncPullRequests(deps: SyncDeps): Promise<string | null> {
  const adapter = deps.integrations.dealRoom;
  if (!adapter) return null;
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

const sameRoom = (a: RoomSnapshot | null, b: RoomSnapshot): boolean =>
  a !== null && a.status === b.status && a.slug === b.slug && a.members === b.members && a.invites === b.invites && a.domains === b.domains;

async function syncRooms(deps: SyncDeps): Promise<string | null> {
  const adapter = deps.integrations.dealRoomApi;
  if (!adapter) return null;
  const origin = await getSetting(deps.pool, 'sales.dealroom_url');
  if (!origin) return null;
  const { rows } = await deps.pool.query<{ id: string; room_id: string; status: 'draft_written' | 'held'; room: RoomSnapshot | null; call_id: string | null }>(
    `SELECT u.id, u.room_id, u.status, u.room, p.call_id
       FROM deal_room_updates u JOIN proposals p ON p.id = u.proposal_id
      WHERE u.route = 'api' AND u.status IN ('draft_written', 'held') AND u.room_id IS NOT NULL AND u.origin = $1
      ORDER BY u.updated_at LIMIT 50`,
    [origin],
  );
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    let room;
    try {
      room = await adapter.check(origin, row.room_id);
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn('deal room not read', { updateId: row.id, reason });
      await markError(deps.pool, 'dealroom_api', reason);
      continue;
    }
    let status: string = row.status;
    let error: string | null = null;
    if (!room) {
      status = 'closed';
      error = 'The room no longer exists in the deal room.';
    } else if (row.status === 'draft_written' && room.status === 'ACTIVE') {
      // A person published it in the deal room admin.
      status = 'published';
    } else if (row.status === 'draft_written' && room.status !== 'DRAFT') {
      status = 'closed';
      error = `The room was set to ${room.status} in the deal room.`;
    }
    const snapshot = room ? snapshotOf(room) : row.room;
    if (status === row.status && (!snapshot || sameRoom(row.room, snapshot))) continue;
    const updated = await deps.pool.query(
      `UPDATE deal_room_updates SET status = $2, room = $3, error = COALESCE($4, error), updated_at = now() WHERE id = $1 AND status = $5`,
      [row.id, status, snapshot ? JSON.stringify(snapshot) : null, error, row.status],
    );
    if (!updated.rowCount) continue;
    changed += 1;
    if (status !== row.status) {
      await recordAudit(deps.pool, {
        actor: SYSTEM_ACTOR,
        action: status === 'published' ? 'dealroom.api.published_elsewhere' : 'dealroom.api.closed',
        target: row.id,
        before: { status: row.status },
        after: { status, room: room?.status ?? null },
      });
    }
    // The message is drawn again: what it says about who can open the room has changed.
    if (row.call_id) await deps.queue.enqueue('sales.post', { callId: row.call_id });
  }
  if (rows.length && !failed) await markOk(deps.pool, 'dealroom_api');
  return `${rows.length} ${rows.length === 1 ? 'room' : 'rooms'} read, ${changed} changed${failed ? `, ${failed} not read` : ''}`;
}
