import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Recommendation, RecommendationRow } from '../recommendations/types.js';
import { recommendationFromRow } from '../recommendations/types.js';
import type {
  Bundle,
  BundleRow,
  ChannelRule,
  ChannelRuleRow,
  Digest,
  DigestRow,
  DismissReason,
  DropReason,
  Rule,
  StoredMessage,
  Workspace,
  WorkspaceRow,
} from './types.js';
import { INBOX_CARRIER, bundleFromRow, digestFromRow, ruleFromRow, workspaceFromRow } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

const WORKSPACE_COLUMNS = `id, team_id, domain, name, enabled, read_mode, read_dms, channel_default, project_id, reader_user_id,
  user_token_ct, status, status_detail, last_message_at, last_event_at`;

// Workspaces -----------------------------------------------------------------------------------

export async function listWorkspaces(db: Queryable): Promise<Workspace[]> {
  const { rows } = await db.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM slack_workspaces ORDER BY (read_mode = 'api') DESC, lower(name)`);
  return rows.map(workspaceFromRow);
}

export async function getWorkspace(db: Queryable, id: string): Promise<Workspace | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM slack_workspaces WHERE id = $1`, [id]);
  return rows[0] ? workspaceFromRow(rows[0]) : null;
}

export async function workspaceByTeam(db: Queryable, teamId: string): Promise<Workspace | null> {
  const { rows } = await db.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM slack_workspaces WHERE team_id = $1`, [teamId]);
  return rows[0] ? workspaceFromRow(rows[0]) : null;
}

export async function workspaceByDomain(db: Queryable, domain: string): Promise<Workspace | null> {
  const { rows } = await db.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM slack_workspaces WHERE domain = $1`, [domain.toLowerCase()]);
  return rows[0] ? workspaceFromRow(rows[0]) : null;
}

/** The sealed token of a workspace's reader. Only the worker can open it. */
export async function sealedToken(db: Queryable, workspaceId: string): Promise<string | null> {
  const { rows } = await db.query<{ user_token_ct: string | null }>('SELECT user_token_ct FROM slack_workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.user_token_ct ?? null;
}

export interface WorkspaceChange {
  enabled?: boolean;
  readDms?: boolean;
  channelDefault?: 'include' | 'exclude';
  projectId?: string | null;
  name?: string;
}

/**
 * Changes a workspace's switches. Switching it off deletes the messages stored for it in
 * the same transaction (design 8.7); the caller asks the worker to revoke and forget the token.
 */
export async function updateWorkspace(pool: Pool, id: string, change: WorkspaceChange, actor: Actor): Promise<{ changed: boolean; switchedOff: boolean }> {
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM slack_workspaces WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) return { changed: false, switchedOff: false };
    const before = workspaceFromRow(rows[0]);
    const after = {
      enabled: change.enabled ?? before.enabled,
      readDms: change.readDms ?? before.readDms,
      channelDefault: change.channelDefault ?? before.channelDefault,
      projectId: change.projectId === undefined ? before.projectId : change.projectId,
      name: change.name?.trim() || before.name,
    };
    const same =
      after.enabled === before.enabled &&
      after.readDms === before.readDms &&
      after.channelDefault === before.channelDefault &&
      after.projectId === before.projectId &&
      after.name === before.name;
    if (same) return { changed: false, switchedOff: false };
    await tx.query(
      `UPDATE slack_workspaces
          SET enabled = $2, read_dms = $3, channel_default = $4, project_id = $5, name = $6, updated_by = $7, updated_at = now()
        WHERE id = $1`,
      [id, after.enabled, after.readDms, after.channelDefault, after.projectId, after.name, actor],
    );
    const switchedOff = before.enabled && !after.enabled;
    if (switchedOff) await forgetWorkspaceContent(tx, id);
    await recordAudit(tx, {
      actor,
      action: 'inbox.workspace.update',
      target: id,
      before: { enabled: before.enabled, readDms: before.readDms, channelDefault: before.channelDefault, projectId: before.projectId },
      after: { enabled: after.enabled, readDms: after.readDms, channelDefault: after.channelDefault, projectId: after.projectId },
    });
    return { changed: true, switchedOff };
  });
}

