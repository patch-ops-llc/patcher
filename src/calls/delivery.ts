import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { AgentRunRecord } from '../fix/agentFix.js';
import { listAgentRuns } from '../fix/agentFix.js';
import type { Carrier } from '../recommendations/carriers.js';
import type { Catalog } from '../recommendations/catalog.js';
import type { Recommendation, RecommendationRow } from '../recommendations/types.js';
import { getRoute, REPORT_TYPES } from '../settings/routes.js';
import { getSetting } from '../settings/settings.js';
import type { SlackBlock, SlackMessage } from '../slack/client.js';
import { SlackApiError } from '../slack/client.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES, clip, encodeRef, escapeMrkdwn } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { CALL_CARRIER, carriedRecommendations, getCall, listMatches, listSuggestions } from './store.js';
import type { Call, CallMatch, CallRow, CallSuggestion, SuggestionType } from './types.js';
import { callFromRow, minutes } from './types.js';

/**
 * The one Slack message a call gets (design 5.4), edited in place as the call moves on:
 * the question "which project?", then the numbered suggestions with their buttons, then
 * the outcome. Each numbered line is a recommendation in the shared loop; this module only
 * draws them and marks them posted. Deciding them is the loop's business.
 */
export const CALL_ACTIONS = {
  project: 'call_project',
  approveAll: 'call_approve_all',
  pick: 'call_pick',
  wrongProject: 'call_wrong_project',
  details: 'call_details',
} as const;

const MAX_TITLE = 80;
/** Suggestion lines under the headline. One more than this and the last line says how many are under Pick. */
const MAX_ITEMS = MAX_LINES - 1;

/** What a button on a call's message carries: the call, and the version of it that was shown. */
export const encodeCallRef = (call: Pick<Call, 'id' | 'version'>, extra?: string): string =>
  [call.id, ...(extra === undefined ? [] : [extra]), String(call.version)].join('|');

const CALL_REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|([0-9a-f-]{36}|none))?\|(\d{1,9})$/;

export function decodeCallRef(value: unknown): { callId: string; extra: string | null; version: number } | null {
  if (typeof value !== 'string') return null;
  const match = CALL_REF.exec(value);
  return match ? { callId: match[1]!, extra: match[2] ?? null, version: Number(match[3]) } : null;
}

export interface CallView {
  call: Call;
  matches: CallMatch[];
  /** The current version's suggestions, in the order they are numbered. */
  suggestions: CallSuggestion[];
  recommendations: Recommendation[];
  agents: AgentRunRecord[];
}

export async function loadCallView(db: Queryable, callId: string): Promise<CallView | null> {
  const call = await getCall(db, callId);
  if (!call) return null;
  const [matches, suggestions, recommendations] = await Promise.all([
    listMatches(db, callId),
    listSuggestions(db, callId, call.version),
    carriedRecommendations(db, callId),
  ]);
  const agents = await listAgentRuns(
    db,
    recommendations.map((r) => r.id),
  );
  return { call, matches, suggestions, recommendations, agents };
}

const TYPE_TAG: Record<SuggestionType, string> = { code_change: 'agent', task: 'task', client_followup: 'draft', note: 'note' };

const prLabel = (url: string): string => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : 'pull request';
};

export interface Item {
  suggestion: CallSuggestion;
  rec: Recommendation;
  agent: AgentRunRecord | undefined;
}

/** The suggestions that propose something, with the recommendation each became. */
export function actionable(view: Pick<CallView, 'suggestions' | 'recommendations' | 'agents'>): Item[] {
  return view.suggestions.flatMap((suggestion) => {
    const rec = view.recommendations.find((r) => r.id === suggestion.recommendationId);
    return rec ? [{ suggestion, rec, agent: view.agents.filter((a) => a.recommendationId === rec.id).at(-1) }] : [];
  });
}

const isPending = (rec: Recommendation): boolean => rec.status === 'posted' || rec.status === 'drafted';
const isApproved = (rec: Recommendation): boolean => ['approved', 'executing', 'done', 'failed'].includes(rec.status);

