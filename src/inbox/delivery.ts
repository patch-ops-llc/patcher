import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { FIX_ACTION } from '../fix/agentFix.js';
import type { Carrier } from '../recommendations/carriers.js';
import type { Recommendation } from '../recommendations/types.js';
import { getRoute, REPORT_TYPES } from '../settings/routes.js';
import { getSetting } from '../settings/settings.js';
import type { SlackBlock, SlackMessage } from '../slack/client.js';
import { SlackApiError } from '../slack/client.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES, clip, encodeRef, escapeMrkdwn } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import type { FeedbackDecision, Item } from './store.js';
import { digestItems, getDigest, getItem, recordFeedback, repliedSince } from './store.js';
import type { Digest, DigestRow } from './types.js';
import { DISMISS_REASONS, INBOX_CARRIER, channelLabel, digestFromRow } from './types.js';

/**
 * How a Slack item is shown in the hub (design 8.8). An urgent item gets a message of its
 * own; the rest are numbered lines of the next digest. Either way the item is one
 * recommendation in the shared loop, and this module only draws it and marks it posted.
 */
export const INBOX_ACTIONS = {
  /** Opens the item: the draft to copy, the link, and the decision. */
  open: 'inbox_open',
  /** The one-tap reason after a dismissal. */
  reason: 'inbox_reason',
  /** A link button. Slack reports the click; there is nothing to do. */
  link: 'inbox_link',
} as const;

const MAX_SUMMARY = 140;
const MAX_DIGEST_LINE = 110;
/** Numbered lines on a digest. One more item than this and the rest are behind "Show all". */
const MAX_DIGEST_ITEMS = MAX_LINES - 1;

const button = (text: string, actionId: string, value: string, style?: 'primary'): SlackBlock => ({
  type: 'button',
  action_id: actionId,
  text: { type: 'plain_text', text },
  value,
  ...(style ? { style } : {}),
});

const linkButton = (text: string, url: string, suffix = ''): SlackBlock => ({
  type: 'button',
  action_id: `${INBOX_ACTIONS.link}${suffix}`,
  text: { type: 'plain_text', text },
  url,
});

function message(lines: string[], buttons: SlackBlock[] = []): SlackMessage {
  const kept = lines.slice(0, MAX_LINES);
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: kept.join('\n') } }];
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons.slice(0, MAX_BUTTONS) });
  return { text: kept[0]!.replace(/\*/g, ''), blocks };
}

const by = (rec: Recommendation): string => (rec.decidedBy ? ` by <@${rec.decidedBy}>` : '');
const isPending = (rec: Recommendation | null): boolean => rec?.status === 'drafted' || rec?.status === 'posted';
const isAgent = (rec: Recommendation): boolean => rec.action.type === FIX_ACTION;

/** "Acme Slack · #project-portal · Dana, 2:40 PM": where the message is and who wrote it. */
export function itemHead(item: Item): string {
  const { bundle } = item;
  const at = bundle.lastAt ?? bundle.createdAt;
  const unix = Math.floor(at.getTime() / 1000);
  const when = `<!date^${unix}^{date_short_pretty} {time}|${at.toISOString().slice(0, 16).replace('T', ' ')} UTC>`;
  const who = bundle.senderName ? `${escapeMrkdwn(clip(bundle.senderName, 40))}, ` : '';
  return `*${escapeMrkdwn(clip(item.workspaceName, 40))} Slack* · ${escapeMrkdwn(clip(channelLabel(bundle), 40))} · ${who}${when}`;
}