/** Deletes what was stored about a workspace's messages. What Patcher itself recommended stays in the loop's record. */
export async function forgetWorkspaceContent(tx: Queryable, workspaceId: string): Promise<void> {
  await tx.query('DELETE FROM slack_messages WHERE workspace_id = $1', [workspaceId]);
  await tx.query(
    `UPDATE recommendations r
        SET status = 'expired', last_error = 'The workspace was switched off.', updated_at = now()
       FROM slack_bundles b
      WHERE b.recommendation_id = r.id AND b.workspace_id = $1 AND r.status IN ('drafted', 'posted')`,
    [workspaceId],
  );
  await tx.query(
    `UPDATE slack_bundles
        SET status = CASE WHEN status IN ('open', 'held') THEN 'dropped' ELSE status END,
            status_detail = CASE WHEN status IN ('open', 'held') THEN 'The workspace was switched off.' ELSE status_detail END,
            draft = NULL, quote = NULL, purged_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND purged_at IS NULL`,
    [workspaceId],
  );
  await tx.query('DELETE FROM slack_names WHERE workspace_id = $1', [workspaceId]);
}

// Channel rules --------------------------------------------------------------------------------

export const normalChannelName = (name: string): string => name.trim().replace(/^#/, '').toLowerCase();

export async function listRules(db: Queryable, workspaceId?: string): Promise<ChannelRule[]> {
  const { rows } = await db.query<ChannelRuleRow>(
    `SELECT id, workspace_id, channel_id, channel_name, rule, project_id FROM slack_channel_rules
      WHERE ($1::uuid IS NULL OR workspace_id = $1) ORDER BY created_at`,
    [workspaceId ?? null],
  );
  return rows.map(ruleFromRow);
}

/** The rule for a channel: by id where the message has one, else by name. */
export async function ruleFor(db: Queryable, workspaceId: string, channel: { id: string | null; name: string | null }): Promise<ChannelRule | null> {
  const { rows } = await db.query<ChannelRuleRow>(
    `SELECT id, workspace_id, channel_id, channel_name, rule, project_id FROM slack_channel_rules
      WHERE workspace_id = $1 AND (($2::text IS NOT NULL AND channel_id = $2) OR ($3::text IS NOT NULL AND lower(channel_name) = $3))
      ORDER BY (channel_id IS NOT NULL) DESC LIMIT 1`,
    [workspaceId, channel.id, channel.name ? normalChannelName(channel.name) : null],
  );
  return rows[0] ? ruleFromRow(rows[0]) : null;
}

export class RuleInputError extends Error {}

export async function saveRule(
  pool: Pool,
  input: { workspaceId: string; channel: string; rule: Rule; projectId: string | null },
  actor: Actor,
): Promise<void> {
  const raw = input.channel.trim();
  if (!raw) throw new RuleInputError('Name a channel: its ID (C…) or its name.');
  const isId = /^[CGD][A-Z0-9]{2,}$/.test(raw);
  const name = isId ? null : normalChannelName(raw);
  if (name !== null && !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(name)) throw new RuleInputError('That is not a channel name or a channel ID.');
  await withTx(pool, async (tx) => {
    const workspace = await tx.query('SELECT 1 FROM slack_workspaces WHERE id = $1', [input.workspaceId]);
    if (!workspace.rowCount) throw new RuleInputError('Unknown workspace.');
    if (isId) {
      await tx.query(
        `INSERT INTO slack_channel_rules (workspace_id, channel_id, rule, project_id, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, channel_id) WHERE channel_id IS NOT NULL
         DO UPDATE SET rule = EXCLUDED.rule, project_id = EXCLUDED.project_id, created_by = EXCLUDED.created_by`,
        [input.workspaceId, raw, input.rule, input.projectId, actor],
      );
    } else {
      await tx.query(
        `INSERT INTO slack_channel_rules (workspace_id, channel_name, rule, project_id, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, lower(channel_name)) WHERE channel_id IS NULL
         DO UPDATE SET rule = EXCLUDED.rule, project_id = EXCLUDED.project_id, created_by = EXCLUDED.created_by`,
        [input.workspaceId, name, input.rule, input.projectId, actor],
      );
    }
    await recordAudit(tx, { actor, action: 'inbox.rule.save', target: input.workspaceId, after: { channel: isId ? raw : name, rule: input.rule, projectId: input.projectId } });
  });
}

export async function removeRule(pool: Pool, ruleId: string, actor: Actor): Promise<boolean> {
  if (!isUuid(ruleId)) return false;
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<ChannelRuleRow>(
      'DELETE FROM slack_channel_rules WHERE id = $1 RETURNING id, workspace_id, channel_id, channel_name, rule, project_id',
      [ruleId],
    );
    if (!rows[0]) return false;
    await recordAudit(tx, { actor, action: 'inbox.rule.remove', target: rows[0].workspace_id, before: { channel: rows[0].channel_id ?? rows[0].channel_name, rule: rows[0].rule } });
    return true;
  });
}

