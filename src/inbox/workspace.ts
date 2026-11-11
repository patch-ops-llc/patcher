import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Enqueuer } from '../queue/queue.js';
import { getSetting } from '../settings/settings.js';
import { SlackApiError } from '../slack/client.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { conversationFilter, receiveCaptured } from './capture.js';
import type { ReaderChannel, ReaderGrant, SlackReader } from './reader.js';
import { tokenGone } from './reader.js';
import { fromSlackMessage } from './slackEvents.js';
import { forgetWorkspaceContent, getWorkspace, isUuid, sealedToken } from './store.js';
import type { Workspace } from './types.js';

/**
 * The connection to the workspace that is read through the app: the reader's token, what
 * happens when Slack takes it away, names, and catching up after a gap.
 */

/** Stores what Slack granted. The token arrives already sealed: the public service cannot open it again. */
export async function saveGrant(pool: Pool, grant: Omit<ReaderGrant, 'token'> & { sealedToken: string }, actor: Actor): Promise<{ id: string; reconnected: boolean; lastEventAt: Date | null }> {
  return withTx(pool, async (tx) => {
    const before = await tx.query<{ id: string; status: string; last_event_at: Date | null }>(
      'SELECT id, status, last_event_at FROM slack_workspaces WHERE team_id = $1 FOR UPDATE',
      [grant.teamId],
    );
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO slack_workspaces (team_id, name, enabled, read_mode, reader_user_id, user_token_ct, token_scopes, status, updated_by)
       VALUES ($1, $2, true, 'api', $3, $4, $5, 'connected', $6)
       ON CONFLICT (team_id) DO UPDATE
         SET read_mode = 'api', enabled = true, reader_user_id = EXCLUDED.reader_user_id, user_token_ct = EXCLUDED.user_token_ct,
             token_scopes = EXCLUDED.token_scopes, status = 'connected', status_detail = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id`,
      [grant.teamId, grant.teamName ?? 'PatchOps', grant.userId, grant.sealedToken, grant.scopes.join(','), actor],
    );
    const id = rows[0]!.id;
    await recordAudit(tx, { actor, action: 'inbox.workspace.connect', target: id, after: { teamId: grant.teamId, reader: grant.userId, scopes: grant.scopes.length } });
    return { id, reconnected: Boolean(before.rows[0]), lastEventAt: before.rows[0]?.last_event_at ?? null };
  });
}

/** A client for the workspace's reader, or null when there is no token or no key to open it with. */
export async function openReader(deps: Pick<WorkerDeps, 'pool' | 'secrets' | 'integrations' | 'log'>, workspace: Pick<Workspace, 'id' | 'readMode' | 'status'>): Promise<SlackReader | null> {
  if (workspace.readMode !== 'api' || workspace.status !== 'connected' || !deps.secrets) return null;
  const sealed = await sealedToken(deps.pool, workspace.id);
  if (!sealed) return null;
  try {
    return deps.integrations.slackReader(deps.secrets.open(sealed));
  } catch (err) {
    deps.log.warn('reader token could not be opened', { workspaceId: workspace.id, err });
    return null;
  }
}

/**
 * Slack no longer accepts the token (design 13.1). Reading stops, the token is forgotten,
 * and one line in the errors channel says how to connect again.
 */
export async function markDisconnected(deps: WorkerDeps, workspaceId: string, detail: string): Promise<boolean> {
  const { rows } = await deps.pool.query<{ name: string }>(
    `UPDATE slack_workspaces SET status = 'disconnected', status_detail = $2, user_token_ct = NULL, updated_at = now()
      WHERE id = $1 AND status = 'connected' RETURNING name`,
    [workspaceId, detail.slice(0, 200)],
  );
  if (!rows[0]) return false;
  await recordAudit(deps.pool, { actor: SYSTEM_ACTOR, action: 'inbox.workspace.disconnect', target: workspaceId, after: { detail: detail.slice(0, 200) } });
  await notifyOps(deps, `Slack reading stopped for ${rows[0].name}: ${detail} <${deps.appBaseUrl}/inbox|Connect again>`);
  return true;
}

/** Runs something with the reader and sorts a dead token from every other failure. Null: it could not be done. */
export async function withReader<T>(deps: WorkerDeps, workspace: Pick<Workspace, 'id' | 'readMode' | 'status'>, what: string, fn: (reader: SlackReader) => Promise<T>): Promise<T | null> {
  const reader = await openReader(deps, workspace);
  if (!reader) return null;
  try {
    return await fn(reader);
  } catch (err) {
    if (tokenGone(err)) {
      await markDisconnected(deps, workspace.id, 'Slack no longer accepts the authorisation.');
      return null;
    }
    if (err instanceof SlackApiError) {
      deps.log.warn(`slack reader: ${what} failed`, { workspaceId: workspace.id, code: err.code });
      return null;
    }
    throw err;
  }
}

/** After connecting: confirms the token works and learns the workspace's address, which links are built from. */
export async function checkWorkspace(deps: WorkerDeps, workspaceId: string): Promise<'ok' | 'skipped' | 'mismatch' | 'failed'> {
  const workspace = await getWorkspace(deps.pool, workspaceId);
  if (!workspace) return 'skipped';
  const identity = await withReader(deps, workspace, 'auth.test', (reader) => reader.identity());
  if (!identity) return 'failed';
  if (identity.teamId !== workspace.teamId || identity.userId !== workspace.readerUserId) {
    await markDisconnected(deps, workspace.id, 'The authorisation is for another workspace or person.');
    return 'mismatch';
  }
  await deps.pool.query(
    `UPDATE slack_workspaces SET domain = coalesce($2, domain), name = coalesce($3, name), updated_at = now()
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM slack_workspaces o WHERE o.domain = $2 AND o.id <> $1)`,
    [workspace.id, identity.domain, identity.teamName],
  );
  return 'ok';
}

/** A workspace was switched off: the token is revoked at Slack and forgotten. Stored messages went with the switch. */
export async function workspaceOff(deps: WorkerDeps, workspaceId: string, requestedBy: string): Promise<void> {
  const workspace = await getWorkspace(deps.pool, workspaceId);
  if (!workspace || workspace.enabled) return;
  const reader = await openReader(deps, workspace);
  if (reader) {
    try {
      await reader.revoke();
    } catch (err) {
      deps.log.warn('reader token could not be revoked', { workspaceId, code: err instanceof SlackApiError ? err.code : 'error' });
    }
  }
  await withTx(deps.pool, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE slack_workspaces SET user_token_ct = NULL, status = CASE WHEN read_mode = 'api' THEN 'disconnected' ELSE status END,
              status_detail = CASE WHEN read_mode = 'api' THEN 'Switched off.' ELSE status_detail END, updated_at = now()
        WHERE id = $1 AND NOT enabled`,
      [workspaceId],
    );
    if (!rowCount) return;
    await forgetWorkspaceContent(tx, workspaceId);
    await recordAudit(tx, { actor: requestedBy, action: 'inbox.workspace.forget', target: workspaceId, after: { tokenRevoked: Boolean(reader) } });
  });
}

