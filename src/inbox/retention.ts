import type { Pool } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { getSetting } from '../settings/settings.js';
import { INBOX_SOURCE } from './types.js';

const REMOVED = 'Removed after the retention period.';

/**
 * Design 8.7: message text is kept only as long as triage and approval need it. After the
 * retention period the text of a message, the draft written from it and the words quoted
 * as evidence are removed. The ids, the link and Patcher's own summary stay.
 */
export async function purgeInbox(pool: Pool): Promise<string> {
  const days = await getSetting(pool, 'inbox.retention_days');
  return withTx(pool, async (tx) => {
    const messages = await tx.query(
      `UPDATE slack_messages SET text = NULL
        WHERE text IS NOT NULL AND (purge_after <= now() OR created_at <= now() - make_interval(days => $1))`,
      [days],
    );
    // The reader's own messages are kept only to see that something was answered.
    await tx.query(`DELETE FROM slack_messages WHERE own AND created_at <= now() - make_interval(days => $1)`, [days]);
    const bundles = await tx.query<{ recommendation_id: string | null }>(
      `UPDATE slack_bundles SET draft = NULL, quote = NULL, purged_at = now()
        WHERE purged_at IS NULL AND created_at <= now() - make_interval(days => $1)
        RETURNING recommendation_id`,
      [days],
    );
    const recommendations = bundles.rows.flatMap((r) => (r.recommendation_id ? [r.recommendation_id] : []));
    if (recommendations.length) {
      await tx.query(
        `UPDATE recommendations
            SET evidence = (SELECT jsonb_agg(e || jsonb_build_object('quote', $2::text)) FROM jsonb_array_elements(evidence) e)
          WHERE id = ANY($1) AND source_type = $3`,
        [recommendations, REMOVED, INBOX_SOURCE],
      );
    }
    await tx.query(`UPDATE inbound_emails SET subject = NULL WHERE subject IS NOT NULL AND received_at <= now() - interval '7 days'`);
    await tx.query(`DELETE FROM inbound_emails WHERE received_at <= now() - interval '30 days'`);
    await tx.query(`DELETE FROM slack_drop_counts WHERE day < current_date - 90`);
    await tx.query(`DELETE FROM slack_names WHERE fetched_at <= now() - interval '30 days'`);
    const n = messages.rowCount ?? 0;
    return `${n} Slack message${n === 1 ? '' : 's'} cleared`;
  });
}