// The triage log -------------------------------------------------------------------------------

export async function countDrop(db: Queryable, workspaceId: string, reason: DropReason): Promise<void> {
  await db.query(
    `INSERT INTO slack_drop_counts (workspace_id, day, reason, n) VALUES ($1, current_date, $2, 1)
     ON CONFLICT (workspace_id, day, reason) DO UPDATE SET n = slack_drop_counts.n + 1`,
    [workspaceId, reason],
  );
}

export async function dropCounts(db: Queryable, days: number): Promise<{ workspaceId: string; reason: string; n: number }[]> {
  const { rows } = await db.query<{ workspace_id: string; reason: string; n: string }>(
    `SELECT workspace_id, reason, sum(n) AS n FROM slack_drop_counts
      WHERE day > current_date - $1::int GROUP BY workspace_id, reason ORDER BY sum(n) DESC`,
    [days],
  );
  return rows.map((r) => ({ workspaceId: r.workspace_id, reason: r.reason, n: Number(r.n) }));
}

// Bundles --------------------------------------------------------------------------------------

export async function getBundle(db: Queryable, id: string): Promise<Bundle | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<BundleRow>('SELECT * FROM slack_bundles WHERE id = $1', [id]);
  return rows[0] ? bundleFromRow(rows[0]) : null;
}

export async function listBundles(db: Queryable, options: { statuses?: string[]; limit?: number } = {}): Promise<Bundle[]> {
  const { rows } = await db.query<BundleRow>(
    `SELECT * FROM slack_bundles WHERE ($1::text[] IS NULL OR status = ANY($1)) ORDER BY created_at DESC LIMIT $2`,
    [options.statuses ?? null, options.limit ?? 50],
  );
  return rows.map(bundleFromRow);
}

/** The messages of a bundle that still have their text, oldest first. The reader's own are not among them. */
export async function bundleMessages(db: Queryable, bundleId: string): Promise<StoredMessage[]> {
  const { rows } = await db.query<{
    id: string;
    ts: string | null;
    thread_ts: string | null;
    sender_id: string | null;
    sender_name: string | null;
    text: string | null;
    link: string | null;
    mentions_reader: boolean;
    sent_at: Date;
  }>(
    `SELECT id, ts, thread_ts, sender_id, sender_name, text, link, mentions_reader, sent_at
       FROM slack_messages WHERE bundle_id = $1 AND NOT own AND text IS NOT NULL ORDER BY sent_at, created_at`,
    [bundleId],
  );
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    threadTs: r.thread_ts,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    link: r.link,
    mentionsReader: r.mentions_reader,
    sentAt: r.sent_at,
  }));
}

export async function bundleRecommendation(db: Queryable, bundle: Pick<Bundle, 'recommendationId'>): Promise<Recommendation | null> {
  if (!bundle.recommendationId) return null;
  const { rows } = await db.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = $1', [bundle.recommendationId]);
  return rows[0] ? recommendationFromRow(rows[0]) : null;
}

export async function bundleForRecommendation(db: Queryable, recommendationId: string): Promise<Bundle | null> {
  if (!isUuid(recommendationId)) return null;
  const { rows } = await db.query<BundleRow>('SELECT * FROM slack_bundles WHERE recommendation_id = $1', [recommendationId]);
  return rows[0] ? bundleFromRow(rows[0]) : null;
}

/**
 * Whether the reader has written in the conversation after the bundle's last message: in
 * its thread, or anywhere in a direct message. Known only where the reader's own messages
 * are captured, which is the workspace read through the app.
 */