/** What one decided line says after its title while others are still waiting. */
function lineState(item: Item): string {
  const by = item.rec.decidedBy ? ` by <@${item.rec.decidedBy}>` : '';
  switch (item.rec.status) {
    case 'drafted':
    case 'posted':
      return '';
    case 'approved':
    case 'executing':
      return ` · approved${by}`;
    case 'done':
      return ` · ${agentState(item) ?? 'done'}`;
    case 'failed':
      return ' · failed';
    case 'dismissed':
      return ` · skipped${by}`;
    case 'expired':
      return ' · expired';
  }
}

/** For an approved code change: where its agent is. Null for the other types. */
function agentState(item: Item): string | null {
  if (item.suggestion.type !== 'code_change') return null;
  const agent = item.agent;
  if (!agent || agent.status === 'running') return agent ? `<${agent.agentUrl}|agent running>` : 'agent starting';
  if (agent.status === 'finished') return agent.prUrl ? `<${agent.prUrl}|${prLabel(agent.prUrl)}> ready for review` : 'agent finished without a pull request';
  return `<${agent.agentUrl}|agent> did not finish`;
}

function headline(call: Call, tail: string, options: { quoted?: boolean; length?: boolean } = {}): string {
  const title = escapeMrkdwn(clip(call.title, MAX_TITLE));
  const length = options.length ? minutes(call.durationSeconds) : null;
  return `*Call* · ${options.quoted ? `"${title}"` : title}${length ? ` · ${length}` : ''} · ${tail}`;
}

const button = (text: string, actionId: string, value: string, style?: 'primary'): SlackBlock => ({
  type: 'button',
  action_id: actionId,
  text: { type: 'plain_text', text: clip(text, 70) },
  value,
  ...(style ? { style } : {}),
});

function message(lines: string[], buttons: SlackBlock[] = []): SlackMessage {
  const kept = lines.slice(0, MAX_LINES);
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: kept.join('\n') } }];
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons.slice(0, MAX_BUTTONS) });
  return { text: kept[0]!.replace(/\*/g, ''), blocks };
}

const numbers = (items: Item[]): string => items.map((i) => i.suggestion.position).join(', ');

/** The second line once nothing is waiting: who approved what, where the agents are, what was skipped. */
function outcomeLine(items: Item[]): string {
  const approved = items.filter((i) => isApproved(i.rec));
  const skipped = items.filter((i) => i.rec.status === 'dismissed');
  const expired = items.filter((i) => i.rec.status === 'expired');
  const parts: string[] = [];
  if (approved.length) {
    const who = [...new Set(approved.flatMap((i) => (i.rec.decidedBy ? [`<@${i.rec.decidedBy}>`] : [])))];
    const changes = approved.filter((i) => i.suggestion.type === 'code_change' && i.rec.status !== 'failed');
    const running = changes.filter((i) => !i.agent || i.agent.status === 'running');
    const note = running.length ? ` (${running.length === 1 ? 'agent' : 'agents'} running)` : '';
    parts.push(`Approved${who.length ? ` by ${who.join(', ')}` : ''}: ${numbers(approved)}${note}`);
    for (const item of changes) {
      if (item.agent && item.agent.status !== 'running') parts.push(`${item.suggestion.position} ${agentState(item)!}`);
    }
    const failed = approved.filter((i) => i.rec.status === 'failed');
    if (failed.length) parts.push(`Failed: ${numbers(failed)}`);
  }
  if (skipped.length) parts.push(`Skipped: ${numbers(skipped)}`);
  if (expired.length) parts.push(`Expired: ${numbers(expired)}`);
  return parts.join(' · ');
}

/**
 * The message for a call in its current state, or null when the call has nothing to say in
 * Slack: it is still being read, it matched no project, or it matched one and asks for nothing.
 */
