import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { getCall } from '../calls/store.js';
import type { Call } from '../calls/types.js';
import { minutes } from '../calls/types.js';
import type { Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { filesHashOf, prepareFiles } from '../dealroom/files.js';
import type { Carrier } from '../recommendations/carriers.js';
import type { LoopDeps, NewRecommendation } from '../recommendations/service.js';
import { RecommendationInputError, createRecommendation } from '../recommendations/service.js';
import type { Recommendation, RecommendationRow } from '../recommendations/types.js';
import { getRoute, REPORT_TYPES } from '../settings/routes.js';
import { getSetting } from '../settings/settings.js';
import type { SlackBlock, SlackMessage } from '../slack/client.js';
import { SlackApiError } from '../slack/client.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES, clip, encodeRef, escapeMrkdwn } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { briefEvidence } from './brief.js';
import { DEALROOM_API_ACTION, DEALROOM_CONFIRM_ACTION, DEALROOM_PR_ACTION, DEALROOM_PUBLISH_ACTION, FINALIZE_ACTION, audienceText } from './catalog.js';
import { splitProposal } from './markdown.js';
import { penguinReasonText } from './penguin.js';
import { followUpFor, getDeal, getSalesCall, offerFor, proposalForCall, sha256, updateForProposal, withdrawRecommendation } from './store.js';
import type { Deal, DealRoomRoute, DealRoomUpdate, Proposal, SalesCall, SalesCallRow } from './types.js';
import { DEALROOM_KIND, PROPOSAL_KIND, SALES_CARRIER, salesCallFromRow } from './types.js';

/**
 * The one Slack message a sales call gets in the sales channel (design 6.7), edited in place
 * as the call moves on: the question "Sales call?", the drafted proposal with its buttons,
 * the Penguin questions, and the outcome. The proposal's approval is a recommendation in the
 * shared loop; this module draws it, and offers it when the deal's state says what approving
 * should do.
 */
export const SALES_ACTIONS = {
  yes: 'sales_yes',
  no: 'sales_no',
  review: 'sales_review',
  regenerate: 'sales_regenerate',
  notDeal: 'sales_not_deal',
  penguinYes: 'sales_penguin_yes',
  penguinNo: 'sales_penguin_no',
  slug: 'sales_slug',
  skip: 'sales_skip',
  retry: 'sales_retry',
  openPr: 'sales_open_pr',
  /** A link to the room in the deal room app. */
  openRoom: 'sales_open_room',
  /** Ask again for an approval that expired: writing held files, or publishing. */
  reoffer: 'sales_reoffer',
} as const;

/** What a button on a sales call's message carries: the call, and the version of the message it was on. */
export const encodeSalesRef = (sales: Pick<SalesCall, 'callId' | 'version'>): string => `${sales.callId}|${sales.version}`;

const SALES_REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|(\d{1,9})$/;

export function decodeSalesRef(value: unknown): { callId: string; version: number } | null {
  if (typeof value !== 'string') return null;
  const match = SALES_REF.exec(value);
  return match ? { callId: match[1]!, version: Number(match[2]) } : null;
}

export interface SalesView {
  call: Call;
  sales: SalesCall;
  deal: Deal | null;
  /** The newest proposal drafted from this call. */
  proposal: Proposal | null;
  /** The recommendation that offers that proposal: waiting, or decided. */
  offer: Recommendation | null;
  update: DealRoomUpdate | null;
  /** The approval that followed the deal room update: writing files that were held, or publishing. */
  followUp: Recommendation | null;
  /** How Settings says the deal room is reached. */
  room: RoomSettings;
}

export interface RoomSettings {
  route: DealRoomRoute;
  /** The deal room's address for the service API. Empty until the owner saves one. */
  origin: string;
  /** Off: nothing Patcher does can be seen by a client, and it never changes a room's status. */
  publish: boolean;
}

export async function roomSettings(db: Queryable): Promise<RoomSettings> {
  return {
    route: await getSetting(db, 'sales.dealroom_route'),
    origin: await getSetting(db, 'sales.dealroom_url'),
    publish: await getSetting(db, 'sales.dealroom_publish'),
  };
}

export async function loadSalesView(db: Queryable, callId: string): Promise<SalesView | null> {
  const sales = await getSalesCall(db, callId);
  if (!sales) return null;
  const call = await getCall(db, callId);
  if (!call) return null;
  // One after the other: `db` may be a single connection inside a transaction.
  const deal = sales.dealId ? await getDeal(db, sales.dealId) : null;
  const proposal = await proposalForCall(db, callId);
  const offer = proposal ? await offerFor(db, proposal.id) : null;
  const update = proposal ? await updateForProposal(db, proposal.id) : null;
  const followUp = update ? await followUpFor(db, update.id) : null;
  return { call, sales, deal, proposal, offer, update, followUp, room: await roomSettings(db) };
}

/**
 * What approving the current proposal should do, given the deal and how Settings says the
 * deal room is reached. Null: there is a question to answer first.
 */
export function offerMode(view: Pick<SalesView, 'sales' | 'deal' | 'proposal'> & { room?: RoomSettings }): 'finalize' | 'dealroom' | 'dealroom_api' | null {
  const { deal, proposal, sales } = view;
  if (sales.state !== 'drafted' || !deal || proposal?.status !== 'draft') return null;
  if (deal.isPenguin === null) return null;
  if (!deal.isPenguin || deal.dealRoomSkipped) return 'finalize';
  // The service API finds or creates the room itself, so it needs no slug, only an address.
  if (view.room?.route === 'api') return view.room.origin ? 'dealroom_api' : null;
  return deal.dealRoomSlug ? 'dealroom' : null;
}

const canonical = (action: NewRecommendation['action']): string =>
  JSON.stringify([action.type, Object.entries((action.params ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))]);

/**
 * The approval a deal room update on the service API route calls for next, or null. Pure.
 *
 *   - Files that were held: an approval to write them. For a room that is not a draft this
 *     is offered only while the publish setting is on.
 *   - A draft room Patcher wrote: an approval to publish it, only while the setting is on.
 *
 * The action carries what the approver is shown: the room's status and who can open it.
 */
export function followUpNeeded(view: Pick<SalesView, 'deal' | 'proposal' | 'update' | 'room'>): NewRecommendation['action'] | null {
  const { deal, proposal, update, room } = view;
  if (!deal || !proposal || !update || update.route !== 'api') return null;
  if (deal.isPenguin !== true || deal.dealRoomSkipped || proposal.status !== 'final') return null;
  if (room.route !== 'api' || !room.origin || room.origin !== update.origin) return null;
  if (!update.roomId || !update.room || deal.dealRoomRef !== update.roomId) return null;
  const params = {
    proposalId: proposal.id,
    version: proposal.version,
    contentHash: proposal.contentHash,
    company: clip(deal.company, 150),
    origin: room.origin,
    updateId: update.id,
    roomId: update.roomId,
    members: update.room.members,
    invites: update.room.invites,
    domains: update.room.domains,
  };
  if (update.status === 'held' && update.hold) {
    if (update.room.status !== 'DRAFT' && !room.publish) return null;
    return {
      type: DEALROOM_CONFIRM_ACTION,
      params: {
        ...params,
        roomStatus: update.room.status,
        filesHash: filesHashOf(update.files),
        files: update.files.length,
        planHash: update.hold.planHash,
        replaces: update.hold.replaces.length,
        removes: update.hold.removes.length,
      },
    };
  }
  if (update.status === 'draft_written' && room.publish) return { type: DEALROOM_PUBLISH_ACTION, params };
  return null;
}

/** The follow-up approval, when it is the one the update calls for now. An older one for a room that has since changed is not. */
export function currentFollowUp(view: Pick<SalesView, 'deal' | 'proposal' | 'update' | 'room' | 'followUp'>): Recommendation | null {
  const need = followUpNeeded(view);
  return need && view.followUp && canonical(view.followUp.action) === canonical(need) ? view.followUp : null;
}

const LIVE = ['drafted', 'posted', 'approved', 'executing', 'done', 'failed'];

/**
 * Creates the recommendation for the current proposal when there is none. Safe to repeat:
 * the key holds the version of the sales call's message, which only a change by a person or
 * a new draft raises.
 */
export async function ensureOffer(deps: LoopDeps & Pick<WorkerDeps, 'log'>, callId: string): Promise<Recommendation | null> {
  const view = await loadSalesView(deps.pool, callId);
  if (!view || view.call.status === 'deleted') return null;
  const mode = offerMode(view);
  if (!mode) return null;
  const { proposal, deal, sales, call } = view as SalesView & { proposal: Proposal; deal: Deal };
  if (view.offer && LIVE.includes(view.offer.status)) return view.offer;

  const evidence = briefEvidence(proposal.brief, `Call "${clip(call.title, 80)}"`);
  // "Evidence or nothing": a proposal whose quotes are gone is not offered for approval.
  if (!evidence.length) return null;

  const base = { proposalId: proposal.id, version: proposal.version, contentHash: proposal.contentHash, company: clip(deal.company, 150) };
  let action: NewRecommendation['action'];
  if (mode === 'dealroom_api') {
    // Nothing is asked of the deal room here. The files are worked out from the proposal alone.
    const prepared = prepareFiles({ title: proposal.title, contentMd: proposal.contentMd });
    if (prepared.problems.length || !prepared.files.length) {
      deps.log.warn('deal room files not offered', { callId, problems: prepared.problems.slice(0, 3) });
      return null;
    }
    action = {
      type: DEALROOM_API_ACTION,
      params: { ...base, origin: view.room.origin, slug: deal.dealRoomSlug, filesHash: prepared.filesHash, files: prepared.files.length },
    };
  } else if (mode === 'dealroom') {
    const prepared = prepareFiles({ slug: deal.dealRoomSlug!, title: proposal.title, contentMd: proposal.contentMd });
    if (prepared.problems.length || !prepared.files.length) {
      deps.log.warn('deal room files not offered', { callId, problems: prepared.problems.slice(0, 3) });
      return null;
    }
    action = {
      type: DEALROOM_PR_ACTION,
      params: { ...base, repo: await getSetting(deps.pool, 'sales.dealroom_repo'), slug: deal.dealRoomSlug!, filesHash: prepared.filesHash, files: prepared.files.length },
    };
  } else {
    action = { type: FINALIZE_ACTION, params: base };
  }
  const gaps = proposal.gaps.length ? ` Gaps: ${proposal.gaps.join(', ')}.` : '';
  try {
    const { recommendation } = await createRecommendation(deps, {
      kind: PROPOSAL_KIND,
      sourceType: 'proposal',
      sourceId: proposal.id,
      title: clip(`Proposal v${proposal.version} · ${deal.company}`.replace(/[\r\n]+/g, ' '), 150),
      body: clip(`${proposal.summary || proposal.title}.${gaps}`, 1500),
      evidence,
      action,
      risk: mode === 'finalize' ? 'low' : 'medium',
      dedupeKey: `proposal:${proposal.id}:${sales.version}`,
      carrier: { type: SALES_CARRIER, id: callId },
    });
    return recommendation;
  } catch (err) {
    if (!(err instanceof RecommendationInputError)) throw err;
    deps.log.warn('proposal not offered', { callId, reason: err.message });
    return null;
  }
}

const IN_FLIGHT = ['drafted', 'posted', 'approved', 'executing', 'failed'];

/**
 * Creates the approval a deal room update calls for next, and withdraws one that no longer
 * fits the room. Safe to repeat. An approval that expired, was dismissed or ran in dry run is
 * not made again until a person asks ("Offer again"), which raises the version in the key.
 */
export async function ensureFollowUp(deps: LoopDeps & Pick<WorkerDeps, 'log' | 'appBaseUrl'>, callId: string): Promise<Recommendation | null> {
  const view = await loadSalesView(deps.pool, callId);
  if (!view || view.call.status === 'deleted') return null;
  const need = followUpNeeded(view);
  const current = view.followUp;
  const fits = Boolean(need && current && canonical(current.action) === canonical(need));
  if (current && !fits && ['drafted', 'posted', 'failed'].includes(current.status)) {
    await withdrawRecommendation(deps.pool, current.id, { reason: need ? 'Closed: the room is not as it was when this was offered.' : 'Closed: this no longer applies.', actor: SYSTEM_ACTOR });
  }
  if (!need) return null;
  const { proposal, deal, update, sales, call } = view as SalesView & { proposal: Proposal; deal: Deal; update: DealRoomUpdate };
  const round = `dealroom:${update.id}:${sales.version}:`;
  if (fits) {
    if (IN_FLIGHT.includes(current!.status)) return current;
    // Closed without being carried out. It is asked again only after a person raised the version ("Offer again").
    const made = await deps.pool.query<{ dedupe_key: string | null }>('SELECT dedupe_key FROM recommendations WHERE id = $1', [current!.id]);
    if (made.rows[0]?.dedupe_key?.startsWith(round)) return current;
  }
  const live = need.type === DEALROOM_PUBLISH_ACTION || update.room?.status !== 'DRAFT';
  const by = proposal.finalizedBy ? ` by <@${proposal.finalizedBy}>` : '';
  try {
    const { recommendation } = await createRecommendation(deps, {
      kind: DEALROOM_KIND,
      sourceType: 'deal_room_update',
      sourceId: update.id,
      title: clip(`${need.type === DEALROOM_PUBLISH_ACTION ? 'Publish deal room' : 'Write to deal room'} · ${deal.company}`.replace(/[\r\n]+/g, ' '), 150),
      body: clip(
        need.type === DEALROOM_PUBLISH_ACTION
          ? `Proposal v${proposal.version} is in a draft room. Publishing opens the room to ${audienceText(update.room!)}.`
          : `Proposal v${proposal.version} is final and was not written: the room is ${update.room!.status}${update.hold?.reasons.includes('edited') ? ' and holds files a person edited' : ''}.`,
        1500,
      ),
      evidence: [
        { quote: clip(`Proposal v${proposal.version} "${proposal.title}" was approved in Patcher${by}.`, 500), source: 'Patcher proposal record', url: `${deps.appBaseUrl}/sales/proposals/${proposal.id}` },
        ...briefEvidence(proposal.brief, `Call "${clip(call.title, 80)}"`).slice(0, 4),
      ],
      action: need,
      risk: live ? 'high' : 'medium',
      // After the one before it, so a room that changes and changes back is asked about again.
      dedupeKey: `${round}${sha256(canonical(need)).slice(0, 16)}:${current?.id ?? 'first'}`,
      carrier: { type: SALES_CARRIER, id: callId },
    });
    return recommendation;
  } catch (err) {
    if (!(err instanceof RecommendationInputError)) throw err;
    deps.log.warn('deal room approval not offered', { callId, reason: err.message });
    return null;
  }
}

const MAX_TITLE = 80;

const button = (text: string, actionId: string, value: string, style?: 'primary'): SlackBlock => ({
  type: 'button',
  action_id: actionId,
  text: { type: 'plain_text', text: clip(text, 70) },
  value,
  ...(style ? { style } : {}),
});

function message(lines: string[], buttons: SlackBlock[] = []): SlackMessage {
  const kept = lines.filter(Boolean).slice(0, MAX_LINES);
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: kept.join('\n') } }];
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons.slice(0, MAX_BUTTONS) });
  return { text: kept[0]!.replace(/\*/g, ''), blocks };
}

