import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { withTx } from '../db/pool.js';
import { getSetting } from '../settings/settings.js';
import { SlackApiError } from '../slack/client.js';
import { reminderReply } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import type { RecommendationRow } from './types.js';
import { recommendationFromRow } from './types.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The `approvals.expire` schedule. A recommendation gets exactly one reminder, as a thread
 * reply, when it is close to expiry; it is expired only on a later run, so nothing ever
 * expires without the reminder having gone out first.
 */
export async function runExpiry(deps: WorkerDeps, now: Date = new Date()): Promise<string> {
  const reminderHours = await getSetting(deps.pool, 'approvals.reminder_hours');
  const due = await deps.pool.query<{ id: string }>(
    `SELECT id FROM recommendations
      WHERE status = 'posted' AND expires_at IS NOT NULL AND expires_at <= $1
      ORDER BY expires_at`,
    [new Date(now.getTime() + reminderHours * HOUR_MS)],
  );

  let reminded = 0;
  let expired = 0;
  for (const { id } of due.rows) {
    await withTx(deps.pool, async (tx) => {
      const { rows } = await tx.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0] || rows[0].status !== 'posted' || !rows[0].expires_at) return;
      const rec = recommendationFromRow(rows[0]);
      const msLeft = rec.expiresAt!.getTime() - now.getTime();

      if (!rec.remindedAt) {
        if (rec.slackChannel && rec.slackTs) {
          try {
            await deps.slack.postMessage({
              channel: rec.slackChannel,
              threadTs: rec.slackTs,
              text: reminderReply(msLeft / HOUR_MS),
            });
          } catch (err) {
            if (!(err instanceof SlackApiError) || err.retryable) throw err;
            deps.log.warn('could not post reminder', { recommendationId: id, code: err.code });
          }
        }
        await tx.query('UPDATE recommendations SET reminded_at = $2 WHERE id = $1', [id, now]);
        reminded += 1;
        return;
      }

      if (msLeft <= 0) {
        await tx.query(`UPDATE recommendations SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: 'recommendation.expire',
          target: id,
          before: { status: 'posted' },
          after: { status: 'expired' },
        });
        await deps.queue.enqueue('recommendation.sync', { recommendationId: id }, { tx });
        expired += 1;
      }
    });
  }
  return `${reminded} reminded, ${expired} expired`;
}