export async function repliedSince(db: Queryable, bundle: Pick<Bundle, 'id' | 'workspaceId' | 'channelId' | 'channelType' | 'threadTs' | 'lastAt'>): Promise<boolean> {
  if (!bundle.channelId || !bundle.lastAt) return false;
  const direct = bundle.channelType === 'im' || bundle.channelType === 'mpim';
  const { rowCount } = await db.query(
    `SELECT 1 FROM slack_messages o
      WHERE o.workspace_id = $1 AND o.channel_id = $2 AND o.own AND o.sent_at > $3
        AND (
          $4::boolean
          OR ($5::text IS NOT NULL AND o.thread_ts = $5)
          OR ($5::text IS NULL AND o.thread_ts IS NOT NULL
              AND EXISTS (SELECT 1 FROM slack_messages m WHERE m.bundle_id = $6 AND m.ts = o.thread_ts))
        )
      LIMIT 1`,
    [bundle.workspaceId, bundle.channelId, bundle.lastAt, direct, bundle.threadTs, bundle.id],
  );
  return (rowCount ?? 0) > 0;
}

// Feedback -------------------------------------------------------------------------------------

export type FeedbackDecision = 'approved' | 'dismissed' | 'handled' | 'expired';

/** Records how an item ended. A reason given earlier is kept when the same decision is recorded again. */
export async function recordFeedback(db: Queryable, bundleId: string, decision: FeedbackDecision, actor: string | null): Promise<void> {
  await db.query(
    `INSERT INTO triage_feedback (bundle_id, decision, actor) VALUES ($1, $2, $3)
     ON CONFLICT (bundle_id) DO UPDATE
       SET decision = EXCLUDED.decision, actor = coalesce(EXCLUDED.actor, triage_feedback.actor),
           reason = CASE WHEN EXCLUDED.decision = 'dismissed' THEN triage_feedback.reason END,
           at = CASE WHEN triage_feedback.decision = EXCLUDED.decision THEN triage_feedback.at ELSE now() END`,
    [bundleId, decision, actor],
  );
}

export async function setDismissReason(db: Queryable, bundleId: string, reason: DismissReason, actor: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO triage_feedback (bundle_id, decision, reason, actor)
     SELECT b.id, 'dismissed', $2, $3 FROM slack_bundles b JOIN recommendations r ON r.id = b.recommendation_id
      WHERE b.id = $1 AND r.status = 'dismissed'
     ON CONFLICT (bundle_id) DO UPDATE SET decision = 'dismissed', reason = EXCLUDED.reason, actor = EXCLUDED.actor`,
    [bundleId, reason, actor],
  );
  return (rowCount ?? 0) > 0;
}

export async function feedbackFor(db: Queryable, bundleIds: string[]): Promise<Map<string, { decision: FeedbackDecision; reason: DismissReason | null }>> {
  if (!bundleIds.length) return new Map();
  const { rows } = await db.query<{ bundle_id: string; decision: FeedbackDecision; reason: DismissReason | null }>(
    'SELECT bundle_id, decision, reason FROM triage_feedback WHERE bundle_id = ANY($1)',
    [bundleIds],
  );
  return new Map(rows.map((r) => [r.bundle_id, { decision: r.decision, reason: r.reason }]));
}

export interface PastDecision {
  channel: string;
  summary: string;
  outcome: string;
}

/** What a person did with recent items from the same workspace: the examples the triage prompt is given. */
export async function recentDecisions(db: Queryable, workspaceId: string, limit = 8): Promise<PastDecision[]> {
  const { rows } = await db.query<{ channel_name: string | null; channel_type: string; summary: string; decision: string; reason: string | null }>(
    `SELECT b.channel_name, b.channel_type, b.summary, f.decision, f.reason
       FROM triage_feedback f JOIN slack_bundles b ON b.id = f.bundle_id
      WHERE b.workspace_id = $1 AND b.summary IS NOT NULL AND f.decision IN ('approved', 'dismissed')
      ORDER BY f.at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((r) => ({
    channel: r.channel_type === 'im' ? 'a direct message' : r.channel_name ? `#${r.channel_name}` : 'a channel',
    summary: r.summary,
    outcome: r.decision === 'approved' ? 'acted on' : `dismissed${r.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''}`,
  }));
}