/** What happened to an item, in a few words, once it is no longer waiting. */
export function itemState(item: Item): string {
  const { rec, bundle, feedback } = item;
  if (!rec) return bundle.status === 'handled' ? 'handled' : 'closed';
  const what = isAgent(rec) ? 'agent' : 'task';
  switch (rec.status) {
    case 'drafted':
    case 'posted':
      return 'waiting';
    case 'approved':
    case 'executing':
      return `${what} approved${by(rec)} · running`;
    case 'done':
      return isAgent(rec) ? `agent started${by(rec)}` : `task recorded${by(rec)}`;
    case 'failed':
      return `${what} approved${by(rec)} · failed`;
    case 'dismissed':
      return `dismissed${by(rec)}${feedback?.reason ? ` · ${DISMISS_REASONS[feedback.reason].toLowerCase()}` : ''}`;
    case 'expired':
      return bundle.status === 'handled' ? `handled: ${(bundle.statusDetail ?? 'no longer needs you').replace(/\.$/, '').toLowerCase()}` : 'expired with no decision';
  }
}

const summaryOf = (item: Item): string => escapeMrkdwn(clip(item.bundle.summary ?? item.rec?.title ?? 'A Slack message', MAX_SUMMARY));

/** The message of an item that is posted on its own (design 8.8, "Urgent item"). */
export function itemMessage(item: Item): SlackMessage {
  const { bundle, rec } = item;
  const head = itemHead(item);
  if (!rec) return message([`${head} · ${itemState(item)}`]);
  if (isPending(rec)) {
    const second =
      bundle.status === 'unanalysed'
        ? `_${escapeMrkdwn(clip(bundle.statusDetail ?? 'Not analysed.', MAX_SUMMARY))}_`
        : `Suggest: ${escapeMrkdwn(clip(bundle.suggestion ?? 'read it in Slack', MAX_SUMMARY))}`;
    const ref = encodeRef(rec);
    const buttons = [
      ...(bundle.draft ? [button('Copy draft', INBOX_ACTIONS.open, bundle.id)] : []),
      ...(bundle.link ? [linkButton('Open in Slack', bundle.link)] : []),
      button(isAgent(rec) ? 'Agent' : bundle.draft ? 'Task only' : 'Task', ACTION_IDS.approve, ref, 'primary'),
      button('Dismiss', ACTION_IDS.dismiss, ref),
      button('Details', ACTION_IDS.details, ref),
    ];
    return message([head, summaryOf(item), second], buttons);
  }
  const line = `${head} · ${summaryOf(item)} · ${itemState(item)}`;
  if (rec.status === 'failed') return message([line], [button('Retry', ACTION_IDS.retry, encodeRef(rec)), button('Details', ACTION_IDS.details, encodeRef(rec))]);
  if (rec.status === 'dismissed' && !item.feedback?.reason) {
    // Design 8.6: a dismissal asks for a one-tap reason, which the next triage learns from.
    return message(
      [line, 'Why? One tap.'],
      Object.entries(DISMISS_REASONS).map(([reason, label], i) => button(label, `${INBOX_ACTIONS.reason}:${i + 1}`, `${bundle.id}|${reason}`)),
    );
  }
  return message([line]);
}

/** The digest (design 8.8): one counted headline, the items as numbered lines with Open, and a link to the rest. */
export function digestMessage(digest: Digest, items: Item[], appBaseUrl: string): SlackMessage {
  const waiting = items.filter((i) => isPending(i.rec)).length;
  const { stats } = digest;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const head = `*Slack digest* · ${plural(stats.workspaces, 'workspace')} · ${stats.messages} new · ${waiting === items.length ? `${items.length} need you` : `${waiting} of ${items.length} still need you`}`;
  const shown = items.length > MAX_DIGEST_ITEMS ? items.slice(0, MAX_DIGEST_ITEMS - 1) : items;
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: head } }];
  for (const item of shown) {
    const position = item.bundle.digestPosition ?? 0;
    const pending = isPending(item.rec);
    const text = `${position}. ${escapeMrkdwn(clip(item.workspaceName, 30))} · ${escapeMrkdwn(clip(item.bundle.summary ?? 'A Slack message', MAX_DIGEST_LINE))}`;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: pending ? text : `~${text}~ · ${itemState(item)}` },
      ...(pending ? { accessory: button('Open', `${INBOX_ACTIONS.open}:${position}`, item.bundle.id) } : {}),
    });
  }
  blocks.push({ type: 'actions', elements: [linkButton(shown.length < items.length ? `Show all ${items.length}` : 'Open in Patcher', `${appBaseUrl}/inbox/digests/${digest.id}`)] });
  return { text: head.replace(/\*/g, ''), blocks };
}