/** "Dana R.": the first name and the initial of the last. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.` : (parts[0] ?? '');
}

const prLabel = (url: string | null): string => {
  const number = url ? /\/pull\/(\d+)/.exec(url)?.[1] : undefined;
  return number ? `PR #${number}` : 'pull request';
};

/**
 * The message for a sales call in its current state, or null when it has nothing to say in
 * Slack yet (still being read, or waiting before anything was posted).
 */
export function salesMessage(view: SalesView, appBaseUrl: string): SlackMessage | null {
  const { call, sales, deal, proposal, offer, update, room: settings } = view;
  const posted = Boolean(sales.slackTs);
  const ref = encodeSalesRef(sales);
  const title = escapeMrkdwn(clip(call.title, MAX_TITLE));
  const length = minutes(call.durationSeconds);
  const by = sales.decidedBy ? ` by <@${sales.decidedBy}>` : '';
  const company = deal ? escapeMrkdwn(clip(deal.company, 60)) : title;
  const contact = deal?.contacts[0]?.name ? ` (${escapeMrkdwn(clip(shortName(deal.contacts[0].name), 30))})` : '';
  const head = (label: string, ...rest: (string | null)[]): string => [`*${label}*`, ...rest].filter(Boolean).join(' · ');

  if (call.status === 'deleted') return posted ? message([head('Sales call', title, 'the recording was deleted at its source')]) : null;

  switch (sales.state) {
    case 'asked':
      return message(
        [head('Sales call?', `"${title}"`, length), escapeMrkdwn(clip(sales.detail ?? 'This may have been a sales call.', 150))],
        [button('Yes, draft proposal', SALES_ACTIONS.yes, ref, 'primary'), button('No', SALES_ACTIONS.no, ref)],
      );
    case 'drafting':
      return posted ? message([head('Sales call', title, length), `Drafting the proposal${by ? ` · asked${by}` : ''}`]) : null;
    case 'held':
      return posted ? message([head('Sales call', title, length), escapeMrkdwn(clip(sales.detail ?? 'Waiting.', 150))]) : null;
    case 'failed':
      return message(
        [head('Sales call', title, 'proposal not drafted'), escapeMrkdwn(clip(sales.detail ?? 'The draft failed.', 200))],
        [button('Retry', SALES_ACTIONS.retry, ref)],
      );
    case 'declined':
      return posted ? message([head('Sales call', title, proposal ? 'not a deal' : 'not a sales call'), `Marked${by}`.trim()]) : null;
    case 'drafted':
      break;
  }
  if (!proposal || !deal) return posted ? message([head('Sales call', title, length), 'The proposal is no longer stored.']) : null;

  const sections = splitProposal(proposal.contentMd).sections.length;
  const gaps = proposal.gaps.length ? ` Gaps: ${escapeMrkdwn(clip(proposal.gaps.join(', '), 120))}` : '';
  const flags = proposal.flags.length ? ` · ${proposal.flags.length} to check` : '';
  const version = `Proposal v${proposal.version}`;
  const link = `<${appBaseUrl}/sales/proposals/${proposal.id}|${version}>`;
  const summary = escapeMrkdwn(clip(proposal.summary || proposal.title, 100));
  const drafted = `Proposal drafted: ${summary}.${gaps}${flags}`;
  const penguin = deal.isPenguin === true && !deal.dealRoomSkipped;
  const who = offer?.decidedBy ? ` by <@${offer.decidedBy}>` : '';
  const review = button('Review', SALES_ACTIONS.review, ref);
  const regenerate = button('Regenerate', SALES_ACTIONS.regenerate, ref);
  const notPenguin = button('Not Penguin', SALES_ACTIONS.penguinNo, ref);

  if (proposal.status === 'superseded') {
    return message([head(penguin ? 'Penguin deal' : 'Sales call', company, length), `${link} was replaced by a newer version. The newer one is in <${appBaseUrl}/sales/deals/${deal.id}|Patcher>.`]);
  }
  if (proposal.status === 'dismissed') return message([head('Sales call', company, 'not a deal'), `Marked${by}`.trim()]);

  // Approved: say what came of it.
  if (offer && ['approved', 'executing', 'done', 'failed'].includes(offer.status)) {
    if (offer.status === 'failed') {
      const notDone = offer.action.type === DEALROOM_API_ACTION ? 'deal room not written' : 'deal room PR not opened';
      return message(
        [head(penguin ? 'Penguin deal' : 'Sales call', company, penguin ? notDone : 'not finished'), escapeMrkdwn(clip(offer.lastError ?? 'The action failed.', 220))],
        [button('Retry', ACTION_IDS.retry, encodeRef(offer)), review, ...(penguin ? [notPenguin] : [])],
      );
    }
    if (offer.status !== 'done') return message([head(penguin ? 'Penguin deal' : 'Sales call', company, length), `${link} approved${who} · working on it`]);
    if (proposal.status !== 'final') return message([head('Sales call', company, length), `${link} approved${who} in dry run · nothing was done`]);
    if (update?.route === 'api' && update.status !== 'prepared' && update.status !== 'failed') {
      const room = update.room;
      const address = update.roomUrl && /^https?:\/\/[^\s<>|]+$/.test(update.roomUrl) ? update.roomUrl : null;
      const roomButton = (label: string): SlackBlock[] =>
        address ? [{ type: 'button', action_id: SALES_ACTIONS.openRoom, text: { type: 'plain_text', text: label }, url: address }] : [];
      const tail = [regenerate, notPenguin];
      if (deal.isPenguin !== true || deal.dealRoomSkipped) {
        return message(
          [
            head('Sales call', company, deal.dealRoomSkipped ? 'deal room skipped' : 'no longer marked as a Penguin deal'),
            `${link} is final. Its deal room was left as it is; archive it in the deal room admin if it is not wanted.`,
          ],
          roomButton('Open room'),
        );
      }
      if (update.status === 'closed') {
        return message([head('Penguin deal', company, 'deal room closed'), `${link} is final. ${escapeMrkdwn(clip(update.error ?? 'The room is no longer open in the deal room.', 160))}`], [regenerate]);
      }
      if (update.status === 'published') {
        const last = view.followUp?.status === 'done' ? view.followUp : null;
        const actor = last?.decidedBy ? ` by <@${last.decidedBy}>` : '';
        const how = !last ? 'published in the deal room admin' : last.action.type === DEALROOM_CONFIRM_ACTION ? `written to the live room${actor}` : `published${actor}`;
        return message(
          [head('Penguin deal', company, 'deal room is live'), `${link}: ${sections} sections · ${how}`, room ? `Open to ${audienceText(room)}` : ''],
          [...roomButton('Open room'), ...tail],
        );
      }

      // What comes next is its own approval: writing files that were held, or publishing the draft.
      const next = currentFollowUp(view);
      const nextBy = next?.decidedBy ? ` by <@${next.decidedBy}>` : '';
      const reoffer = button('Offer again', SALES_ACTIONS.reoffer, ref);
      const withNext = (lines: string[], label: string, asks: string, first: SlackBlock[]): SlackMessage => {
        if (!next) return message([...lines, 'Preparing the approval for the next step'], [...first, ...tail]);
        switch (next.status) {
          case 'drafted':
          case 'posted':
            return message([...lines, asks], [...first, button(label, ACTION_IDS.approve, encodeRef(next), 'primary'), ...tail]);
          case 'approved':
          case 'executing':
            return message([...lines, `${label}: approved${nextBy} · working on it`], first);
          case 'failed':
            return message([...lines, escapeMrkdwn(clip(next.lastError ?? 'The action failed.', 200))], [button('Retry', ACTION_IDS.retry, encodeRef(next)), ...first, ...tail]);
          case 'done':
            return message([...lines, `${label}: approved${nextBy} in dry run · nothing was changed`], [...first, reoffer, ...tail]);
          default:
            return message([...lines, `${label} was ${next.status === 'dismissed' ? `dismissed${nextBy}` : 'not decided in time'}`], [...first, reoffer, ...tail]);
        }
      };

      if (update.status === 'held' && update.hold && room) {
        const liveRoom = room.status !== 'DRAFT';
        const edits = update.hold.replaces.length + update.hold.removes.length;
        const why = [
          liveRoom ? `The room is ${room.status}, open to ${audienceText(room)}` : '',
          edits ? `${edits} ${edits === 1 ? 'file' : 'files'} a person edited in the room would be replaced or removed` : '',
        ]
          .filter(Boolean)
          .join('. ');
        const lines = [
          head('Penguin deal', company, liveRoom ? 'deal room is live · nothing written' : 'draft room has edits · nothing written'),
          `${link} is final · approved${who}. ${why}`,
        ];
        if (liveRoom && !settings.publish) {
          return message([...lines, 'Publishing from Patcher is off, so the room stays as it is. Turn it on in Settings, or enter the text in Deal Admin'], [...roomButton('Open room'), ...tail]);
        }
        return withNext(
          lines,
          liveRoom ? 'Write to live room' : 'Replace edits',
          liveRoom ? 'Writing shows the new text at once to everyone who can open the room' : 'Writing replaces them. Clients cannot open a draft room',
          roomButton('Open room'),
        );
      }

      const lines = [head('Penguin deal', company, 'draft room ready'), `${link}: ${sections} sections · approved${who}. Draft: clients cannot see it yet`];
      if (!settings.publish) {
        return message([...lines, 'Publishing from Patcher is off. A person publishes the room in the deal room admin'], [...roomButton('Preview'), ...tail]);
      }
      return withNext(lines, 'Publish', room ? `Publish opens the room to ${audienceText(room)}` : 'Publish opens the room', roomButton('Preview'));
    }
    if (update?.prUrl) {
      const pr = `<${update.prUrl}|${prLabel(update.prUrl)}>`;
      if (deal.isPenguin !== true && update.status === 'pr_open') {
        return message([head('Sales call', company, 'no longer marked as a Penguin deal'), `${link} is final. ${pr} is still open on the deal room; close it in GitHub if it should not be merged.`]);
      }
      if (update.status === 'merged') return message([head('Penguin deal', company, 'deal room PR merged'), `${link} · ${pr} was merged. It is live in the room once the app has redeployed.`]);
      if (update.status === 'closed') return message([head('Penguin deal', company, 'deal room PR closed'), `${link} · ${pr} was closed without merging. Nothing changed in the room.`], [regenerate]);
      return message(
        [head('Penguin deal', company, 'deal room PR ready'), `${link}: ${sections} sections · approved${who}. Merging makes it live to everyone in the room`],
        [{ type: 'button', action_id: SALES_ACTIONS.openPr, text: { type: 'plain_text', text: 'Review PR' }, url: update.prUrl }, regenerate, notPenguin],
      );
    }
    return message([head('Sales call', company + contact, length), `${link} final · approved${who} · <${appBaseUrl}/sales/proposals/${proposal.id}/pdf|PDF> for a person to send`]);
  }

  if (offer?.status === 'dismissed') return message([head('Sales call', company, length), `${link} dismissed${who}`], [regenerate]);
  if (offer?.status === 'expired' && offerMode(view)) {
    return message([head(penguin ? 'Penguin deal' : 'Sales call', company, length), `${link} expired without a decision`], [review, regenerate]);
  }

  // Questions that come before an approval can be offered.
  if (deal.isPenguin === null) {
    return message(
      [head('Sales call', company + contact, length), drafted, 'Penguin deal? The transcript carries no addresses, so I cannot tell'],
      [review, button('Yes, Penguin', SALES_ACTIONS.penguinYes, ref), button('Not Penguin', SALES_ACTIONS.penguinNo, ref), button('Not a deal', SALES_ACTIONS.notDeal, ref)],
    );
  }
  if (penguin && settings.route === 'api' && !settings.origin) {
    return message(
      [head('Penguin deal', company, penguinReasonText(deal.penguinReason, deal.penguinSetBy), 'deal room address not set'), drafted, 'Save the deal room address in Settings, or switch the deal room back to pull requests'],
      [review, regenerate, notPenguin, button('Skip', SALES_ACTIONS.skip, ref)],
    );
  }
  if (penguin && settings.route !== 'api' && !deal.dealRoomSlug) {
    return message(
      [head('Penguin deal', company, penguinReasonText(deal.penguinReason, deal.penguinSetBy), 'no deal room yet'), drafted, 'Create it at /admin with no client domains, then give me the slug'],
      [review, button('Enter slug', SALES_ACTIONS.slug, ref, 'primary'), notPenguin, button('Skip', SALES_ACTIONS.skip, ref)],
    );
  }

  const pending = offer && (offer.status === 'posted' || offer.status === 'drafted') ? offer : null;
  const approve = pending ? [button('Approve', ACTION_IDS.approve, encodeRef(pending), 'primary')] : [];
  if (penguin) {
    const viaApi = settings.route === 'api';
    const where = deal.dealRoomSlug ? `room ${escapeMrkdwn(deal.dealRoomSlug)}` : 'new draft room';
    const approving = viaApi
      ? 'Approving writes it to a draft deal room, which clients cannot open. A live room is not changed without asking again'
      : 'Approving opens a deal room pull request. Nothing is live until a person merges it';
    return message(
      [
        head('Penguin deal', company, penguinReasonText(deal.penguinReason, deal.penguinSetBy), where),
        `${version}: ${sections} sections. ${summary}.${gaps}${flags}`,
        pending ? approving : 'The deal room files cannot be offered yet. Open Review to see why',
      ],
      [review, ...approve, regenerate, notPenguin],
    );
  }
  return message([head('Sales call', company + contact, length), drafted], [review, ...approve, regenerate, button('Not a deal', SALES_ACTIONS.notDeal, ref)]);
}