export interface RuleSuggestion {
  workspaceId: string;
  channelId: string | null;
  channelName: string | null;
  dismissals: number;
}

/** Channels whose items were dismissed as "wrong channel" three times in thirty days, and that have no rule yet. */
export async function ruleSuggestions(db: Queryable): Promise<RuleSuggestion[]> {
  const { rows } = await db.query<{ workspace_id: string; channel_id: string | null; channel_name: string | null; n: string }>(
    `SELECT b.workspace_id, b.channel_id, max(b.channel_name) AS channel_name, count(*) AS n
       FROM triage_feedback f JOIN slack_bundles b ON b.id = f.bundle_id
      WHERE f.reason = 'wrong_channel' AND f.at > now() - interval '30 days' AND b.channel_type IN ('channel', 'group', 'unknown')
        AND (b.channel_id IS NOT NULL OR b.channel_name IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM slack_channel_rules r
           WHERE r.workspace_id = b.workspace_id
             AND ((r.channel_id IS NOT NULL AND r.channel_id = b.channel_id) OR (r.channel_id IS NULL AND lower(r.channel_name) = lower(b.channel_name))))
      GROUP BY b.workspace_id, b.channel_id, CASE WHEN b.channel_id IS NULL THEN lower(b.channel_name) END
     HAVING count(*) >= 3
      ORDER BY count(*) DESC LIMIT 10`,
  );
  return rows.map((r) => ({ workspaceId: r.workspace_id, channelId: r.channel_id, channelName: r.channel_name, dismissals: Number(r.n) }));
}

// Digests --------------------------------------------------------------------------------------

export async function getDigest(db: Queryable, id: string): Promise<Digest | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<DigestRow>('SELECT * FROM slack_digests WHERE id = $1', [id]);
  return rows[0] ? digestFromRow(rows[0]) : null;
}