export function callMessage(view: CallView): SlackMessage | null {
  const { call } = view;
  const posted = Boolean(call.slackTs);
  const setBy = call.projectSetBy ? ` by <@${call.projectSetBy}>` : '';
  const matched = view.matches.filter((m) => m.state === 'matched');
  const projectNames = escapeMrkdwn(clip(matched.map((m) => m.projectName).join(', '), 80)) || 'no project';

  if (call.status === 'deleted') return posted ? message([headline(call, 'the recording was deleted at its source')]) : null;

  if (call.status === 'needs_project') {
    const candidates = view.matches.filter((m) => m.state === 'candidate').slice(0, MAX_BUTTONS - 1);
    return message(
      [headline(call, 'which project?', { quoted: true, length: true })],
      [
        ...candidates.map((m, index) => button(m.projectName, `${CALL_ACTIONS.project}:${index + 1}`, encodeCallRef(call, m.projectId))),
        button('None / new', `${CALL_ACTIONS.project}:none`, encodeCallRef(call, 'none')),
      ],
    );
  }

  if (call.status === 'unmatched') {
    return posted ? message([headline(call, 'no project'), `Marked${setBy} as not belonging to a listed project`]) : null;
  }

  if (call.status !== 'matched') {
    // Waiting or failed after the question was answered: say so on the message that asked.
    if (!posted) return null;
    return message([headline(call, projectNames), escapeMrkdwn(clip(call.statusDetail ?? 'Waiting to be analysed', 150))]);
  }

  const items = actionable(view);
  if (call.suggestedVersion !== call.version) {
    return posted ? message([headline(call, projectNames), `Project set${setBy} · drafting suggestions`]) : null;
  }
  if (!items.length) {
    const notes = view.suggestions.filter((s) => s.type === 'note').length;
    const tail = notes ? `no changes suggested · ${notes} ${notes === 1 ? 'note' : 'notes'} in Patcher` : 'no changes suggested';
    return posted ? message([headline(call, projectNames), call.projectSetBy ? `Project set${setBy} · ${tail}` : tail]) : null;
  }

  const pending = items.filter((i) => isPending(i.rec));
  if (!pending.length) {
    const failed = items.filter((i) => i.rec.status === 'failed');
    return message(
      [headline(call, projectNames), outcomeLine(items)],
      failed.slice(0, MAX_BUTTONS).map((i) => button(`Retry ${i.suggestion.position}`, `${ACTION_IDS.retry}:${i.suggestion.position}`, encodeRef(i.rec))),
    );
  }

  const several = matched.length > 1;
  const shown = items.length > MAX_ITEMS ? items.slice(0, MAX_ITEMS - 1) : items;
  const lines = shown.map((item) => {
    const owner = several ? ` · ${escapeMrkdwn(clip(matched.find((m) => m.projectId === item.suggestion.projectId)?.projectName ?? '', 30))}` : '';
    return `${item.suggestion.position}. ${escapeMrkdwn(clip(item.suggestion.title, MAX_TITLE))} (${TYPE_TAG[item.suggestion.type]})${owner}${lineState(item)}`;
  });
  if (shown.length < items.length) lines.push(`+${items.length - shown.length} more under Pick`);

  // The approve button covers what is on the message and still waiting, and says so when that is not everything.
  const offered = shown.filter((i) => isPending(i.rec));
  const positions = offered.map((i) => i.suggestion.position);
  const run = positions.length > 1 && positions.at(-1)! - positions[0]! === positions.length - 1;
  const approveLabel =
    offered.length === items.length ? 'Approve all' : run ? `Approve ${positions[0]}-${positions.at(-1)}` : `Approve ${positions.join(', ')}`;
  return message(
    [headline(call, projectNames, { length: true }), ...lines],
    [
      ...(offered.length ? [button(approveLabel, CALL_ACTIONS.approveAll, offered.map((i) => encodeRef(i.rec)).join(','), 'primary')] : []),
      button('Pick', CALL_ACTIONS.pick, encodeCallRef(call)),
      button('Wrong project', CALL_ACTIONS.wrongProject, encodeCallRef(call)),
      button('Details', CALL_ACTIONS.details, encodeCallRef(call)),
    ],
  );
}

export type CallPostOutcome = 'posted' | 'updated' | 'nothing' | 'held' | 'deferred' | 'not_found';

const HOLD_HINT: Record<string, string> = {
  not_in_channel: 'Invite the bot to the channel, then post again.',
  channel_not_found: 'The bot cannot see that channel. Invite it, or pick another channel.',
  is_archived: 'That channel is archived. Pick another channel.',
  not_configured: 'Slack is not configured yet.',
};

/**
 * Posts the call's message, or edits the one it has, and in the same transaction marks the
 * drafted recommendations it shows as posted, which is what makes their buttons valid.
 * Held, like any recommendation, while paused or while there is no channel.
 */
