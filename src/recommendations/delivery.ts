import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { withTx } from '../db/pool.js';
import { getRoute, REPORT_TYPES } from '../settings/routes.js';
import { getSetting } from '../settings/settings.js';
import { SlackApiError } from '../slack/client.js';
import { detailsReply, recommendationMessage } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { getRecommendation } from './service.js';
import type { Recommendation, RecommendationRow } from './types.js';
import { recommendationFromRow } from './types.js';

export type PostOutcome =
  | 'posted'
  /** Not in `drafted` any more; nothing to do. */
  | 'skipped'
  /** Shown on a shared message; its carrier was asked to post it. */
  | 'carried'
  /** Waiting on a person: pause, a missing route, or Slack refusing the post. */
  | 'held'
  /** The channel is at its hourly limit; the job was put back for later. */
  | 'deferred';

const HOLD_HINT: Record<string, string> = {
  not_in_channel: 'Invite the bot to the channel, then post again.',
  channel_not_found: 'The bot cannot see that channel. Invite it, or pick another channel.',
  is_archived: 'That channel is archived. Pick another channel.',
  not_configured: 'Slack is not configured yet.',
};

/**
 * Posts a drafted recommendation to the channel routed for its report type. The route is
 * read here, at post time, so a change in the UI applies to whatever has not been posted.
 */
