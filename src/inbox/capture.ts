import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import { getSetting } from '../settings/settings.js';
import { countDrop, normalChannelName, ruleFor } from './store.js';
import type { ChannelType, DropReason, Source, WorkspaceRow } from './types.js';
import { CHANNEL_TYPES, SOURCES } from './types.js';

/**
 * The seam every capture source goes through (design 8.6, "Receive"). The hub app's events
 * and forwarded notification mail both end in `receiveCaptured`; the browser companion of
 * phase 4b is a third caller. A source authenticates its sender, finds the workspace, and
 * hands over this one shape. From here on nothing depends on where a message came from.
 */
const SLACK_TS = /^\d{9,11}\.\d{1,6}$/;

export const capturedMessage = z.strictObject({
  workspaceId: z.string().uuid(),
  source: z.enum(SOURCES),
  channelId: z.string().regex(/^[A-Z0-9]{3,40}$/).nullable(),
  channelName: z.string().trim().min(1).max(120).nullable(),
  channelType: z.enum(CHANNEL_TYPES),
  /** Slack's timestamp of the message, which is also its id within the channel. Null when the source cannot know it. */
  ts: z.string().regex(SLACK_TS).nullable(),
  threadTs: z.string().regex(SLACK_TS).nullable(),
  senderId: z.string().max(40).nullable(),
  senderName: z.string().trim().max(120).nullable(),
  text: z.string().max(100_000),
  link: z.string().url().max(600).nullable(),
  /** Written by the person whose messages are read. Kept without its text, to see that something was answered. */
  own: z.boolean(),
  mentionsReader: z.boolean(),
  /** Posted by a bot or an integration, or a join, leave or topic line. */
  origin: z.enum(['person', 'bot', 'system']),
  sentAt: z.date(),
});
export type CapturedMessage = z.infer<typeof capturedMessage>;

export interface CaptureDeps {
  pool: Pool;
  queue: Enqueuer;
  log: Logger;
}

export type CaptureOutcome = 'stored' | 'own' | DropReason;

const MAX_TEXT = 8000;
const MAX_WINDOW_FACTOR = 5;
const MIN_MAX_WINDOW_SECONDS = 600;
const BUCKET_MS = 15 * 60 * 1000;

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

export function channelKeyOf(message: Pick<CapturedMessage, 'channelId' | 'channelName' | 'senderId' | 'senderName'>): string {
  if (message.channelId) return message.channelId;
  if (message.channelName) return `name:${normalChannelName(message.channelName)}`;
  return `from:${(message.senderId ?? message.senderName ?? 'unknown').toLowerCase()}`;
}

/**
 * Design 8.7: Slack's timestamp when it is known, which makes the same message from two
 * sources one row; otherwise workspace, channel, sender, a hash of the text and a time bucket.
 */
export function dedupeKeyOf(message: CapturedMessage): string {
  const channel = channelKeyOf(message);
  if (message.ts) return `${message.workspaceId}:${channel}:${message.ts}`;
  const bucket = Math.floor(message.sentAt.getTime() / BUCKET_MS);
  const body = sha(message.text.replace(/\s+/g, ' ').trim().toLowerCase());
  return `${message.workspaceId}:h:${sha([channel, (message.senderId ?? message.senderName ?? '').toLowerCase(), body, bucket].join('|'))}`;
}