export async function postCall(deps: WorkerDeps, callId: string): Promise<CallPostOutcome> {
  let blockedNotice: { text: string; channel: string } | undefined;

  const outcome = await withTx(deps.pool, async (tx): Promise<CallPostOutcome> => {
    const locked = await tx.query<CallRow>('SELECT * FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    if (!locked.rows[0]) return 'not_found';
    const call = callFromRow(locked.rows[0]);
    const drafted = await tx.query<RecommendationRow>(
      `SELECT r.* FROM recommendations r
         JOIN call_suggestions s ON s.recommendation_id = r.id AND s.version = $3
        WHERE r.carrier_type = $1 AND r.carrier_id = $2 AND r.status = 'drafted'
        FOR UPDATE OF r`,
      [CALL_CARRIER, callId, call.version],
    );
    const loaded = await loadCallView(tx, callId);
    if (!loaded) return 'not_found';
    // Drawn as they will be once this post has gone out.
    const view: CallView = {
      ...loaded,
      recommendations: loaded.recommendations.map((r) => (r.status === 'drafted' ? { ...r, status: 'posted' as const } : r)),
    };
    const content = callMessage(view);
    if (!content) return 'nothing';

    const hold = async (reason: string): Promise<CallPostOutcome> => {
      await tx.query('UPDATE calls SET post_error = $2 WHERE id = $1', [callId, reason]);
      return 'held';
    };
    if (await getSetting(tx, 'paused')) return hold('Waiting: Patcher is paused.');
    if (!deps.hubTeamId) return hold('Waiting: Slack is not configured yet.');

    let channel = call.slackChannel;
    let team = call.slackTeam;
    let ts = call.slackTs;
    try {
      if (channel && ts) {
        await deps.slack.updateMessage({ channel, ts, ...content });
      } else {
        const route = await getRoute(tx, 'calls');
        if (!route) return hold(`Waiting: no channel is set for ${REPORT_TYPES.calls.label} reports.`);
        channel = route.channelId;
        team = route.teamId;

        const cap = await getSetting(tx, 'slack.max_posts_per_hour');
        const recent = await tx.query<{ n: string; oldest: Date | null }>(
          `SELECT count(DISTINCT slack_ts) AS n, min(posted_at) AS oldest FROM (
             SELECT slack_ts, posted_at FROM recommendations WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'
             UNION ALL
             SELECT slack_ts, posted_at FROM calls WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'
           ) posts`,
          [channel],
        );
        if (Number(recent.rows[0]?.n ?? 0) >= cap) {
          const oldest = recent.rows[0]?.oldest ?? new Date();
          await deps.queue.enqueue('calls.post', { callId }, { tx, startAfter: new Date(oldest.getTime() + 60 * 60 * 1000 + 5_000) });
          await tx.query('UPDATE calls SET post_error = $2 WHERE id = $1', [callId, `Waiting: this channel has reached ${cap} posts in an hour.`]);
          return 'deferred';
        }
        ({ ts } = await deps.slack.postMessage({ channel, ...content }));
        await tx.query(
          `UPDATE calls SET slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now() WHERE id = $1`,
          [callId, team, channel, ts],
        );
        await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'call.post', target: callId, after: { channel, ts } });
      }
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        const hint = HOLD_HINT[err.code] ?? 'Fix the cause, then post again.';
        if (channel) blockedNotice = { channel, text: `Could not post a call to <#${channel}>: ${err.code}. ${hint}` };
        return hold(`Slack refused the post (${err.code}). ${hint}`);
      }
      throw err;
    }
    await tx.query('UPDATE calls SET post_error = NULL WHERE id = $1', [callId]);

    const expireHours = await getSetting(tx, 'approvals.expire_hours');
    for (const row of drafted.rows) {
      await tx.query(
        `UPDATE recommendations
            SET status = 'posted', slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now(),
                expires_at = now() + make_interval(hours => $5), last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id, team, channel, ts, expireHours],
      );
      await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'recommendation.post', target: row.id, after: { channel, ts, carrier: callId } });
    }
    return call.slackTs ? 'updated' : 'posted';
  });

  if (blockedNotice) await notifyOps(deps, blockedNotice.text, { exceptChannel: blockedNotice.channel });
  return outcome;
}

/** Edits the call's message so each line shows what happened to its suggestion. */
export async function renderCall(deps: WorkerDeps, callId: string): Promise<void> {
  const view = await loadCallView(deps.pool, callId);
  if (!view) return;
  // Something new to show that has not been posted: that goes through `postCall`, which marks it posted.
  if (view.recommendations.some((r) => r.status === 'drafted')) {
    await deps.queue.enqueue('calls.post', { callId });
    return;
  }
  if (!view.call.slackChannel || !view.call.slackTs) return;
  const content = callMessage(view);
  if (content) await deps.slack.updateMessage({ channel: view.call.slackChannel, ts: view.call.slackTs, ...content });
}

export const callCarrier: Carrier = {
  type: CALL_CARRIER,
  requestPost: (deps, callId) => deps.queue.enqueue('calls.post', { callId }),
  render: renderCall,
  async label(deps, rec) {
    const { rows } = await deps.pool.query<{ position: number }>('SELECT position FROM call_suggestions WHERE recommendation_id = $1', [rec.id]);
    return rows[0] ? String(rows[0].position) : null;
  },
};

const quoteLine = (s: CallSuggestion): string => `> ${escapeMrkdwn(clip(s.quote, 240))}${s.quoteAt ? ` (at ${s.quoteAt})` : ''}`;

/** The thread reply behind Details: each suggestion's words from the call and exactly what approving it does. */
export function callDetailsReply(view: CallView, catalog: Catalog, appBaseUrl: string): SlackMessage {
  const sections: string[] = [];
  for (const s of view.suggestions) {
    const rec = view.recommendations.find((r) => r.id === s.recommendationId);
    const lines = [`*${s.position}. ${escapeMrkdwn(clip(s.title, MAX_TITLE))}* (${TYPE_TAG[s.type]})`, quoteLine(s)];
    if (s.detail) lines.push(escapeMrkdwn(clip(s.detail, 300)));
    if (s.typeNote) lines.push(`_${escapeMrkdwn(clip(s.draftedType === 'code_change' ? `Not offered as a code change: ${s.typeNote}` : s.typeNote, 200))}_`);
    if (rec) {
      lines.push(`On approval: ${escapeMrkdwn(clip(catalog.describe(rec.action), 260))} <${appBaseUrl}/approvals/${rec.id}|${s.type === 'code_change' ? 'Full brief' : 'Open'}>`);
    } else if (s.type === 'note') {
      lines.push('For awareness. Nothing to approve.');
    }
    sections.push(lines.join('\n'));
  }
  sections.push(`<${appBaseUrl}/calls/${view.call.id}|Open the call in Patcher>`);
  return {
    text: `Details for the call ${clip(view.call.title, MAX_TITLE)}`,
    blocks: sections.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })),
  };
}

/** Posts the details once per version of the call, as one thread reply. */
export async function postCallDetails(deps: WorkerDeps, callId: string): Promise<void> {
  await withTx(deps.pool, async (tx) => {
    const locked = await tx.query<{ details_ts: string | null }>('SELECT details_ts FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    if (!locked.rows[0] || locked.rows[0].details_ts) return;
    const view = await loadCallView(tx, callId);
    if (!view?.call.slackChannel || !view.call.slackTs || !view.suggestions.length) return;
    try {
      const { ts } = await deps.slack.postMessage({
        channel: view.call.slackChannel,
        threadTs: view.call.slackTs,
        ...callDetailsReply(view, deps.catalog, deps.appBaseUrl),
      });
      await tx.query('UPDATE calls SET details_ts = $2 WHERE id = $1', [callId, ts]);
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        deps.log.warn('could not post call details', { callId, code: err.code });
        return;
      }
      throw err;
    }
  });
}

/** After a resume or a new channel route: questions that could not be asked while there was nowhere to ask. */
export async function resumeHeldCallPosts(deps: Pick<WorkerDeps, 'pool' | 'queue'>): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM calls WHERE status = 'needs_project' AND slack_ts IS NULL ORDER BY created_at LIMIT 50`,
  );
  for (const row of rows) await deps.queue.enqueue('calls.post', { callId: row.id });
  return rows.length;
}