export async function postRecommendation(deps: WorkerDeps, id: string): Promise<PostOutcome> {
  let blockedNotice: { text: string; channel: string } | undefined;

  const carried = await deps.pool.query<{ carrier_type: string | null; carrier_id: string | null; status: string }>(
    'SELECT carrier_type, carrier_id, status FROM recommendations WHERE id = $1',
    [id],
  );
  const carrierRow = carried.rows[0];
  if (carrierRow?.carrier_type && carrierRow.carrier_id) {
    if (carrierRow.status !== 'drafted') return 'skipped';
    const carrier = deps.carriers.get(carrierRow.carrier_type);
    if (!carrier) throw new Error(`No carrier is registered for ${carrierRow.carrier_type}`);
    await carrier.requestPost(deps, carrierRow.carrier_id);
    return 'carried';
  }

  const outcome = await withTx(deps.pool, async (tx): Promise<PostOutcome> => {
    const { rows } = await tx.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0] || rows[0].status !== 'drafted') return 'skipped';
    const rec = recommendationFromRow(rows[0]);

    const hold = async (reason: string): Promise<PostOutcome> => {
      await tx.query('UPDATE recommendations SET last_error = $2, updated_at = now() WHERE id = $1', [id, reason]);
      return 'held';
    };

    if (await getSetting(tx, 'paused')) return hold('Waiting: Patcher is paused.');
    if (!deps.hubTeamId) return hold('Waiting: Slack is not configured yet.');
    const route = await getRoute(tx, rec.reportType);
    if (!route) return hold(`Waiting: no channel is set for ${REPORT_TYPES[rec.reportType].label} reports.`);

    const cap = await getSetting(tx, 'slack.max_posts_per_hour');
    const recent = await tx.query<{ n: string; oldest: Date | null }>(
      `SELECT count(DISTINCT slack_ts) AS n, min(posted_at) AS oldest
         FROM recommendations
        WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'`,
      [route.channelId],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= cap) {
      const oldest = recent.rows[0]?.oldest ?? new Date();
      const startAfter = new Date(oldest.getTime() + 60 * 60 * 1000 + 5_000);
      await deps.queue.enqueue('recommendation.post', { recommendationId: id }, { tx, startAfter });
      await tx.query('UPDATE recommendations SET last_error = $2, updated_at = now() WHERE id = $1', [
        id,
        `Waiting: this channel has reached ${cap} posts in an hour.`,
      ]);
      return 'deferred';
    }

    let ts: string;
    try {
      ({ ts } = await deps.slack.postMessage({
        channel: route.channelId,
        ...recommendationMessage({ ...rec, status: 'posted' }, deps.catalog.label(rec.kind)),
      }));
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        const hint = HOLD_HINT[err.code] ?? 'Fix the cause, then post again.';
        blockedNotice = {
          channel: route.channelId,
          text: `Could not post to <#${route.channelId}>: ${err.code}. ${hint}`,
        };
        return hold(`Slack refused the post (${err.code}). ${hint}`);
      }
      throw err;
    }

    const expireHours = await getSetting(tx, 'approvals.expire_hours');
    await tx.query(
      `UPDATE recommendations
          SET status = 'posted', slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now(),
              expires_at = now() + make_interval(hours => $5), last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [id, route.teamId, route.channelId, ts, expireHours],
    );
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'recommendation.post',
      target: id,
      after: { channel: route.channelId, ts },
    });
    return 'posted';
  });

  if (blockedNotice) await notifyOps(deps, blockedNotice.text, { exceptChannel: blockedNotice.channel });
  return outcome;
}

/**
 * Edits whichever Slack message shows this recommendation: its own, or the shared message
 * of its carrier. Slack errors are thrown for the caller to sort into retry or give up.
 */
export async function renderRecommendation(deps: WorkerDeps, rec: Recommendation): Promise<void> {
  if (rec.carrierType && rec.carrierId) {
    const carrier = deps.carriers.get(rec.carrierType);
    if (!carrier) throw new Error(`No carrier is registered for ${rec.carrierType}`);
    await carrier.render(deps, rec.carrierId);
    return;
  }
  if (!rec.slackChannel || !rec.slackTs) return;
  await deps.slack.updateMessage({
    channel: rec.slackChannel,
    ts: rec.slackTs,
    ...recommendationMessage(rec, deps.catalog.label(rec.kind)),
  });
}

/** Edits the Slack message in place to match the recommendation's current state. */
export async function syncMessage(deps: WorkerDeps, id: string): Promise<void> {
  const rec = await getRecommendation(deps.pool, id);
  if (!rec) return;
  try {
    await renderRecommendation(deps, rec);
  } catch (err) {
    // The message was deleted, or the bot lost the channel. The record in Patcher stands.
    if (err instanceof SlackApiError && !err.retryable) {
      deps.log.warn('could not update slack message', { recommendationId: id, code: err.code });
      return;
    }
    throw err;
  }
}

/** Posts the evidence and the exact action once per version, as a thread reply. */
export async function postDetails(deps: WorkerDeps, id: string): Promise<void> {
  await withTx(deps.pool, async (tx) => {
    const { rows } = await tx.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return;
    const rec = recommendationFromRow(rows[0]);
    if (!rec.slackChannel || !rec.slackTs || rec.detailsTs) return;
    try {
      const { ts } = await deps.slack.postMessage({
        channel: rec.slackChannel,
        threadTs: rec.slackTs,
        ...detailsReply(rec, deps.catalog.describe(rec.action), deps.appBaseUrl),
      });
      await tx.query('UPDATE recommendations SET details_ts = $2 WHERE id = $1', [id, ts]);
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        deps.log.warn('could not post details', { recommendationId: id, code: err.code });
        return;
      }
      throw err;
    }
  });
}

/** After a resume, a new route or a restart: try again everything that was waiting. */
export async function resumeHeld(deps: WorkerDeps): Promise<{ posts: number; actions: number }> {
  const drafted = await deps.pool.query<{ id: string }>(
    `SELECT id FROM recommendations WHERE status = 'drafted' ORDER BY created_at`,
  );
  for (const row of drafted.rows) {
    await deps.queue.enqueue('recommendation.post', { recommendationId: row.id });
  }
  const pending = await deps.pool.query<{ id: string }>(
    `SELECT a.id FROM actions a JOIN recommendations r ON r.id = a.recommendation_id
      WHERE a.status = 'pending' AND r.status = 'approved' ORDER BY a.created_at`,
  );
  for (const row of pending.rows) {
    await deps.queue.enqueue('action.execute', { actionId: row.id });
  }
  return { posts: drafted.rowCount ?? 0, actions: pending.rowCount ?? 0 };
}
