import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { getSetting } from '../settings/settings.js';
import type { CaptureDeps, CaptureOutcome } from './capture.js';
import { applyDelete, applyEdit, receiveCaptured } from './capture.js';
import { fromSlackMessage } from './slackEvents.js';
import { countDrop, isUuid, workspaceByTeam } from './store.js';
import type { CaptureLevel, ChannelType, Workspace } from './types.js';
import { CHANNEL_TYPES } from './types.js';

/**
 * The browser companion's side of the Slack reader (design 8.5). A Chrome extension in a
 * reader profile on the owner's machine sees the messages Slack's web client receives and
 * posts them here under a device key. This module is everything the public service does
 * with that: keys, the list of workspaces the extension may capture, the messages, and the
 * heartbeat the coverage view is drawn from.
 *
 * What it relies on, and what it does not:
 *   - A device key can do three things: read which workspaces are switched on, post
 *     messages for them, and report its own state. It reads nothing else.
 *   - Patcher holds no Slack credential for these workspaces and the extension sends none.
 *     Anything shaped like a Slack token is removed from text on the way in all the same.
 *   - A workspace the extension reports for the first time is added switched off.
 *   - What is posted for a workspace that is off, or above its capture level, is dropped
 *     here as well as in the extension, and counted.
 */

export const COMPANION_STATES = ['open', 'asleep', 'signed_out', 'closed'] as const;
export type CompanionState = (typeof COMPANION_STATES)[number];

/** The extension reports every minute. A longer silence than this is written down as a gap. */
export const HEARTBEAT_SECONDS = 60;
export const GAP_SECONDS = 150;
export const MAX_ITEMS = 100;

const KEY_PREFIX = 'pdk_';
const KEY = /^pdk_[A-Za-z0-9_-]{32}$/;
const TEAM = /^[TE][A-Z0-9]{2,20}$/;
const CHANNEL = /^[A-Z0-9]{3,40}$/;
const MEMBER = /^[UW][A-Z0-9]{2,30}$/;
const SLACK_TS = /^\d{9,11}\.\d{1,6}$/;
const DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLACK_TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{8,}/g;
const HAS_SLACK_TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{8,}/;

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Removes anything shaped like a Slack token. The extension does the same before it sends. */
export const scrub = (text: string): string => text.replace(SLACK_TOKEN, '[removed]');

export const isMemberId = (value: string): boolean => MEMBER.test(value);

// Devices ------------------------------------------------------------------------------------------

export interface Device {
  id: string;
  label: string;
  version: string | null;
  createdAt: Date;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  lastHeartbeatAt: Date | null;
  seenCount: number;
  sentCount: number;
  storedCount: number;
  diagnostics: Record<string, unknown> | null;
  revokedAt: Date | null;
}

interface DeviceRow {
  id: string;
  label: string;
  version: string | null;
  created_at: Date;
  paired_at: Date | null;
  last_seen_at: Date | null;
  last_heartbeat_at: Date | null;
  seen_count: string;
  sent_count: string;
  stored_count: string;
  diagnostics: Record<string, unknown> | null;
  revoked_at: Date | null;
}

const DEVICE_COLUMNS = 'id, label, version, created_at, paired_at, last_seen_at, last_heartbeat_at, seen_count, sent_count, stored_count, diagnostics, revoked_at';

const deviceFromRow = (r: DeviceRow): Device => ({
  id: r.id,
  label: r.label,
  version: r.version,
  createdAt: r.created_at,
  pairedAt: r.paired_at,
  lastSeenAt: r.last_seen_at,
  lastHeartbeatAt: r.last_heartbeat_at,
  seenCount: Number(r.seen_count),
  sentCount: Number(r.sent_count),
  storedCount: Number(r.stored_count),
  diagnostics: r.diagnostics,
  revokedAt: r.revoked_at,
});

export class DeviceInputError extends Error {}

/** Issues a device key. It is returned once, to be shown once; only its hash is stored. */
export async function issueDevice(pool: Pool, input: { label: string }, actor: Actor): Promise<{ id: string; key: string }> {
  const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!label) throw new DeviceInputError('Give the reader a name, like "Reader profile on the laptop".');
  const key = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('INSERT INTO companion_devices (label, key_hash, created_by) VALUES ($1, $2, $3) RETURNING id', [
      label,
      hashKey(key),
      actor,
    ]);
    await recordAudit(tx, { actor, action: 'inbox.companion.issue', target: rows[0]!.id, after: { label } });
    return { id: rows[0]!.id, key };
  });
}