async function workspaceRow(db: Queryable, id: string): Promise<Pick<WorkspaceRow, 'id' | 'team_id' | 'enabled' | 'read_dms' | 'channel_default' | 'status' | 'read_mode'> | null> {
  const { rows } = await db.query<WorkspaceRow>(
    'SELECT id, team_id, enabled, read_dms, channel_default, status, read_mode FROM slack_workspaces WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

type WorkspaceSwitches = Pick<WorkspaceRow, 'id' | 'team_id' | 'enabled' | 'read_dms' | 'channel_default' | 'status' | 'read_mode'>;

/** The part of the filter that depends only on the conversation, so a catch-up can skip a channel without reading it. */
export async function conversationFilter(
  db: Queryable,
  workspace: Pick<WorkspaceSwitches, 'id' | 'team_id' | 'read_dms' | 'channel_default'>,
  channel: { id: string | null; name: string | null; type: ChannelType },
): Promise<DropReason | null> {
  const direct = channel.type === 'im' || channel.type === 'mpim';
  if (direct) return workspace.read_dms ? null : 'dm_off';
  if (channel.id && workspace.team_id) {
    // What Patcher posts, and what is said under it, is never read back in.
    const own = await db.query('SELECT 1 FROM channel_routes WHERE team_id = $1 AND channel_id = $2', [workspace.team_id, channel.id]);
    if (own.rowCount) return 'patcher_channel';
  }
  const rule = await ruleFor(db, workspace.id, { id: channel.id, name: channel.name });
  if (rule?.rule === 'exclude') return 'excluded';
  if (!rule && workspace.channel_default === 'exclude') return 'not_included';
  return null;
}

/** The filter of design 8.6, in code, before anything is stored. Null: the message is read. */
async function filtered(db: Queryable, workspace: WorkspaceSwitches, message: CapturedMessage): Promise<DropReason | null> {
  if (!(await getSetting(db, 'inbox.enabled'))) return 'off';
  if (!workspace.enabled) return 'workspace_off';
  if (message.source === 'api' && workspace.status !== 'connected') return 'disconnected';
  if (message.source === 'email' && workspace.read_mode === 'api') return 'covered_by_api';
  if (message.origin === 'system') return 'system';
  if (message.origin === 'bot') return 'bot';
  const reason = await conversationFilter(db, workspace, { id: message.channelId, name: message.channelName, type: message.channelType });
  if (reason) return reason;
  if (!message.own && !message.text.trim()) return 'empty';
  return null;
}

/**
 * Stores one captured message and puts it in a bundle: the open one for its thread or its
 * channel, or a new one, which is read once no more messages have arrived for the settle
 * window. Everything happens in one transaction, so a message is never stored without the
 * job that will read it.
 */
export async function receiveCaptured(deps: CaptureDeps, input: CapturedMessage): Promise<CaptureOutcome> {
  const message = capturedMessage.parse(input);
  return withTx(deps.pool, async (tx) => {
    const workspace = await workspaceRow(tx, message.workspaceId);
    if (!workspace) return 'workspace_off';
    const reason = await filtered(tx, workspace, message);
    if (reason) {
      await countDrop(tx, workspace.id, reason);
      return reason;
    }

    const retentionDays = await getSetting(tx, 'inbox.retention_days');
    const channelKey = channelKeyOf(message);
    // A thread's first message carries its own timestamp as the thread's: it is a channel message.
    const threadTs = message.threadTs && message.threadTs !== message.ts ? message.threadTs : null;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO slack_messages
         (workspace_id, channel_id, channel_name, channel_type, ts, thread_ts, sender_id, sender_name, text, link, source, own,
          mentions_reader, dedupe_key, sent_at, purge_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now() + make_interval(days => $16))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        workspace.id,
        message.channelId,
        message.channelName ? normalChannelName(message.channelName) : null,
        message.channelType,
        message.ts,
        threadTs,
        message.senderId,
        message.senderName,
        message.own ? null : message.text.trim().slice(0, MAX_TEXT),
        message.link,
        message.source,
        message.own,
        message.mentionsReader,
        dedupeKeyOf(message),
        message.sentAt,
        retentionDays,
      ],
    );
    const messageId = inserted.rows[0]?.id;
    if (!messageId) {
      await countDrop(tx, workspace.id, 'duplicate');
      return 'duplicate';
    }

    if (message.own) {
      await deps.queue.enqueue('inbox.recheck', { workspaceId: workspace.id, channelKey }, { tx });
      return 'own';
    }

    const settleSeconds = await getSetting(tx, 'inbox.settle_seconds');
    const maxWindow = Math.max(settleSeconds * MAX_WINDOW_FACTOR, MIN_MAX_WINDOW_SECONDS);
    const addressed = message.mentionsReader || message.channelType === 'im' || message.channelType === 'mpim';
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM slack_bundles
        WHERE workspace_id = $1 AND channel_key = $2 AND coalesce(thread_ts, '') = coalesce($3, '') AND status = 'open'
        FOR UPDATE`,
      [workspace.id, channelKey, threadTs],
    );
    let bundleId = open.rows[0]?.id;
    if (bundleId) {
      await tx.query(
        `UPDATE slack_bundles
            SET settle_at = least(now() + make_interval(secs => $2), opened_at + make_interval(secs => $3)),
                first_at = least(first_at, $4), last_at = greatest(last_at, $4), message_count = message_count + 1,
                addressed = addressed OR $5, channel_name = coalesce(channel_name, $6), link = coalesce(link, $7), updated_at = now()
          WHERE id = $1`,
        [bundleId, settleSeconds, maxWindow, message.sentAt, addressed, message.channelName ? normalChannelName(message.channelName) : null, message.link],
      );
    } else {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO slack_bundles
           (workspace_id, channel_key, channel_id, channel_name, channel_type, thread_ts, source, settle_at, first_at, last_at,
            message_count, addressed, sender_name, link)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8), $9, $9, 1, $10, $11, $12)
         RETURNING id`,
        [
          workspace.id,
          channelKey,
          message.channelId,
          message.channelName ? normalChannelName(message.channelName) : null,
          message.channelType,
          threadTs,
          message.source,
          settleSeconds,
          message.sentAt,
          addressed,
          message.senderName,
          message.link,
        ],
      );
      bundleId = created.rows[0]!.id;
      await deps.queue.enqueue('inbox.bundle', { bundleId }, { tx, startAfter: settleSeconds + 1 });
    }
    await tx.query('UPDATE slack_messages SET bundle_id = $2 WHERE id = $1', [messageId, bundleId]);
    await tx.query('UPDATE slack_workspaces SET last_message_at = greatest(last_message_at, $2) WHERE id = $1', [workspace.id, message.sentAt]);
    return 'stored';
  });
}