const HOLD_HINT: Record<string, string> = {
  not_in_channel: 'Invite the bot to the channel, then post again.',
  channel_not_found: 'The bot cannot see that channel. Invite it, or pick another channel.',
  is_archived: 'That channel is archived. Pick another channel.',
  not_configured: 'Slack is not configured yet.',
};

async function markPosted(tx: Queryable, recommendationIds: string[], where: { team: string | null; channel: string; ts: string }, carrier: string): Promise<void> {
  const expireHours = await getSetting(tx, 'approvals.expire_hours');
  for (const id of recommendationIds) {
    const { rowCount } = await tx.query(
      `UPDATE recommendations
          SET status = 'posted', slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now(),
              expires_at = now() + make_interval(hours => $5), last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'drafted'`,
      [id, where.team, where.channel, where.ts, expireHours],
    );
    if (rowCount) await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'recommendation.post', target: id, after: { channel: where.channel, ts: where.ts, carrier } });
  }
}

export type ItemPostOutcome = 'posted' | 'updated' | 'nothing' | 'held' | 'to_digest' | 'not_found';

/**
 * Posts an urgent item's own message, or edits the one it has, and in the same transaction
 * marks its recommendation posted, which is what makes its buttons valid. Held, like any
 * recommendation, while paused or while there is no channel. When the channel has had its
 * posts for the hour, the item waits for the next digest (design 4.1).
 */
export async function postItem(deps: WorkerDeps, bundleId: string): Promise<ItemPostOutcome> {
  let blockedNotice: { text: string; channel: string } | undefined;

  const outcome = await withTx(deps.pool, async (tx): Promise<ItemPostOutcome> => {
    const locked = await tx.query('SELECT 1 FROM slack_bundles WHERE id = $1 FOR UPDATE', [bundleId]);
    if (!locked.rowCount) return 'not_found';
    const item = await getItem(tx, bundleId);
    if (!item?.rec || item.bundle.delivery !== 'now' || item.bundle.digestId) return 'nothing';
    const { bundle, rec } = item;
    // Nothing is posted about an item that was closed before it could be shown.
    if (!bundle.slackTs && rec.status !== 'drafted') return 'nothing';
    const content = itemMessage({ ...item, rec: rec.status === 'drafted' ? { ...rec, status: 'posted' } : rec });

    const hold = async (reason: string): Promise<ItemPostOutcome> => {
      await tx.query('UPDATE slack_bundles SET post_error = $2 WHERE id = $1', [bundleId, reason]);
      return 'held';
    };
    if (await getSetting(tx, 'paused')) return hold('Waiting: Patcher is paused.');
    if (!deps.hubTeamId) return hold('Waiting: Slack is not configured yet.');

    let channel = bundle.slackChannel;
    let team = bundle.slackTeam;
    let ts = bundle.slackTs;
    try {
      if (channel && ts) {
        await deps.slack.updateMessage({ channel, ts, ...content });
      } else {
        const route = await getRoute(tx, 'inbox');
        if (!route) return hold(`Waiting: no channel is set for ${REPORT_TYPES.inbox.label} reports.`);
        channel = route.channelId;
        team = route.teamId;
        const cap = await getSetting(tx, 'slack.max_posts_per_hour');
        const recent = await tx.query<{ n: string }>(
          `SELECT count(DISTINCT slack_ts) AS n FROM recommendations WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'`,
          [channel],
        );
        if (Number(recent.rows[0]?.n ?? 0) >= cap) {
          await tx.query(`UPDATE slack_bundles SET delivery = 'digest', post_error = NULL, updated_at = now() WHERE id = $1`, [bundleId]);
          return 'to_digest';
        }
        ({ ts } = await deps.slack.postMessage({ channel, ...content }));
        await tx.query('UPDATE slack_bundles SET slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now() WHERE id = $1', [bundleId, team, channel, ts]);
      }
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        const hint = HOLD_HINT[err.code] ?? 'Fix the cause, then post again.';
        if (channel) blockedNotice = { channel, text: `Could not post a Slack item to <#${channel}>: ${err.code}. ${hint}` };
        return hold(`Slack refused the post (${err.code}). ${hint}`);
      }
      throw err;
    }
    await tx.query('UPDATE slack_bundles SET post_error = NULL WHERE id = $1', [bundleId]);
    await markPosted(tx, [rec.id], { team, channel, ts }, bundleId);
    return bundle.slackTs ? 'updated' : 'posted';
  });

  if (blockedNotice) await notifyOps(deps, blockedNotice.text, { exceptChannel: blockedNotice.channel });
  return outcome;
}