export type SalesPostOutcome = 'posted' | 'updated' | 'nothing' | 'held' | 'deferred' | 'not_found';

const HOLD_HINT: Record<string, string> = {
  not_in_channel: 'Invite the bot to the channel, then post again.',
  channel_not_found: 'The bot cannot see that channel. Invite it, or pick another channel.',
  is_archived: 'That channel is archived. Pick another channel.',
  not_configured: 'Slack is not configured yet.',
};

/**
 * Offers the proposal if it is time to, then posts the sales call's message or edits the one
 * it has. In the same transaction the recommendation it shows is marked posted, which is
 * what makes its Approve button valid. Held while paused or while there is no sales channel.
 */
export async function postSales(deps: WorkerDeps, callId: string): Promise<SalesPostOutcome> {
  await ensureOffer(deps, callId);
  await ensureFollowUp(deps, callId);
  let blockedNotice: { text: string; channel: string } | undefined;

  const outcome = await withTx(deps.pool, async (tx): Promise<SalesPostOutcome> => {
    const locked = await tx.query<SalesCallRow>('SELECT * FROM sales_calls WHERE call_id = $1 FOR UPDATE', [callId]);
    if (!locked.rows[0]) return 'not_found';
    const sales = salesCallFromRow(locked.rows[0]);
    const drafted = await tx.query<RecommendationRow>(
      `SELECT * FROM recommendations WHERE carrier_type = $1 AND carrier_id = $2 AND status = 'drafted' FOR UPDATE`,
      [SALES_CARRIER, callId],
    );
    const loaded = await loadSalesView(tx, callId);
    if (!loaded) return 'not_found';
    // Drawn as it will be once this post has gone out.
    const asPosted = (rec: Recommendation | null): Recommendation | null => (rec?.status === 'drafted' ? { ...rec, status: 'posted' } : rec);
    const view: SalesView = { ...loaded, offer: asPosted(loaded.offer), followUp: asPosted(loaded.followUp) };
    const content = salesMessage(view, deps.appBaseUrl);
    if (!content) return 'nothing';

    const hold = async (reason: string): Promise<SalesPostOutcome> => {
      await tx.query('UPDATE sales_calls SET post_error = $2 WHERE call_id = $1', [callId, reason]);
      return 'held';
    };
    if (await getSetting(tx, 'paused')) return hold('Waiting: Patcher is paused.');
    if (!deps.hubTeamId) return hold('Waiting: Slack is not configured yet.');

    let channel = sales.slackChannel;
    let team = sales.slackTeam;
    let ts = sales.slackTs;
    try {
      if (channel && ts) {
        await deps.slack.updateMessage({ channel, ts, ...content });
      } else {
        const route = await getRoute(tx, 'sales');
        if (!route) return hold(`Waiting: no channel is set for ${REPORT_TYPES.sales.label} reports.`);
        channel = route.channelId;
        team = route.teamId;

        const cap = await getSetting(tx, 'slack.max_posts_per_hour');
        const recent = await tx.query<{ n: string; oldest: Date | null }>(
          `SELECT count(DISTINCT slack_ts) AS n, min(posted_at) AS oldest FROM (
             SELECT slack_ts, posted_at FROM recommendations WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'
             UNION ALL
             SELECT slack_ts, posted_at FROM calls WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'
             UNION ALL
             SELECT slack_ts, posted_at FROM sales_calls WHERE slack_channel = $1 AND posted_at > now() - interval '1 hour'
           ) posts`,
          [channel],
        );
        if (Number(recent.rows[0]?.n ?? 0) >= cap) {
          const oldest = recent.rows[0]?.oldest ?? new Date();
          await deps.queue.enqueue('sales.post', { callId }, { tx, startAfter: new Date(oldest.getTime() + 60 * 60 * 1000 + 5_000) });
          await tx.query('UPDATE sales_calls SET post_error = $2 WHERE call_id = $1', [callId, `Waiting: this channel has reached ${cap} posts in an hour.`]);
          return 'deferred';
        }
        ({ ts } = await deps.slack.postMessage({ channel, ...content }));
        await tx.query(`UPDATE sales_calls SET slack_team = $2, slack_channel = $3, slack_ts = $4, posted_at = now() WHERE call_id = $1`, [callId, team, channel, ts]);
        await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'sales.post', target: callId, after: { channel, ts } });
      }
    } catch (err) {
      if (err instanceof SlackApiError && !err.retryable) {
        const hint = HOLD_HINT[err.code] ?? 'Fix the cause, then post again.';
        if (channel) blockedNotice = { channel, text: `Could not post a sales call to <#${channel}>: ${err.code}. ${hint}` };
        return hold(`Slack refused the post (${err.code}). ${hint}`);
      }
      throw err;
    }
    await tx.query('UPDATE sales_calls SET post_error = NULL WHERE call_id = $1', [callId]);

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
    return sales.slackTs ? 'updated' : 'posted';
  });

  if (blockedNotice) await notifyOps(deps, blockedNotice.text, { exceptChannel: blockedNotice.channel });
  return outcome;
}