/** Revokes a key. The next request that carries it is refused, and the extension stops and forgets what it had queued. */
export async function revokeDevice(pool: Pool, id: string, actor: Actor): Promise<boolean> {
  if (!isUuid(id)) return false;
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ label: string }>(
      'UPDATE companion_devices SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING label',
      [id, actor],
    );
    if (!rows[0]) return false;
    await tx.query('DELETE FROM companion_workspace_status WHERE device_id = $1', [id]);
    await recordAudit(tx, { actor, action: 'inbox.companion.revoke', target: id, before: { label: rows[0].label } });
    return true;
  });
}

/** The device a request's `Authorization: Bearer` header belongs to, or null. Also notes that it was seen. */
export async function deviceForKey(db: Queryable, header: string | undefined): Promise<Device | null> {
  const key = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!key || !KEY.test(key)) return null;
  const { rows } = await db.query<DeviceRow>(
    `UPDATE companion_devices SET paired_at = coalesce(paired_at, now()), last_seen_at = now()
      WHERE key_hash = $1 AND revoked_at IS NULL RETURNING ${DEVICE_COLUMNS}`,
    [hashKey(key)],
  );
  return rows[0] ? deviceFromRow(rows[0]) : null;
}

export async function listDevices(db: Queryable): Promise<Device[]> {
  const { rows } = await db.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM companion_devices
      WHERE revoked_at IS NULL OR revoked_at > now() - interval '30 days'
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
  );
  return rows.map(deviceFromRow);
}

// What the extension is told ------------------------------------------------------------------------

export interface CompanionConfig {
  ok: true;
  device: { label: string };
  /** False while the Slack reader is switched off: the extension then sends nothing at all. */
  reading: boolean;
  heartbeatSeconds: number;
  maxItems: number;
  /** Only these workspaces are captured. Every other one is ignored by the extension. */
  workspaces: { teamId: string; name: string; level: CaptureLevel; selfUserId: string | null }[];
}

export async function companionConfig(db: Queryable, device: Pick<Device, 'label'>): Promise<CompanionConfig> {
  const reading = await getSetting(db, 'inbox.enabled');
  const { rows } = reading
    ? await db.query<{ team_id: string; name: string; capture_level: CaptureLevel; reader_user_id: string | null }>(
        `SELECT team_id, name, capture_level, reader_user_id FROM slack_workspaces
          WHERE enabled AND companion_enabled AND team_id IS NOT NULL ORDER BY lower(name)`,
      )
    : { rows: [] };
  return {
    ok: true,
    device: { label: device.label },
    reading,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    maxItems: MAX_ITEMS,
    workspaces: rows.map((r) => ({ teamId: r.team_id, name: r.name, level: r.capture_level, selfUserId: r.reader_user_id })),
  };
}

// Messages --------------------------------------------------------------------------------------------

const teamId = z.string().regex(TEAM);
const channelId = z.string().regex(CHANNEL);
const slackTs = z.string().regex(SLACK_TS);
const shortName = z.string().max(200);

const messageItem = z.object({
  kind: z.literal('message'),
  teamId,
  channelId,
  channelType: z.enum(CHANNEL_TYPES).optional(),
  channelName: shortName.optional(),
  ts: slackTs,
  threadTs: slackTs.optional(),
  userId: z.string().regex(MEMBER).optional(),
  senderName: shortName.optional(),
  text: z.string().max(40_000),
  subtype: z.string().max(40).optional(),
  bot: z.boolean().optional(),
  /** Slack's own client was told to raise a notification for this message. */
  notified: z.boolean().optional(),
  /** `notification`: built from the notification alone, because the message itself was not seen. */
  via: z.enum(['socket', 'notification']).optional(),
});
const editItem = z.object({ kind: z.literal('edit'), teamId, channelId, ts: slackTs, text: z.string().max(40_000) });
const deleteItem = z.object({ kind: z.literal('delete'), teamId, channelId, ts: slackTs });
const batch = z.object({ items: z.array(z.discriminatedUnion('kind', [messageItem, editItem, deleteItem])).min(1).max(MAX_ITEMS) });