export async function listDigests(db: Queryable, limit = 10): Promise<Digest[]> {
  const { rows } = await db.query<DigestRow>('SELECT * FROM slack_digests ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(digestFromRow);
}

export interface Item {
  bundle: Bundle;
  workspaceName: string;
  rec: Recommendation | null;
  feedback: { decision: FeedbackDecision; reason: DismissReason | null } | null;
}

async function toItems(db: Queryable, rows: (BundleRow & { workspace_name: string })[]): Promise<Item[]> {
  const bundles = rows.map((r) => ({ bundle: bundleFromRow(r), workspaceName: r.workspace_name }));
  const recIds = bundles.flatMap((b) => (b.bundle.recommendationId ? [b.bundle.recommendationId] : []));
  const recs = recIds.length
    ? (await db.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = ANY($1)', [recIds])).rows.map(recommendationFromRow)
    : [];
  const feedback = await feedbackFor(
    db,
    bundles.map((b) => b.bundle.id),
  );
  return bundles.map((b) => ({
    ...b,
    rec: recs.find((r) => r.id === b.bundle.recommendationId) ?? null,
    feedback: feedback.get(b.bundle.id) ?? null,
  }));
}

export async function getItem(db: Queryable, bundleId: string): Promise<Item | null> {
  if (!isUuid(bundleId)) return null;
  const { rows } = await db.query<BundleRow & { workspace_name: string }>(
    `SELECT b.*, w.name AS workspace_name FROM slack_bundles b JOIN slack_workspaces w ON w.id = b.workspace_id WHERE b.id = $1`,
    [bundleId],
  );
  return (await toItems(db, rows))[0] ?? null;
}

export async function digestItems(db: Queryable, digestId: string): Promise<Item[]> {
  const { rows } = await db.query<BundleRow & { workspace_name: string }>(
    `SELECT b.*, w.name AS workspace_name FROM slack_bundles b JOIN slack_workspaces w ON w.id = b.workspace_id
      WHERE b.digest_id = $1 ORDER BY b.digest_position`,
    [digestId],
  );
  return toItems(db, rows);
}

/** Items with a recommendation, newest first, for the inbox screen. */
export async function recentItems(db: Queryable, limit = 40): Promise<Item[]> {
  const { rows } = await db.query<BundleRow & { workspace_name: string }>(
    `SELECT b.*, w.name AS workspace_name FROM slack_bundles b JOIN slack_workspaces w ON w.id = b.workspace_id
      WHERE b.recommendation_id IS NOT NULL ORDER BY b.created_at DESC LIMIT $1`,
    [limit],
  );
  return toItems(db, rows);
}

/** The carried recommendations of the reader, for a list of bundle ids. */
export async function carriedBy(db: Queryable, bundleId: string): Promise<Recommendation | null> {
  const { rows } = await db.query<RecommendationRow>(
    'SELECT * FROM recommendations WHERE carrier_type = $1 AND carrier_id = $2 ORDER BY created_at DESC LIMIT 1',
    [INBOX_CARRIER, bundleId],
  );
  return rows[0] ? recommendationFromRow(rows[0]) : null;
}

// Workspaces known only from mail --------------------------------------------------------------

export class WorkspaceInputError extends Error {}

/** Adds a workspace that is read from forwarded mail. It starts switched off, like any other. */
export async function addEmailWorkspace(pool: Pool, input: { domain: string; name: string }, actor: Actor): Promise<string> {
  const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.slack\.com.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(domain)) throw new WorkspaceInputError('Write the workspace address as it appears before .slack.com, like acme.');
  const name = input.name.trim().slice(0, 80) || domain;
  return withTx(pool, async (tx) => {
    const existing = await tx.query('SELECT 1 FROM slack_workspaces WHERE domain = $1', [domain]);
    if (existing.rowCount) throw new WorkspaceInputError('That workspace is already listed.');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO slack_workspaces (domain, name, enabled, read_mode, status, updated_by) VALUES ($1, $2, false, 'email_only', 'new', $3) RETURNING id`,
      [domain, name, actor],
    );
    await recordAudit(tx, { actor, action: 'inbox.workspace.add', target: rows[0]!.id, after: { domain, readMode: 'email_only' } });
    return rows[0]!.id;
  });
}

// Tasks from Slack that belong to no project ---------------------------------------------------

export interface LooseTask {
  id: string;
  title: string;
  body: string;
  status: 'open' | 'done';
  bundleId: string | null;
  createdAt: Date;
}

export async function looseTasks(db: Queryable, limit = 30): Promise<LooseTask[]> {
  const { rows } = await db.query<{ id: string; title: string; body: string; status: 'open' | 'done'; bundle_id: string | null; created_at: Date }>(
    `SELECT id, title, body, status, bundle_id, created_at FROM project_tasks
      WHERE project_id IS NULL ORDER BY (status = 'open') DESC, created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, status: r.status, bundleId: r.bundle_id, createdAt: r.created_at }));
}

export async function setLooseTaskDone(db: Queryable, taskId: string, done: boolean, actor: Actor): Promise<boolean> {
  if (!isUuid(taskId)) return false;
  const { rowCount } = await db.query(
    `UPDATE project_tasks SET status = $2, done_by = $3, done_at = CASE WHEN $2 = 'done' THEN now() END
      WHERE id = $1 AND project_id IS NULL AND status <> $2`,
    [taskId, done ? 'done' : 'open', done ? actor : null],
  );
  if (rowCount) await recordAudit(db, { actor, action: done ? 'inbox.task.done' : 'inbox.task.reopen', target: taskId });
  return Boolean(rowCount);
}

// Health -----------------------------------------------------------------------------------------

/** What /health says about the reader: times and counts, never a name or a word of a message. */
export async function readerHealth(db: Queryable): Promise<{ connected: boolean; lastMessageAt: string | null; lastMailAt: string | null; waiting: number }> {
  const { rows } = await db.query<{ connected: boolean; last_message_at: Date | null; last_mail_at: Date | null; waiting: string }>(
    `SELECT EXISTS (SELECT 1 FROM slack_workspaces WHERE read_mode = 'api' AND status = 'connected' AND enabled) AS connected,
            (SELECT max(last_message_at) FROM slack_workspaces) AS last_message_at,
            (SELECT max(received_at) FROM inbound_emails) AS last_mail_at,
            (SELECT count(*) FROM slack_bundles WHERE status = 'held') AS waiting`,
  );
  const r = rows[0]!;
  return {
    connected: r.connected,
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    lastMailAt: r.last_mail_at?.toISOString() ?? null,
    waiting: Number(r.waiting),
  };
}