/** Slack's `tokens_revoked` event: the reader removed the authorisation, or an admin did. */
export async function handleTokensRevoked(deps: WorkerDeps, teamId: string | undefined, event: Record<string, unknown>): Promise<void> {
  const tokens = event.tokens && typeof event.tokens === 'object' ? (event.tokens as Record<string, unknown>) : {};
  const users = Array.isArray(tokens.oauth) ? tokens.oauth.filter((u): u is string => typeof u === 'string') : [];
  if (!teamId || !users.length) return;
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM slack_workspaces WHERE team_id = $1 AND reader_user_id = ANY($2) AND status = 'connected'`,
    [teamId, users],
  );
  for (const row of rows) await markDisconnected(deps, row.id, 'The authorisation was removed in Slack.');
}

// Names --------------------------------------------------------------------------------------------

const NAME_TTL_DAYS = 7;
const MAX_LOOKUPS = 12;

async function cached(db: Queryable, workspaceId: string, kind: 'user' | 'channel', ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ external_id: string; name: string }>(
    `SELECT external_id, name FROM slack_names
      WHERE workspace_id = $1 AND kind = $2 AND external_id = ANY($3) AND fetched_at > now() - make_interval(days => $4)`,
    [workspaceId, kind, ids, NAME_TTL_DAYS],
  );
  return new Map(rows.map((r) => [r.external_id, r.name]));
}

const remember = (db: Queryable, workspaceId: string, kind: 'user' | 'channel', id: string, name: string) =>
  db.query(
    `INSERT INTO slack_names (workspace_id, kind, external_id, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, kind, external_id) DO UPDATE SET name = EXCLUDED.name, fetched_at = now()`,
    [workspaceId, kind, id, name.slice(0, 120)],
  );

/**
 * Display names for the people and the channel of a bundle. Events carry ids only; the
 * reader's token looks a name up once and it is kept for a week. Without a reader, or when
 * a lookup fails, the item simply names nobody.
 */
export async function resolveNames(
  deps: WorkerDeps,
  workspace: Workspace,
  reader: SlackReader | null,
  wanted: { userIds: string[]; channelId: string | null },
): Promise<{ users: Map<string, string>; channelName: string | null }> {
  const userIds = [...new Set(wanted.userIds)].filter((id) => id !== workspace.readerUserId);
  const users = await cached(deps.pool, workspace.id, 'user', userIds);
  const channels = await cached(deps.pool, workspace.id, 'channel', wanted.channelId ? [wanted.channelId] : []);
  let channelName = wanted.channelId ? (channels.get(wanted.channelId) ?? null) : null;
  if (!reader) return { users, channelName };
  try {
    for (const id of userIds.filter((u) => !users.has(u)).slice(0, MAX_LOOKUPS)) {
      const name = await reader.userName(id);
      if (!name) continue;
      users.set(id, name);
      await remember(deps.pool, workspace.id, 'user', id, name);
    }
    if (wanted.channelId && !channelName && !wanted.channelId.startsWith('D')) {
      const channel = await reader.channel(wanted.channelId);
      if (channel?.name) {
        channelName = channel.name;
        await remember(deps.pool, workspace.id, 'channel', wanted.channelId, channel.name);
      }
    }
  } catch (err) {
    if (tokenGone(err)) await markDisconnected(deps, workspace.id, 'Slack no longer accepts the authorisation.');
    else if (err instanceof SlackApiError) deps.log.warn('slack reader: name lookup failed', { workspaceId: workspace.id, code: err.code });
    else throw err;
  }
  return { users, channelName };
}

// Catching up --------------------------------------------------------------------------------------

export const MAX_BACKFILL_HOURS = 72;
const CHANNELS_PER_JOB = 30;
const PAGES_PER_CHANNEL = 3;
const THREADS_PER_CHANNEL = 15;
/** Slack stops retrying an event after a few minutes, so a longer silence may hide a gap. */
export const GAP_MINUTES = 10;

export type BackfillRequest = 'started' | 'running' | 'not_connected';

/** Asks the worker to read history since a point in time. One catch-up runs per workspace at a time. */
export async function requestBackfill(
  deps: { pool: Pool; queue: Enqueuer },
  input: { workspaceId: string; since: Date; reason: string; requestedBy: string },
): Promise<BackfillRequest> {
  if (!isUuid(input.workspaceId)) return 'not_connected';
  return withTx(deps.pool, async (tx) => {
    const workspace = await tx.query(
      `SELECT 1 FROM slack_workspaces WHERE id = $1 AND read_mode = 'api' AND status = 'connected' AND enabled FOR UPDATE`,
      [input.workspaceId],
    );
    if (!workspace.rowCount) return 'not_connected';
    const running = await tx.query(
      `SELECT 1 FROM slack_backfills WHERE workspace_id = $1 AND status = 'running' AND created_at > now() - interval '2 hours'`,
      [input.workspaceId],
    );
    if (running.rowCount) return 'running';
    const floor = new Date(Date.now() - MAX_BACKFILL_HOURS * 60 * 60 * 1000);
    const since = input.since < floor ? floor : input.since;
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO slack_backfills (workspace_id, since, reason, requested_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.workspaceId, since, input.reason, input.requestedBy],
    );
    await deps.queue.enqueue('inbox.backfill', { backfillId: rows[0]!.id }, { tx });
    return 'started';
  });
}

/** At boot of the public service: a workspace that has heard nothing from Slack for a while may have missed events. */
export async function backfillAfterGap(deps: { pool: Pool; queue: Enqueuer }): Promise<number> {
  if (!(await getSetting(deps.pool, 'inbox.enabled'))) return 0;
  const { rows } = await deps.pool.query<{ id: string; last_event_at: Date }>(
    `SELECT id, last_event_at FROM slack_workspaces
      WHERE read_mode = 'api' AND status = 'connected' AND enabled AND last_event_at IS NOT NULL
        AND last_event_at < now() - make_interval(mins => $1)`,
    [GAP_MINUTES],
  );
  let started = 0;
  for (const row of rows) {
    const outcome = await requestBackfill(deps, { workspaceId: row.id, since: row.last_event_at, reason: 'gap', requestedBy: SYSTEM_ACTOR });
    if (outcome === 'started') started += 1;
  }
  return started;
}

export type BackfillOutcome = 'not_found' | 'done' | 'more' | 'failed' | 'waiting';

const slackTs = (at: Date): string => `${Math.floor(at.getTime() / 1000)}.000000`;

/**
 * One step of a catch-up: a page of the reader's conversations, the history of each since
 * the gap began, and the replies of threads that got new ones. Every message goes through
 * `receiveCaptured`, so the filter, the dedupe and the bundling are the ones events get.
 */
export async function runBackfill(deps: WorkerDeps, backfillId: string): Promise<BackfillOutcome> {
  const { rows } = await deps.pool.query<{ id: string; workspace_id: string; since: Date; cursor: string | null; status: string }>(
    'SELECT id, workspace_id, since, cursor, status FROM slack_backfills WHERE id = $1',
    [backfillId],
  );
  const job = rows[0];
  if (!job || job.status !== 'running') return 'not_found';
  const finish = async (status: 'done' | 'failed', error: string | null) => {
    await deps.pool.query('UPDATE slack_backfills SET status = $2, error = $3, finished_at = now() WHERE id = $1', [backfillId, status, error]);
    return status;
  };
  const workspace = await getWorkspace(deps.pool, job.workspace_id);
  if (!workspace?.enabled || !(await getSetting(deps.pool, 'inbox.enabled'))) return finish('failed', 'Reading is switched off.');
  const reader = await openReader(deps, workspace);
  if (!reader) return finish('failed', 'The workspace is not connected.');

  const oldest = slackTs(job.since);
  const switches = { id: workspace.id, team_id: workspace.teamId, read_dms: workspace.readDms, channel_default: workspace.channelDefault };
  let channels = 0;
  let stored = 0;
  const take = async (channel: ReaderChannel, raw: Parameters<typeof fromSlackMessage>[2]) => {
    const converted = fromSlackMessage(workspace, channel, raw);
    if (converted.kind !== 'message') return;
    const outcome = await receiveCaptured(deps, converted.message);
    if (outcome === 'stored' || outcome === 'own') stored += 1;
  };

  try {
    const page = await reader.conversations(job.cursor, CHANNELS_PER_JOB);
    for (const channel of page.channels) {
      if (await conversationFilter(deps.pool, switches, channel)) continue;
      channels += 1;
      let cursor: string | null = null;
      let threads = 0;
      for (let i = 0; i < PAGES_PER_CHANNEL; i += 1) {
        const history = await reader.history(channel.id, { oldest, cursor });
        // Slack returns the newest first; the pipeline wants them in the order they were written.
        for (const raw of [...history.messages].reverse()) {
          await take(channel, raw);
          const latest = typeof raw.latest_reply === 'string' ? raw.latest_reply : null;
          if (typeof raw.ts === 'string' && latest && latest > oldest && threads < THREADS_PER_CHANNEL) {
            threads += 1;
            const replies = await reader.replies(channel.id, raw.ts, 100);
            for (const reply of replies) if (typeof reply.ts === 'string' && reply.ts !== raw.ts && reply.ts > oldest) await take(channel, reply);
          }
        }
        cursor = history.next;
        if (!cursor) break;
      }
    }
    await deps.pool.query('UPDATE slack_backfills SET cursor = $2, channels = channels + $3, messages = messages + $4 WHERE id = $1', [
      backfillId,
      page.next,
      channels,
      stored,
    ]);
    if (page.next) {
      await deps.queue.enqueue('inbox.backfill', { backfillId }, { startAfter: 2 });
      return 'more';
    }
    await finish('done', null);
    return 'done';
  } catch (err) {
    if (tokenGone(err)) {
      await markDisconnected(deps, workspace.id, 'Slack no longer accepts the authorisation.');
      return finish('failed', 'Slack no longer accepts the authorisation.');
    }
    if (err instanceof SlackApiError && err.code === 'rate_limited') {
      // The page is read again from its start; what was stored already is skipped as a duplicate.
      await deps.pool.query('UPDATE slack_backfills SET channels = channels + $2, messages = messages + $3 WHERE id = $1', [backfillId, 0, stored]);
      await deps.queue.enqueue('inbox.backfill', { backfillId }, { startAfter: Math.min(Math.max(err.retryAfterSeconds ?? 30, 5), 300) });
      return 'waiting';
    }
    if (err instanceof SlackApiError && !err.retryable) return finish('failed', `Slack refused: ${err.code}`);
    throw err;
  }
}

export interface BackfillRow {
  since: Date;
  reason: string;
  status: 'running' | 'done' | 'failed';
  channels: number;
  messages: number;
  error: string | null;
  createdAt: Date;
}

export async function lastBackfill(db: Queryable, workspaceId: string): Promise<BackfillRow | null> {
  const { rows } = await db.query<{ since: Date; reason: string; status: BackfillRow['status']; channels: number; messages: number; error: string | null; created_at: Date }>(
    'SELECT since, reason, status, channels, messages, error, created_at FROM slack_backfills WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1',
    [workspaceId],
  );
  const r = rows[0];
  return r ? { since: r.since, reason: r.reason, status: r.status, channels: r.channels, messages: r.messages, error: r.error, createdAt: r.created_at } : null;
}