/** Edits the sales call's message so it shows what happened to its proposal. */
export async function renderSales(deps: WorkerDeps, callId: string): Promise<void> {
  const view = await loadSalesView(deps.pool, callId);
  if (!view) return;
  // Something new to show that has not been posted goes through `postSales`, which marks it posted.
  // So does a deal room update whose next approval has not been made yet, or no longer fits.
  const need = followUpNeeded(view);
  const next = currentFollowUp(view);
  const followUpDue = need ? !next || next.status === 'drafted' : Boolean(view.followUp && ['drafted', 'posted', 'failed'].includes(view.followUp.status));
  if (view.offer?.status === 'drafted' || followUpDue || !view.sales.slackChannel || !view.sales.slackTs) {
    await deps.queue.enqueue('sales.post', { callId });
    return;
  }
  const content = salesMessage(view, deps.appBaseUrl);
  if (content) await deps.slack.updateMessage({ channel: view.sales.slackChannel, ts: view.sales.slackTs, ...content });
}

export const salesCarrier: Carrier = {
  type: SALES_CARRIER,
  requestPost: (deps, callId) => deps.queue.enqueue('sales.post', { callId }),
  render: renderSales,
};

/** After a resume or a new channel route: messages that could not be posted while there was nowhere to post. */
export async function resumeHeldSalesPosts(deps: Pick<WorkerDeps, 'pool' | 'queue'>): Promise<number> {
  const { rows } = await deps.pool.query<{ call_id: string }>(
    `SELECT call_id FROM sales_calls WHERE post_error IS NOT NULL OR (slack_ts IS NULL AND state IN ('asked', 'drafted', 'failed')) ORDER BY created_at LIMIT 50`,
  );
  for (const row of rows) await deps.queue.enqueue('sales.post', { callId: row.call_id });
  return rows.length;
}
