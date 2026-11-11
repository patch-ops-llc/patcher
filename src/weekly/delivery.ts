import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { AgentRunRecord } from '../fix/agentFix.js';
import { listAgentRuns } from '../fix/agentFix.js';
import type { Carrier } from '../recommendations/carriers.js';
import type { Recommendation, RecommendationRow } from '../recommendations/types.js';
import { recommendationFromRow } from '../recommendations/types.js';
import { getRoute, REPORT_TYPES } from '../settings/routes.js';
import { getSetting } from '../settings/settings.js';
import type { SlackBlock, SlackMessage } from '../slack/client.js';
import { SlackApiError } from '../slack/client.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES, clip, encodeRef, escapeMrkdwn } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import type { AuditCounts, AuditReport, TopItem } from './report.js';
import { TOP_FINDINGS, countsLine, rulesNote, titleLine } from './report.js';

export const AUDIT_CARRIER = 'audit_run';
const MAX_LINE_LENGTH = 160;

export interface AuditRun {
  id: string;
  trigger: string;
  status: 'running' | 'analyzing' | 'done' | 'failed';
  startedAt: Date;
  finishedAt: Date | null;
  counts: AuditCounts | null;
  report: AuditReport | null;
  error: string | null;
  slackTeam: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  postedAt: Date | null;
  postError: string | null;
}

interface AuditRunRow {
  id: string;
  trigger: string;
  status: AuditRun['status'];
  started_at: Date;
  finished_at: Date | null;
  counts: AuditCounts | null;
  report: AuditReport | null;
  error: string | null;
  slack_team: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: Date | null;
  post_error: string | null;
}

const runFromRow = (r: AuditRunRow): AuditRun => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  counts: r.counts,
  report: r.report,
  error: r.error,
  slackTeam: r.slack_team,
  slackChannel: r.slack_channel,
  slackTs: r.slack_ts,
  postedAt: r.posted_at,
  postError: r.post_error,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getAuditRun(db: Queryable, id: string): Promise<AuditRun | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<AuditRunRow>('SELECT * FROM audit_runs WHERE id = $1', [id]);
  return rows[0] ? runFromRow(rows[0]) : null;
}