type MessageItem = z.infer<typeof messageItem>;
export type ItemOutcome = CaptureOutcome | 'no_workspace' | 'edited' | 'deleted' | 'ignored';

const typeOf = (item: Pick<MessageItem, 'channelId' | 'channelType'>): ChannelType => {
  if (item.channelType && item.channelType !== 'unknown') return item.channelType;
  if (item.channelId.startsWith('D')) return 'im';
  if (item.channelId.startsWith('G')) return 'group';
  return item.channelId.startsWith('C') ? 'channel' : 'unknown';
};

const cleanName = (value: string | undefined): string | null => {
  const name = value ? scrub(value).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return name || null;
};

async function rememberName(db: Queryable, workspaceId: string, kind: 'user' | 'channel', id: string, name: string): Promise<void> {
  await db.query(
    `INSERT INTO slack_names (workspace_id, kind, external_id, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, kind, external_id) DO UPDATE SET name = EXCLUDED.name, fetched_at = now()`,
    [workspaceId, kind, id, name],
  );
}

async function receiveMessage(deps: CaptureDeps, workspace: Workspace, item: MessageItem): Promise<ItemOutcome> {
  const type = typeOf(item);
  const direct = type === 'im' || type === 'mpim';
  const channelName = direct ? null : cleanName(item.channelName)?.replace(/^#/, '') || null;
  const converted = fromSlackMessage(
    workspace,
    { id: item.channelId, name: channelName, type },
    { ts: item.ts, thread_ts: item.threadTs, user: item.userId, text: scrub(item.text), subtype: item.subtype, bot_id: item.bot ? 'B0COMPANION' : undefined },
  );
  if (converted.kind !== 'message') return 'ignored';
  const senderName = cleanName(item.senderName);
  const message = {
    ...converted.message,
    source: workspace.captureLevel === 'page' ? ('companion_page' as const) : ('companion_notification' as const),
    senderName,
    // A notification names no sender id, so it would read as a system line; it is a person's message.
    origin: item.via === 'notification' && converted.message.origin === 'system' && !item.subtype ? ('person' as const) : converted.message.origin,
    mentionsReader: !converted.message.own && (converted.message.mentionsReader || item.notified === true),
  };
  if (message.sentAt.getTime() > Date.now() + 5 * 60_000) return 'ignored';
  // The narrower level (design 8.3): direct messages to the owner and messages that mention him. Nothing else is kept.
  if (workspace.captureLevel === 'notifications' && !(direct || message.mentionsReader)) {
    await countDrop(deps.pool, workspace.id, 'above_level');
    return 'above_level';
  }
  const outcome = await receiveCaptured(deps, message);
  if (outcome === 'stored') {
    if (channelName) await rememberName(deps.pool, workspace.id, 'channel', item.channelId, channelName);
    if (senderName && item.userId) await rememberName(deps.pool, workspace.id, 'user', item.userId, senderName);
  }
  return outcome;
}

export interface BatchResult {
  status: 200 | 400;
  body: { ok: true; received: number; stored: number; outcomes: Record<string, number> } | { ok: false; error: string };
}

/**
 * Takes one post of captured messages from a paired device. Each item goes through the
 * same capture function as a message from the hub app or from mail. The answer says only
 * how many were kept and why the rest were not; it never echoes anything back.
 */
export async function ingestBatch(deps: CaptureDeps, device: Pick<Device, 'id'>, body: unknown): Promise<BatchResult> {
  const parsed = batch.safeParse(body);
  if (!parsed.success) return { status: 400, body: { ok: false, error: 'invalid_batch' } };
  const workspaces = new Map<string, Workspace | null>();
  const outcomes: Record<string, number> = {};
  const storedBy = new Map<string, number>();
  for (const item of parsed.data.items) {
    if (!workspaces.has(item.teamId)) workspaces.set(item.teamId, await workspaceByTeam(deps.pool, item.teamId));
    const workspace = workspaces.get(item.teamId) ?? null;
    let outcome: ItemOutcome;
    if (!workspace) outcome = 'no_workspace';
    else if (!workspace.enabled || !workspace.companionEnabled) {
      outcome = workspace.enabled ? 'companion_off' : 'workspace_off';
      await countDrop(deps.pool, workspace.id, outcome);
    } else if (item.kind === 'message') outcome = await receiveMessage(deps, workspace, item);
    else if (!(await getSetting(deps.pool, 'inbox.enabled'))) outcome = 'off';
    else if (item.kind === 'edit') outcome = (await applyEdit(deps, { workspaceId: workspace.id, channelId: item.channelId, ts: item.ts }, scrub(item.text))) ? 'edited' : 'ignored';
    else outcome = (await applyDelete(deps, { workspaceId: workspace.id, channelId: item.channelId, ts: item.ts })) ? 'deleted' : 'ignored';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (workspace && (outcome === 'stored' || outcome === 'own')) storedBy.set(workspace.id, (storedBy.get(workspace.id) ?? 0) + 1);
  }
  let stored = 0;
  for (const [workspaceId, n] of storedBy) {
    stored += n;
    await deps.pool.query(
      `INSERT INTO companion_coverage (device_id, workspace_id, hour, stored) VALUES ($1, $2, date_trunc('hour', now()), $3)
       ON CONFLICT (device_id, workspace_id, hour) DO UPDATE SET stored = companion_coverage.stored + EXCLUDED.stored`,
      [device.id, workspaceId, n],
    );
  }
  if (stored) await deps.pool.query('UPDATE companion_devices SET stored_count = stored_count + $2 WHERE id = $1', [device.id, stored]);
  return { status: 200, body: { ok: true, received: parsed.data.items.length, stored, outcomes } };
}

// Heartbeat -------------------------------------------------------------------------------------------

const count = z.number().int().min(0).max(1_000_000);
const heartbeatBody = z.object({
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,20}$/),
  workspaces: z
    .array(
      z.object({
        teamId,
        name: z.string().max(200).optional(),
        domain: z.string().regex(DOMAIN).optional(),
        state: z.enum(COMPANION_STATES),
        detail: z.string().max(200).optional(),
        seen: count,
        sent: count,
        lastFrameAt: z.string().datetime().optional(),
        selfUserId: z.string().regex(MEMBER).optional(),
      }),
    )
    .max(40),
  diagnostics: z.unknown().optional(),
});