export type DigestPostOutcome = 'posted' | 'updated' | 'nothing' | 'held' | 'not_found';

/** Posts a digest, or edits the one that is up, and marks the recommendations it lists as posted. */
export async function postDigest(deps: WorkerDeps, digestId: string): Promise<DigestPostOutcome> {
  let blockedNotice: { text: string; channel: string } | undefined;

  const outcome = await withTx(deps.pool, async (tx): Promise<DigestPostOutcome> => {
    const locked = await tx.query<DigestRow>('SELECT * FROM slack_digests WHERE id = $1 FOR UPDATE', [digestId]);
    if (!locked.rows[0]) return 'not_found';
    const digest = digestFromRow(locked.rows[0]);
    const loaded = await digestItems(tx, digestId);
    if (!loaded.length) return 'nothing';
    const drafted = loaded.flatMap((i) => (i.rec?.status === 'drafted' ? [i.rec.id] : []));
    // Drawn as it will be once this post has gone out.
    const items = loaded.map((i) => (i.rec?.status === 'drafted' ? { ...i, rec: { ...i.rec, status: 'posted' as const } } : i));
    if (!digest.slackTs && !drafted.length) return 'nothing';
    const content = digestMessage(digest, items, deps.appBaseUrl);

    const hold = async (reason: string): Promise<DigestPostOutcome> => {
      await tx.query('UPDATE slack_digests SET post_error = $2 WHERE id = $1', [digestId, reason]);
      return 'held';
    };
    if (await getSetting(tx, 'paused')) return hold('Waiting: Patcher is paused.');
    if (!deps.hubTeamId) return hold('Waiting: Slack is not configured yet.');

    let channel = digest.slackChannel;
    let team = digest.slackTeam;
    let ts = digest.slackTs;
    try {
      if (channel && ts) {
        await deps.slack.updateMessage({ channel, ts, ...content });
      } else {
        const route = await getRoute(tx, 'inbox');
        if (!route) return hold(`Waiting: no channel is set for ${REPORT_TYPES.inbox.label} reports.`);
        channel = route.channelId;
        team = route.teamId;
        ({ ts } = await deps.slack.postMessage({ channel, ...content }));
        await tx.query('UPDATE slack_digests SET slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now() WHERE id = $1', [digestId, team, channel, ts]);
        await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'inbox.digest.post', target: digestId, after: { channel, ts, items: loaded.length } });
      }
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        const hint = HOLD_HINT[err.code] ?? 'Fix the cause, then post again.';
        if (channel) blockedNotice = { channel, text: `Could not post the Slack digest to <#${channel}>: ${err.code}. ${hint}` };
        return hold(`Slack refused the post (${err.code}). ${hint}`);
      }
      throw err;
    }
    await tx.query('UPDATE slack_digests SET post_error = NULL WHERE id = $1', [digestId]);
    await markPosted(tx, drafted, { team, channel, ts }, digestId);
    return digest.slackTs ? 'updated' : 'posted';
  });

  if (blockedNotice) await notifyOps(deps, blockedNotice.text, { exceptChannel: blockedNotice.channel });
  return outcome;
}

const DECIDED: Partial<Record<Recommendation['status'], FeedbackDecision>> = {
  approved: 'approved',
  executing: 'approved',
  done: 'approved',
  failed: 'approved',
  dismissed: 'dismissed',
};

