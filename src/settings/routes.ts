import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';

/**
 * The report types of section 9.3, each with the channel name the design suggests. The
 * suggestion is only a hint in the UI: a route does not exist until someone picks a channel.
 */
export const REPORT_TYPES = {
  calls: { label: 'Calls', suggestedChannel: '#ops-calls' },
  sales: { label: 'Sales', suggestedChannel: '#ops-sales' },
  audit: { label: 'Audit', suggestedChannel: '#ops-audit' },
  inbox: { label: 'Slack inbox', suggestedChannel: '#ops-inbox' },
  errors: { label: 'Bot errors', suggestedChannel: '#ops-log' },
} as const;

export type ReportType = keyof typeof REPORT_TYPES;
export const reportTypes = Object.keys(REPORT_TYPES) as ReportType[];

export function isReportType(value: string): value is ReportType {
  return Object.hasOwn(REPORT_TYPES, value);
}

export const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{2,}$/;

export interface ChannelRoute {
  reportType: ReportType;
  teamId: string;
  channelId: string;
}

export interface SlackChannel {
  channelId: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export class RouteValidationError extends Error {}

export async function getRoute(db: Queryable, reportType: ReportType): Promise<ChannelRoute | null> {
  const { rows } = await db.query<{ team_id: string; channel_id: string }>(
    'SELECT team_id, channel_id FROM channel_routes WHERE report_type = $1',
    [reportType],
  );
  return rows[0] ? { reportType, teamId: rows[0].team_id, channelId: rows[0].channel_id } : null;
}

export async function listRoutes(db: Queryable): Promise<Map<ReportType, ChannelRoute>> {
  const { rows } = await db.query<{ report_type: string; team_id: string; channel_id: string }>(
    'SELECT report_type, team_id, channel_id FROM channel_routes',
  );
  const out = new Map<ReportType, ChannelRoute>();
  for (const r of rows) {
    if (isReportType(r.report_type)) {
      out.set(r.report_type, { reportType: r.report_type, teamId: r.team_id, channelId: r.channel_id });
    }
  }
  return out;
}

/** Sets or, with a null channel, clears the route for one report type. */
export async function setRoute(
  pool: Pool,
  input: { reportType: ReportType; teamId: string; channelId: string | null },
  actor: Actor,
): Promise<{ changed: boolean }> {
  if (input.channelId !== null && !CHANNEL_ID_PATTERN.test(input.channelId)) {
    throw new RouteValidationError('That is not a Slack channel ID. It looks like C012ABCDEF.');
  }
  return withTx(pool, async (tx) => {
    const before = await getRoute(tx, input.reportType);
    if ((before?.channelId ?? null) === input.channelId) return { changed: false };
    if (input.channelId === null) {
      await tx.query('DELETE FROM channel_routes WHERE report_type = $1', [input.reportType]);
    } else {
      await tx.query(
        `INSERT INTO channel_routes (report_type, team_id, channel_id, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (report_type) DO UPDATE
           SET team_id = EXCLUDED.team_id, channel_id = EXCLUDED.channel_id,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [input.reportType, input.teamId, input.channelId, actor],
      );
    }
    await recordAudit(tx, {
      actor,
      action: 'route.update',
      target: input.reportType,
      before: before && { channelId: before.channelId },
      after: input.channelId && { channelId: input.channelId },
    });
    return { changed: true };
  });
}

export async function listChannels(db: Queryable, teamId: string): Promise<SlackChannel[]> {
  const { rows } = await db.query<{
    channel_id: string;
    name: string;
    is_private: boolean;
    is_member: boolean;
  }>('SELECT channel_id, name, is_private, is_member FROM slack_channels WHERE team_id = $1 ORDER BY name', [
    teamId,
  ]);
  return rows.map((r) => ({
    channelId: r.channel_id,
    name: r.name,
    isPrivate: r.is_private,
    isMember: r.is_member,
  }));
}

/** Replaces the cached channel list with what Slack just returned. */
export async function replaceChannels(pool: Pool, teamId: string, channels: SlackChannel[]): Promise<void> {
  await withTx(pool, async (tx) => {
    await tx.query('DELETE FROM slack_channels WHERE team_id = $1', [teamId]);
    for (const c of channels) {
      await tx.query(
        `INSERT INTO slack_channels (team_id, channel_id, name, is_private, is_member) VALUES ($1, $2, $3, $4, $5)`,
        [teamId, c.channelId, c.name, c.isPrivate, c.isMember],
      );
    }
  });
}