const PLAIN = /^[\w .:,()+/#-]{0,80}$/;

/**
 * The diagnostics a heartbeat carries are counts, flags and short labels. Anything else is
 * dropped here, so that no free text, and so no word of a message, can be stored by this route.
 */
export function plainDiagnostics(value: unknown, depth = 0): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string') return PLAIN.test(value) && !HAS_SLACK_TOKEN.test(value) ? value : undefined;
  if (depth >= 4 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => plainDiagnostics(v, depth + 1)).filter((v) => v !== undefined);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value).slice(0, 80)) {
    if (!PLAIN.test(key) || !key) continue;
    const kept = plainDiagnostics(inner, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

const placeholderName = (team: string): string => team;

/** The row for a workspace the extension names: found by its team id, joined to one known from mail, or added switched off. */
async function discover(tx: Queryable, input: { teamId: string; name: string | null; domain: string | null }): Promise<string> {
  const byTeam = await tx.query<{ id: string; name: string; domain: string | null }>('SELECT id, name, domain FROM slack_workspaces WHERE team_id = $1', [input.teamId]);
  if (byTeam.rows[0]) {
    const row = byTeam.rows[0];
    // A name or an address learned later fills what was missing; it never replaces what is there.
    if (input.name && row.name === placeholderName(input.teamId)) await tx.query('UPDATE slack_workspaces SET name = $2 WHERE id = $1', [row.id, input.name]);
    if (input.domain && !row.domain) {
      await tx.query('UPDATE slack_workspaces SET domain = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM slack_workspaces o WHERE o.domain = $2)', [row.id, input.domain]);
    }
    return row.id;
  }
  if (input.domain) {
    // Already known from forwarded mail, which gives an address and no id. It keeps its switches: the companion stays off for it.
    const joined = await tx.query<{ id: string }>('UPDATE slack_workspaces SET team_id = $1, updated_at = now() WHERE domain = $2 AND team_id IS NULL RETURNING id', [
      input.teamId,
      input.domain,
    ]);
    if (joined.rows[0]) return joined.rows[0].id;
  }
  const domainFree = input.domain ? !(await tx.query('SELECT 1 FROM slack_workspaces WHERE domain = $1', [input.domain])).rowCount : false;
  // Design 8.3: nothing is captured from a workspace until a person switches it on.
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO slack_workspaces (team_id, domain, name, enabled, read_mode, companion_enabled, status)
     VALUES ($1, $2, $3, false, 'companion', true, 'new') RETURNING id`,
    [input.teamId, domainFree ? input.domain : null, input.name ?? placeholderName(input.teamId)],
  );
  return rows[0]!.id;
}

export interface HeartbeatResult {
  status: 200 | 400;
  body: CompanionConfig | { ok: false; error: string };
}

/**
 * The minute report (design 8.5, "Heartbeat"): per workspace, whether a tab shows it and
 * how many messages were seen and sent. It is what coverage, gaps and the sign-out notice
 * are drawn from. The answer is the current list of workspaces to capture, so a switch in
 * the UI reaches the extension within a minute.
 */
export async function heartbeat(pool: Pool, device: Pick<Device, 'id' | 'label'>, body: unknown, at?: Date): Promise<HeartbeatResult> {
  const parsed = heartbeatBody.safeParse(body);
  if (!parsed.success) return { status: 400, body: { ok: false, error: 'invalid_heartbeat' } };
  const report = parsed.data;
  const diagnostics = plainDiagnostics(report.diagnostics);
  await withTx(pool, async (tx) => {
    const before = await tx.query<{ last_heartbeat_at: Date | null; now: Date }>('SELECT last_heartbeat_at, now() AS now FROM companion_devices WHERE id = $1 FOR UPDATE', [device.id]);
    const previous = before.rows[0]?.last_heartbeat_at ?? null;
    const now = at ?? before.rows[0]?.now ?? new Date();
    if (previous && now.getTime() - previous.getTime() > GAP_SECONDS * 1000) {
      await tx.query(`INSERT INTO companion_events (device_id, kind, from_at, to_at, detail) VALUES ($1, 'gap', $2, $3, 'No report from the reader.')`, [device.id, previous, now]);
    }
    // One report a minute counts towards coverage, so "Check now" in the extension does not add minutes.
    const beat = !previous || Math.floor(now.getTime() / 60_000) !== Math.floor(previous.getTime() / 60_000) ? 1 : 0;
    let seen = 0;
    let sent = 0;
    const reported: string[] = [];
    for (const w of report.workspaces) {
      const name = cleanName(w.name)?.slice(0, 80) ?? null;
      const workspaceId = await discover(tx, { teamId: w.teamId, name, domain: w.domain ?? null });
      if (reported.includes(workspaceId)) continue;
      reported.push(workspaceId);
      seen += w.seen;
      sent += w.sent;
      const lastFrame = w.lastFrameAt ? new Date(w.lastFrameAt) : null;
      const lastMessageAt = lastFrame && lastFrame.getTime() <= now.getTime() + 60_000 ? lastFrame : null;
      const detail = w.detail && PLAIN.test(w.detail) ? w.detail : null;
      const old = await tx.query<{ state: CompanionState; state_since: Date }>('SELECT state, state_since FROM companion_workspace_status WHERE device_id = $1 AND workspace_id = $2 FOR UPDATE', [
        device.id,
        workspaceId,
      ]);
      const changed = old.rows[0] ? old.rows[0].state !== w.state : true;
      if (changed) {
        await tx.query(`INSERT INTO companion_events (device_id, workspace_id, kind, from_state, to_state, from_at, to_at, detail) VALUES ($1, $2, 'state', $3, $4, $5, $6, $7)`, [
          device.id,
          workspaceId,
          old.rows[0]?.state ?? null,
          w.state,
          old.rows[0]?.state_since ?? null,
          now,
          detail,
        ]);
      }
      await tx.query(
        `INSERT INTO companion_workspace_status (device_id, workspace_id, state, state_since, state_detail, last_seen_at, last_open_at, last_message_at, suggested_user_id)
         VALUES ($1, $2, $3, $4, $5, $4, CASE WHEN $3 = 'open' THEN $4::timestamptz END, $6, $7)
         ON CONFLICT (device_id, workspace_id) DO UPDATE
           SET state = EXCLUDED.state,
               state_since = CASE WHEN companion_workspace_status.state = EXCLUDED.state THEN companion_workspace_status.state_since ELSE EXCLUDED.state_since END,
               state_detail = EXCLUDED.state_detail,
               last_seen_at = EXCLUDED.last_seen_at,
               last_open_at = coalesce(EXCLUDED.last_open_at, companion_workspace_status.last_open_at),
               last_message_at = greatest(companion_workspace_status.last_message_at, EXCLUDED.last_message_at),
               suggested_user_id = coalesce(EXCLUDED.suggested_user_id, companion_workspace_status.suggested_user_id)`,
        [device.id, workspaceId, w.state, now, detail, lastMessageAt, w.selfUserId ?? null],
      );
      await tx.query(
        `INSERT INTO companion_coverage (device_id, workspace_id, hour, beats, open_beats, seen, sent)
         VALUES ($1, $2, date_trunc('hour', $3::timestamptz), $7, $4, $5, $6)
         ON CONFLICT (device_id, workspace_id, hour) DO UPDATE
           SET beats = companion_coverage.beats + EXCLUDED.beats, open_beats = companion_coverage.open_beats + EXCLUDED.open_beats,
               seen = companion_coverage.seen + EXCLUDED.seen, sent = companion_coverage.sent + EXCLUDED.sent`,
        [device.id, workspaceId, now, w.state === 'open' ? beat : 0, w.seen, w.sent, beat],
      );
    }
    // A workspace the reader no longer mentions has no tab any more.
    const gone = await tx.query<{ workspace_id: string; state: CompanionState; state_since: Date }>(
      `SELECT workspace_id, state, state_since FROM companion_workspace_status
        WHERE device_id = $1 AND state <> 'closed' AND NOT (workspace_id = ANY($2::uuid[])) FOR UPDATE`,
      [device.id, reported],
    );
    for (const row of gone.rows) {
      await tx.query(`INSERT INTO companion_events (device_id, workspace_id, kind, from_state, to_state, from_at, to_at) VALUES ($1, $2, 'state', $3, 'closed', $4, $5)`, [
        device.id,
        row.workspace_id,
        row.state,
        row.state_since,
        now,
      ]);
      await tx.query(`UPDATE companion_workspace_status SET state = 'closed', state_since = $3, state_detail = NULL, last_seen_at = $3 WHERE device_id = $1 AND workspace_id = $2`, [
        device.id,
        row.workspace_id,
        now,
      ]);
    }
    await tx.query(
      `UPDATE companion_devices
          SET version = $2, last_heartbeat_at = $3, last_seen_at = $3, silent_notified_at = NULL, seen_count = seen_count + $4, sent_count = sent_count + $5,
              diagnostics = $6
        WHERE id = $1`,
      [device.id, report.version, now, seen, sent, diagnostics === undefined ? null : JSON.stringify(diagnostics)],
    );
  });
  return { status: 200, body: await companionConfig(pool, device) };
}

// What the screen shows ---------------------------------------------------------------------------------

export interface WorkspaceStatus {
  deviceId: string;
  deviceLabel: string;
  workspaceId: string;
  state: CompanionState;
  stateSince: Date;
  stateDetail: string | null;
  lastSeenAt: Date;
  lastOpenAt: Date | null;
  lastMessageAt: Date | null;
  suggestedUserId: string | null;
}

export interface CoverageHour {
  workspaceId: string;
  hour: Date;
  beats: number;
  openBeats: number;
  seen: number;
  sent: number;
  stored: number;
}

export interface CompanionEvent {
  deviceLabel: string;
  workspaceId: string | null;
  kind: 'gap' | 'state';
  fromState: string | null;
  toState: string | null;
  fromAt: Date | null;
  toAt: Date;
  detail: string | null;
}

export interface CompanionOverview {
  devices: Device[];
  statuses: WorkspaceStatus[];
  /** The last 24 hours, oldest first, summed over devices. Hours with no report at all are absent. */
  coverage: CoverageHour[];
  events: CompanionEvent[];
  /** How often each workspace left the client for a sign-in page in the last 30 days. */
  signOuts: Map<string, number>;
}

export async function companionOverview(db: Queryable): Promise<CompanionOverview> {
  const [devices, statuses, coverage, events, signOuts] = await Promise.all([
    listDevices(db),
    db.query<{
      device_id: string;
      label: string;
      workspace_id: string;
      state: CompanionState;
      state_since: Date;
      state_detail: string | null;
      last_seen_at: Date;
      last_open_at: Date | null;
      last_message_at: Date | null;
      suggested_user_id: string | null;
    }>(
      `SELECT s.device_id, d.label, s.workspace_id, s.state, s.state_since, s.state_detail, s.last_seen_at, s.last_open_at, s.last_message_at, s.suggested_user_id
         FROM companion_workspace_status s JOIN companion_devices d ON d.id = s.device_id
        WHERE d.revoked_at IS NULL ORDER BY d.created_at, s.workspace_id`,
    ),
    db.query<{ workspace_id: string; hour: Date; beats: string; open_beats: string; seen: string; sent: string; stored: string }>(
      `SELECT c.workspace_id, c.hour, sum(c.beats) AS beats, sum(c.open_beats) AS open_beats, sum(c.seen) AS seen, sum(c.sent) AS sent, sum(c.stored) AS stored
         FROM companion_coverage c JOIN companion_devices d ON d.id = c.device_id
        WHERE d.revoked_at IS NULL AND c.hour > now() - interval '24 hours'
        GROUP BY c.workspace_id, c.hour ORDER BY c.hour`,
    ),
    db.query<{ label: string; workspace_id: string | null; kind: 'gap' | 'state'; from_state: string | null; to_state: string | null; from_at: Date | null; to_at: Date; detail: string | null }>(
      `SELECT d.label, e.workspace_id, e.kind, e.from_state, e.to_state, e.from_at, e.to_at, e.detail
         FROM companion_events e JOIN companion_devices d ON d.id = e.device_id
        WHERE e.to_at > now() - interval '14 days' AND (e.kind = 'gap' OR e.from_state IS NOT NULL)
        ORDER BY e.to_at DESC LIMIT 40`,
    ),
    db.query<{ workspace_id: string; n: string }>(
      `SELECT workspace_id, count(*) AS n FROM companion_events
        WHERE kind = 'state' AND to_state = 'signed_out' AND to_at > now() - interval '30 days' AND workspace_id IS NOT NULL
        GROUP BY workspace_id`,
    ),
  ]);
  return {
    devices,
    statuses: statuses.rows.map((r) => ({
      deviceId: r.device_id,
      deviceLabel: r.label,
      workspaceId: r.workspace_id,
      state: r.state,
      stateSince: r.state_since,
      stateDetail: r.state_detail,
      lastSeenAt: r.last_seen_at,
      lastOpenAt: r.last_open_at,
      lastMessageAt: r.last_message_at,
      suggestedUserId: r.suggested_user_id,
    })),
    coverage: coverage.rows.map((r) => ({
      workspaceId: r.workspace_id,
      hour: r.hour,
      beats: Number(r.beats),
      openBeats: Number(r.open_beats),
      seen: Number(r.seen),
      sent: Number(r.sent),
      stored: Number(r.stored),
    })),
    events: events.rows.map((r) => ({
      deviceLabel: r.label,
      workspaceId: r.workspace_id,
      kind: r.kind,
      fromState: r.from_state,
      toState: r.to_state,
      fromAt: r.from_at,
      toAt: r.to_at,
      detail: r.detail,
    })),
    signOuts: new Map(signOuts.rows.map((r) => [r.workspace_id, Number(r.n)])),
  };
}

/** What /health says about the companion: counts and a time. */
export async function companionHealth(db: Queryable): Promise<{ devices: number; reporting: number; lastHeartbeatAt: string | null }> {
  const { rows } = await db.query<{ devices: string; reporting: string; last: Date | null }>(
    `SELECT count(*) AS devices,
            count(*) FILTER (WHERE last_heartbeat_at > now() - make_interval(secs => $1)) AS reporting,
            max(last_heartbeat_at) AS last
       FROM companion_devices WHERE revoked_at IS NULL`,
    [GAP_SECONDS],
  );
  const r = rows[0]!;
  return { devices: Number(r.devices), reporting: Number(r.reporting), lastHeartbeatAt: r.last?.toISOString() ?? null };
}

/** Coverage and events older than they are useful for. Called with the other retention work. */
export async function purgeCompanion(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM companion_coverage WHERE hour < now() - interval '30 days'`);
  await db.query(`DELETE FROM companion_events WHERE to_at < now() - interval '90 days'`);
  await db.query(`DELETE FROM companion_devices WHERE revoked_at < now() - interval '90 days'`);
}