/** Redraws whichever message shows the item, and notes how it ended for the next triage to learn from. */
export async function renderItem(deps: WorkerDeps, bundleId: string): Promise<void> {
  const item = await getItem(deps.pool, bundleId);
  if (!item?.rec) return;
  const { bundle, rec } = item;
  const decision = DECIDED[rec.status] ?? (rec.status === 'expired' ? (bundle.status === 'handled' ? 'handled' : 'expired') : null);
  if (decision && item.feedback?.decision !== decision) {
    await recordFeedback(deps.pool, bundleId, decision, rec.decidedBy);
    item.feedback = { decision, reason: decision === 'dismissed' ? (item.feedback?.reason ?? null) : null };
  }
  if (bundle.digestId) {
    const digest = await getDigest(deps.pool, bundle.digestId);
    if (!digest?.slackChannel || !digest.slackTs) return;
    const items = await digestItems(deps.pool, digest.id);
    await deps.slack.updateMessage({ channel: digest.slackChannel, ts: digest.slackTs, ...digestMessage(digest, items, deps.appBaseUrl) });
    return;
  }
  if (rec.status === 'drafted') {
    if (bundle.delivery === 'now') await deps.queue.enqueue('inbox.post', { bundleId });
    return;
  }
  if (!bundle.slackChannel || !bundle.slackTs) return;
  await deps.slack.updateMessage({ channel: bundle.slackChannel, ts: bundle.slackTs, ...itemMessage(item) });
}

/**
 * Closes an item that no longer needs the reader. The recommendation leaves the loop as
 * expired, with the reason, and the Slack message that shows it is redrawn.
 */
export async function closeHandled(deps: WorkerDeps, bundleId: string, detail: string): Promise<boolean> {
  const closed = await withTx(deps.pool, async (tx) => {
    const { rows } = await tx.query<{ recommendation_id: string | null; status: string }>(
      'SELECT recommendation_id, status FROM slack_bundles WHERE id = $1 FOR UPDATE',
      [bundleId],
    );
    const row = rows[0];
    if (!row || (row.status !== 'recommended' && row.status !== 'unanalysed')) return false;
    if (row.recommendation_id) {
      const updated = await tx.query(
        `UPDATE recommendations SET status = 'expired', last_error = $2, updated_at = now() WHERE id = $1 AND status IN ('drafted', 'posted')`,
        [row.recommendation_id, detail],
      );
      // Already decided by a person: that decision stands.
      if (!updated.rowCount) return false;
      await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'recommendation.expire', target: row.recommendation_id, after: { status: 'expired', reason: detail } });
    }
    await tx.query(`UPDATE slack_bundles SET status = 'handled', status_detail = $2, updated_at = now() WHERE id = $1`, [bundleId, detail]);
    await recordFeedback(tx, bundleId, 'handled', null);
    return true;
  });
  if (closed) await renderItem(deps, bundleId);
  return closed;
}

export const inboxCarrier: Carrier = {
  type: INBOX_CARRIER,
  async requestPost(deps, bundleId) {
    const { rows } = await deps.pool.query<{ delivery: string | null; slack_ts: string | null; digest_id: string | null }>(
      'SELECT delivery, slack_ts, digest_id FROM slack_bundles WHERE id = $1',
      [bundleId],
    );
    const row = rows[0];
    if (!row) return;
    // An item that waits for a digest is posted by the digest, at its time.
    if (row.digest_id) await deps.queue.enqueue('inbox.digest.post', { digestId: row.digest_id });
    else if (row.delivery === 'now' && !row.slack_ts) await deps.queue.enqueue('inbox.post', { bundleId });
  },
  render: renderItem,
  async label(deps, rec) {
    const { rows } = await deps.pool.query<{ digest_position: number | null }>('SELECT digest_position FROM slack_bundles WHERE recommendation_id = $1', [rec.id]);
    return rows[0]?.digest_position ? String(rows[0].digest_position) : null;
  },
};

const DIGEST_LIMIT = 30;