export interface MessageRef {
  workspaceId: string;
  channelId: string;
  ts: string;
}

/** Design 8.7: an edit in Slack is applied to the stored copy, while there still is one. */
export async function applyEdit(deps: CaptureDeps, ref: MessageRef, text: string): Promise<boolean> {
  const { rowCount } = await deps.pool.query(
    `UPDATE slack_messages SET text = $4
      WHERE workspace_id = $1 AND channel_id = $2 AND ts = $3 AND NOT own AND text IS NOT NULL`,
    [ref.workspaceId, ref.channelId, ref.ts, text.trim().slice(0, MAX_TEXT)],
  );
  return (rowCount ?? 0) > 0;
}

/** A message deleted in Slack is deleted here, and what was waiting on it is looked at again. */
export async function applyDelete(deps: CaptureDeps, ref: MessageRef): Promise<boolean> {
  return withTx(deps.pool, async (tx) => {
    const { rows } = await tx.query<{ bundle_id: string | null }>(
      'DELETE FROM slack_messages WHERE workspace_id = $1 AND channel_id = $2 AND ts = $3 RETURNING bundle_id',
      [ref.workspaceId, ref.channelId, ref.ts],
    );
    if (!rows[0]) return false;
    if (rows[0].bundle_id) {
      await tx.query('UPDATE slack_bundles SET message_count = greatest(message_count - 1, 0), updated_at = now() WHERE id = $1', [rows[0].bundle_id]);
      await deps.queue.enqueue('inbox.recheck', { workspaceId: ref.workspaceId, channelKey: ref.channelId }, { tx });
    }
    return true;
  });
}

/** Notes that Slack is delivering events for the workspace, at most once a minute. */
export async function touchEvents(db: Queryable, workspaceId: string): Promise<void> {
  await db.query(
    `UPDATE slack_workspaces SET last_event_at = now()
      WHERE id = $1 AND (last_event_at IS NULL OR last_event_at < now() - interval '1 minute')`,
    [workspaceId],
  );
}

export const slackTime = (ts: string): Date => new Date(Math.round(Number(ts) * 1000));

/** The address of a message in Slack, with nothing in it that signs anyone in. */
export function permalink(input: { domain: string | null; teamId: string | null; channelId: string; ts: string; threadTs: string | null }): string {
  if (input.domain) {
    const base = `https://${input.domain}.slack.com/archives/${input.channelId}/p${input.ts.replace('.', '').padEnd(16, '0')}`;
    return input.threadTs && input.threadTs !== input.ts ? `${base}?thread_ts=${input.threadTs}&cid=${input.channelId}` : base;
  }
  return `https://slack.com/app_redirect?channel=${input.channelId}${input.teamId ? `&team=${input.teamId}` : ''}`;
}

export type { ChannelType, Source };