/** Runs without their full report, for lists. */
export async function listAuditRuns(db: Queryable, limit = 30): Promise<AuditRun[]> {
  const { rows } = await db.query<AuditRunRow>(
    `SELECT id, trigger, status, started_at, finished_at, counts, NULL::jsonb AS report, error,
            slack_team, slack_channel, slack_ts, posted_at, post_error
       FROM audit_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(runFromRow);
}

async function carried(db: Queryable, runId: string): Promise<Recommendation[]> {
  const { rows } = await db.query<RecommendationRow>(
    'SELECT * FROM recommendations WHERE carrier_type = $1 AND carrier_id = $2',
    [AUDIT_CARRIER, runId],
  );
  return rows.map(recommendationFromRow);
}

const prLabel = (url: string): string => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : 'pull request';
};

/** What a fix recommendation's state adds to its line once someone has decided. */
function fixState(rec: Recommendation, agent: AgentRunRecord | undefined): string {
  const by = rec.decidedBy ? ` by <@${rec.decidedBy}>` : '';
  switch (rec.status) {
    case 'drafted':
    case 'posted':
      return '';
    case 'approved':
    case 'executing':
      return ` · fix approved${by} · starting agent`;
    case 'done':
      if (agent?.status === 'finished') return agent.prUrl ? ` · <${agent.prUrl}|${prLabel(agent.prUrl)}> ready for review` : ' · agent finished without a pull request';
      if (agent?.status === 'failed' || agent?.status === 'timed_out') return ` · <${agent.agentUrl}|agent> did not finish`;
      return agent ? ` · fix approved${by} · <${agent.agentUrl}|agent running>` : ` · fix approved${by}`;
    case 'failed':
      return ' · fix failed to start';
    case 'dismissed':
      return ` · fix dismissed${by}`;
    case 'expired':
      return ' · fix expired with no decision';
  }
}

/**
 * The one message for an audit run (design 7.4): a title, the counts, and the top findings,
 * each with one button. A finding with a fix waiting for a decision gets "Fix N", which is
 * the approve button of that recommendation; any other gets "Details N", a link to the
 * finding. The last button opens the full report. Five lines and four buttons at most.
 */
export function auditReportMessage(
  input: { runId: string; counts: AuditCounts; top: TopItem[]; note?: string | null },
  recommendations: Recommendation[],
  agents: AgentRunRecord[],
  appBaseUrl: string,
): SlackMessage {
  const top = input.top.slice(0, TOP_FINDINGS);
  const lines = [`*${escapeMrkdwn(titleLine(input.counts))}*`, escapeMrkdwn(countsLine(input.counts, input.note))];
  const buttons: SlackBlock[] = [];
  if (!top.length) lines.push('No open findings.');

  top.forEach((item, index) => {
    const n = index + 1;
    const rec = item.recommendationId ? recommendations.find((r) => r.id === item.recommendationId) : undefined;
    const agent = rec ? agents.filter((a) => a.recommendationId === rec.id).at(-1) : undefined;
    const state = rec ? fixState(rec, agent) : '';
    // The state is added after clipping, so a long finding cannot push the outcome off the line.
    lines.push(`${n}. ${escapeMrkdwn(clip(item.line, MAX_LINE_LENGTH - 60))}${state}`);
    if (rec?.status === 'posted') {
      buttons.push({
        type: 'button',
        action_id: `${ACTION_IDS.approve}:${n}`,
        text: { type: 'plain_text', text: `Fix ${n} via agent` },
        value: encodeRef(rec),
        ...(index === 0 ? { style: 'primary' } : {}),
      });
    } else {
      buttons.push({
        type: 'button',
        action_id: `audit_finding:${n}`,
        text: { type: 'plain_text', text: `Details ${n}` },
        url: `${appBaseUrl}/audits/findings/${item.findingId}`,
      });
    }
  });
  buttons.push({
    type: 'button',
    action_id: 'audit_report',
    text: { type: 'plain_text', text: 'Full report' },
    url: `${appBaseUrl}/audits/${input.runId}`,
  });

  const kept = lines.slice(0, MAX_LINES);
  return {
    text: titleLine(input.counts),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: kept.join('\n') } },
      { type: 'actions', elements: buttons.slice(0, MAX_BUTTONS) },
    ],
  };
}

export type ReportPostOutcome = 'posted' | 'skipped' | 'held';

const HOLD_HINT: Record<string, string> = {
  not_in_channel: 'Invite the bot to the channel, then post again.',
  channel_not_found: 'The bot cannot see that channel. Invite it, or pick another channel.',
  is_archived: 'That channel is archived. Pick another channel.',
  not_configured: 'Slack is not configured yet.',
};

/**
 * Posts the report to the channel routed for audits and, in the same transaction, marks the
 * fix recommendations it carries as posted, which is what makes their buttons valid. Held,
 * like any recommendation, while paused or while there is no channel.
 */
export async function postAuditReport(deps: WorkerDeps, runId: string): Promise<ReportPostOutcome> {
  let blockedNotice: { text: string; channel: string } | undefined;

  const outcome = await withTx(deps.pool, async (tx): Promise<ReportPostOutcome> => {
    const { rows } = await tx.query<AuditRunRow>('SELECT * FROM audit_runs WHERE id = $1 FOR UPDATE', [runId]);
    const row = rows[0];
    if (!row || row.status !== 'done' || row.posted_at || !row.report || !row.counts) return 'skipped';

    const hold = async (reason: string): Promise<ReportPostOutcome> => {
      await tx.query('UPDATE audit_runs SET post_error = $2 WHERE id = $1', [runId, reason]);
      return 'held';
    };

    // A report that waited (no channel, paused) until a newer audit finished is out of date.
    // The newer one is posted instead, and the fixes this one proposed are closed unposted.
    const newer = await tx.query(
      `SELECT 1 FROM audit_runs WHERE status = 'done' AND started_at > $1 LIMIT 1`,
      [row.started_at],
    );
    if (newer.rowCount) {
      await tx.query(`UPDATE audit_runs SET post_error = 'Not posted: a newer audit replaced it.' WHERE id = $1`, [runId]);
      const closed = await tx.query<{ id: string }>(
        `UPDATE recommendations SET status = 'expired', last_error = 'Not posted: a newer audit replaced this report.', updated_at = now()
          WHERE carrier_type = $1 AND carrier_id = $2 AND status = 'drafted' RETURNING id`,
        [AUDIT_CARRIER, runId],
      );
      for (const rec of closed.rows) {
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'recommendation.expire',
          target: rec.id,
          before: { status: 'drafted' },
          after: { status: 'expired', reason: 'superseded' },
        });
      }
      return 'skipped';
    }
    if (await getSetting(tx, 'paused')) return hold('Waiting: Patcher is paused.');
    if (!deps.hubTeamId) return hold('Waiting: Slack is not configured yet.');
    const route = await getRoute(tx, 'audit');
    if (!route) return hold(`Waiting: no channel is set for ${REPORT_TYPES.audit.label} reports.`);

    const drafted = await tx.query<RecommendationRow>(
      `SELECT * FROM recommendations WHERE carrier_type = $1 AND carrier_id = $2 AND status = 'drafted' FOR UPDATE`,
      [AUDIT_CARRIER, runId],
    );
    const fixes = drafted.rows.map((r) => recommendationFromRow({ ...r, status: 'posted' }));

    let ts: string;
    try {
      ({ ts } = await deps.slack.postMessage({
        channel: route.channelId,
        ...auditReportMessage({ runId, counts: row.counts, top: row.report.top, note: rulesNote(row.report) }, fixes, [], deps.appBaseUrl),
      }));
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        const hint = HOLD_HINT[err.code] ?? 'Fix the cause, then post again.';
        blockedNotice = { channel: route.channelId, text: `Could not post the audit report to <#${route.channelId}>: ${err.code}. ${hint}` };
        return hold(`Slack refused the post (${err.code}). ${hint}`);
      }
      throw err;
    }

    await tx.query(
      `UPDATE audit_runs SET slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now(), post_error = NULL WHERE id = $1`,
      [runId, route.teamId, route.channelId, ts],
    );
    await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'audit.report.post', target: runId, after: { channel: route.channelId, ts } });

    const expireHours = await getSetting(tx, 'approvals.expire_hours');
    for (const fix of fixes) {
      await tx.query(
        `UPDATE recommendations
            SET status = 'posted', slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now(),
                expires_at = now() + make_interval(hours => $5), last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [fix.id, route.teamId, route.channelId, ts, expireHours],
      );
      await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'recommendation.post', target: fix.id, after: { channel: route.channelId, ts, carrier: runId } });
    }
    return 'posted';
  });

  if (blockedNotice) await notifyOps(deps, blockedNotice.text, { exceptChannel: blockedNotice.channel });
  return outcome;
}

/** Edits the report in place so each line shows what happened to its fix. */
export async function renderAuditReport(deps: WorkerDeps, runId: string): Promise<void> {
  const run = await getAuditRun(deps.pool, runId);
  if (!run?.slackChannel || !run.slackTs || !run.report || !run.counts) return;
  const fixes = await carried(deps.pool, runId);
  const agents = await listAgentRuns(
    deps.pool,
    fixes.map((f) => f.id),
  );
  await deps.slack.updateMessage({
    channel: run.slackChannel,
    ts: run.slackTs,
    ...auditReportMessage({ runId, counts: run.counts, top: run.report.top, note: rulesNote(run.report) }, fixes, agents, deps.appBaseUrl),
  });
}

export const auditCarrier: Carrier = {
  type: AUDIT_CARRIER,
  requestPost: (deps, runId) => deps.queue.enqueue('audit.report.post', { runId }),
  render: renderAuditReport,
};

/** After a resume or a new channel route: the latest report, if it is still waiting to be posted. */
export async function resumeHeldReports(deps: Pick<WorkerDeps, 'pool' | 'queue'>): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM audit_runs
      WHERE status = 'done' AND posted_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
  );
  for (const row of rows) await deps.queue.enqueue('audit.report.post', { runId: row.id });
  return rows.length;
}