/**
 * The `slack.digest` schedule (design 8.6, step 7): everything that waits for a digest and
 * still needs the reader, in one message. Each item is rechecked first. When nothing is
 * left, nothing is posted.
 */
export async function runDigest(deps: WorkerDeps, trigger: string): Promise<string> {
  if (await getSetting(deps.pool, 'paused')) return 'Paused.';
  if (!(await getSetting(deps.pool, 'inbox.enabled'))) return 'The Slack reader is switched off.';
  const candidates = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM slack_bundles b JOIN recommendations r ON r.id = b.recommendation_id
      WHERE b.status IN ('recommended', 'unanalysed') AND b.delivery = 'digest' AND b.digest_id IS NULL AND r.status = 'drafted'
      ORDER BY b.urgent DESC, b.addressed DESC, b.first_at NULLS LAST, b.created_at
      LIMIT $1`,
    [DIGEST_LIMIT],
  );
  const ready: string[] = [];
  let handled = 0;
  for (const { id } of candidates.rows) {
    const item = await getItem(deps.pool, id);
    if (!item) continue;
    // Recheck (design 8.6, step 6): he may have answered since the item was written.
    if (await repliedSince(deps.pool, item.bundle)) {
      if (await closeHandled(deps, id, 'You replied in the conversation.')) handled += 1;
      continue;
    }
    ready.push(id);
  }
  if (!ready.length) return handled ? `Nothing needs you (${handled} already answered).` : 'Nothing needs you.';

  const digestId = await withTx(deps.pool, async (tx) => {
    const last = await tx.query<{ at: Date | null }>('SELECT max(created_at) AS at FROM slack_digests');
    const since = last.rows[0]?.at ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const counted = await tx.query<{ messages: string; workspaces: string }>(
      `SELECT count(*) AS messages, count(DISTINCT workspace_id) AS workspaces FROM slack_messages WHERE NOT own AND created_at > $1`,
      [since],
    );
    const inDigest = await tx.query<{ n: string }>('SELECT count(DISTINCT workspace_id) AS n FROM slack_bundles WHERE id = ANY($1)', [ready]);
    const stats = {
      workspaces: Math.max(Number(counted.rows[0]?.workspaces ?? 0), Number(inDigest.rows[0]?.n ?? 0)),
      messages: Math.max(Number(counted.rows[0]?.messages ?? 0), ready.length),
      items: ready.length,
    };
    const created = await tx.query<{ id: string }>('INSERT INTO slack_digests (trigger, stats) VALUES ($1, $2) RETURNING id', [trigger, JSON.stringify(stats)]);
    const id = created.rows[0]!.id;
    for (const [index, bundleId] of ready.entries()) {
      await tx.query('UPDATE slack_bundles SET digest_id = $2, digest_position = $3, updated_at = now() WHERE id = $1 AND digest_id IS NULL', [bundleId, id, index + 1]);
    }
    await deps.queue.enqueue('inbox.digest.post', { digestId: id }, { tx });
    return id;
  });
  deps.log.info('slack digest prepared', { digestId, items: ready.length, handled });
  return `${ready.length} item${ready.length === 1 ? '' : 's'} in the digest${handled ? `, ${handled} already answered` : ''}.`;
}

/** After a resume or a new channel: try again the posts that were waiting. */
export async function resumeHeldInboxPosts(deps: Pick<WorkerDeps, 'pool' | 'queue'>): Promise<number> {
  const items = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM slack_bundles b JOIN recommendations r ON r.id = b.recommendation_id
      WHERE b.delivery = 'now' AND b.slack_ts IS NULL AND b.digest_id IS NULL AND r.status = 'drafted'`,
  );
  for (const row of items.rows) await deps.queue.enqueue('inbox.post', { bundleId: row.id });
  const digests = await deps.pool.query<{ id: string }>(`SELECT id FROM slack_digests WHERE slack_ts IS NULL AND created_at > now() - interval '7 days'`);
  for (const row of digests.rows) await deps.queue.enqueue('inbox.digest.post', { digestId: row.id });
  return (items.rowCount ?? 0) + (digests.rowCount ?? 0);
}
