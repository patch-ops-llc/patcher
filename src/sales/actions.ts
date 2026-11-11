import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, PoolClient } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Catalog } from '../recommendations/catalog.js';
import { decide } from '../recommendations/service.js';
import { canDecide, getUser } from '../settings/users.js';
import { cleanMarkdown, splitProposal } from './markdown.js';
import { renderProposalPdf } from './pdf.js';
import { bumpSalesVersion, closeSalesRecommendations, getDeal, getProposal, getSalesCall, insertProposal, isUuid, offerFor, proposalForCall, setSalesState, sha256 } from './store.js';
import type { Deal, DealRow, Proposal, SalesCall, SalesCallRow } from './types.js';
import { PROPOSAL_KIND, SLUG, dealFromRow, isSalesType, salesCallFromRow } from './types.js';

/**
 * What a person can do to a sales call, its deal and its proposal, from Slack or the UI.
 * Each one checks the approver list itself, changes the record in one transaction, writes
 * the audit log, and asks for the call's message to be redrawn. None of them calls a model
 * or reaches outside Patcher: drafting is a job, and anything external waits for an approval.
 */
export interface SalesDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
  log: Logger;
}

export type SalesResult = { ok: true; message: string } | { ok: false; message: string };

const NOT_APPROVER = 'You are not on the approver list for this.';
const STALE = 'This message is out of date. Check the current one.';
const refuse = (message: string): SalesResult => ({ ok: false, message });
const done = (message: string): SalesResult => ({ ok: true, message });

export async function maySell(pool: Pool, actor: Actor): Promise<boolean> {
  const user = await getUser(pool, actor);
  return Boolean(user && canDecide(user, PROPOSAL_KIND));
}

interface CallInput {
  callId: string;
  actor: Actor;
  via: 'slack' | 'ui';
  /** The version of the message the button was on. Omitted from the UI, which always shows the current state. */
  expectedVersion?: number;
}

async function lockSales(tx: PoolClient, callId: string): Promise<SalesCall | null> {
  const { rows } = await tx.query<SalesCallRow>('SELECT * FROM sales_calls WHERE call_id = $1 FOR UPDATE', [callId]);
  return rows[0] ? salesCallFromRow(rows[0]) : null;
}

const isStale = (sales: SalesCall | null, expected: number | undefined): boolean => expected !== undefined && sales?.version !== expected;

/**
 * "Sales call? Yes / No", and the same choice made by hand on a call's page. Yes starts the
 * proposal; No takes the call out of the sales pipeline and closes anything it had waiting.
 */
export async function setSalesCall(deps: SalesDeps, input: CallInput & { sales: boolean }): Promise<SalesResult> {
  if (!isUuid(input.callId)) return refuse('That call no longer exists.');
  if (!(await maySell(deps.pool, input.actor))) return refuse(NOT_APPROVER);
  return withTx(deps.pool, async (tx): Promise<SalesResult> => {
    const call = await tx.query<{ status: string; call_type: string | null }>('SELECT status, call_type FROM calls WHERE id = $1 FOR UPDATE', [input.callId]);
    if (!call.rows[0]) return refuse('That call no longer exists.');
    if (call.rows[0].status === 'deleted') return refuse('The recording was deleted at its source.');
    const sales = await lockSales(tx, input.callId);
    if (isStale(sales, input.expectedVersion)) return refuse(STALE);

    if (input.sales) {
      if (sales && (sales.state === 'drafting' || sales.state === 'drafted')) return refuse('This call already has a proposal, or one is being drafted.');
      const type = isSalesType(call.rows[0].call_type) ? call.rows[0].call_type : 'sales_discovery';
      await tx.query('UPDATE calls SET call_type = $2, call_type_conf = 1, updated_at = now() WHERE id = $1', [input.callId, type]);
      await setSalesState(tx, input.callId, { state: 'drafting', decidedBy: input.actor });
      await recordAudit(tx, { actor: input.actor, action: 'call.type.set', target: input.callId, before: { type: call.rows[0].call_type }, after: { type, via: input.via } });
      await deps.queue.enqueue('sales.draft', { callId: input.callId }, { tx });
      await deps.queue.enqueue('sales.post', { callId: input.callId }, { tx });
      return done('Drafting the proposal. It is posted to the sales channel in a few minutes.');
    }

    if (sales?.state === 'declined') return done('Already marked.');
    const type = isSalesType(call.rows[0].call_type) || !call.rows[0].call_type ? 'other' : call.rows[0].call_type;
    await tx.query('UPDATE calls SET call_type = $2, call_type_conf = 1, updated_at = now() WHERE id = $1', [input.callId, type]);
    await closeSalesRecommendations(tx, input.callId, { reason: 'Closed: marked as not a deal.', actor: input.actor, alsoFailed: true });
    await tx.query(`UPDATE proposals SET status = 'dismissed' WHERE call_id = $1 AND status = 'draft'`, [input.callId]);
    await setSalesState(tx, input.callId, { state: 'declined', decidedBy: input.actor });
    await recordAudit(tx, { actor: input.actor, action: 'call.type.set', target: input.callId, before: { type: call.rows[0].call_type }, after: { type, via: input.via, sales: false } });
    await deps.queue.enqueue('sales.post', { callId: input.callId }, { tx });
    return done('Marked. Nothing more is drafted from this call.');
  });
}

/** "Not a deal": the proposal's dismissal is recorded in the approval loop, then the call leaves the pipeline. */
export async function notADeal(deps: SalesDeps, input: CallInput): Promise<SalesResult> {
  if (!(await maySell(deps.pool, input.actor))) return refuse(NOT_APPROVER);
  const sales = await getSalesCall(deps.pool, input.callId);
  if (!sales) return refuse('That call is not in the sales pipeline.');
  if (isStale(sales, input.expectedVersion)) return refuse(STALE);
  const proposal = await proposalForCall(deps.pool, input.callId);
  const offer = proposal ? await offerFor(deps.pool, proposal.id) : null;
  if (offer?.status === 'posted') {
    const result = await decide(deps, { id: offer.id, hash: offer.actionHash, actor: input.actor, via: input.via, decision: 'dismiss' });
    if (!result.ok && result.reason !== 'not_pending') return refuse(result.message);
  }
  return setSalesCall(deps, { callId: input.callId, actor: input.actor, via: input.via, sales: false });
}

/** Regenerate, and Retry after a failed draft. The note is what the person asked the new draft to do differently. */
export async function regenerate(deps: SalesDeps, input: CallInput & { note?: string }): Promise<SalesResult> {
  if (!isUuid(input.callId)) return refuse('That call no longer exists.');
  if (!(await maySell(deps.pool, input.actor))) return refuse(NOT_APPROVER);
  return withTx(deps.pool, async (tx): Promise<SalesResult> => {
    const sales = await lockSales(tx, input.callId);
    if (!sales) return refuse('That call is not in the sales pipeline.');
    if (isStale(sales, input.expectedVersion)) return refuse(STALE);
    if (sales.state === 'drafting') return done('A draft is already being written.');
    if (sales.state === 'asked' || sales.state === 'declined') return refuse('This call is not marked as a sales call.');
    const note = input.note?.replace(/\s+/g, ' ').trim().slice(0, 1000);
    await closeSalesRecommendations(tx, input.callId, { reason: 'Closed: the proposal is being drafted again.', actor: input.actor, alsoFailed: true });
    await setSalesState(tx, input.callId, {
      state: 'drafting',
      decidedBy: input.actor,
      // A retry keeps the note the failed draft was given.
      ...(input.note === undefined ? {} : { note: note || null, requestedBy: input.actor }),
    });
    await recordAudit(tx, { actor: input.actor, action: 'proposal.regenerate', target: input.callId, after: { via: input.via, ...(note ? { note } : {}) } });
    await deps.queue.enqueue('sales.draft', { callId: input.callId }, { tx });
    await deps.queue.enqueue('sales.post', { callId: input.callId }, { tx });
    return done('Drafting again. The new version replaces this one when it is ready.');
  });
}

/** Closes what the deal's calls have waiting and raises their versions, so each message offers what now fits the deal. */
async function refreshDeal(deps: SalesDeps, tx: PoolClient, dealId: string, reason: string, actor: Actor): Promise<void> {
  const { rows } = await tx.query<{ call_id: string }>('SELECT call_id FROM sales_calls WHERE deal_id = $1', [dealId]);
  const calls = rows.map((r) => r.call_id);
  for (const callId of calls) await closeSalesRecommendations(tx, callId, { reason, actor, alsoFailed: true });
  await bumpSalesVersion(tx, calls);
  for (const callId of calls) await deps.queue.enqueue('sales.post', { callId }, { tx });
}

interface DealInput {
  dealId: string;
  actor: Actor;
  via: 'slack' | 'ui';
  /** With a call: refused when that call's message has moved on since the button was drawn. */
  callId?: string;
  expectedVersion?: number;
}

async function changeDeal(
  deps: SalesDeps,
  input: DealInput,
  change: (tx: PoolClient, deal: Deal) => Promise<{ refused: string } | { audit: string; after: Record<string, unknown>; reason: string; said: string }>,
): Promise<SalesResult> {
  if (!isUuid(input.dealId)) return refuse('That deal no longer exists.');
  if (!(await maySell(deps.pool, input.actor))) return refuse(NOT_APPROVER);
  return withTx(deps.pool, async (tx): Promise<SalesResult> => {
    const { rows } = await tx.query<DealRow>('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [input.dealId]);
    if (!rows[0]) return refuse('That deal no longer exists.');
    const deal = dealFromRow(rows[0]);
    if (input.callId && isStale(await lockSales(tx, input.callId), input.expectedVersion)) return refuse(STALE);
    const result = await change(tx, deal);
    if ('refused' in result) return refuse(result.refused);
    await recordAudit(tx, {
      actor: input.actor,
      action: result.audit,
      target: deal.id,
      before: { isPenguin: deal.isPenguin, reason: deal.penguinReason, slug: deal.dealRoomSlug, skipped: deal.dealRoomSkipped },
      after: { ...result.after, via: input.via },
    });
    await refreshDeal(deps, tx, deal.id, result.reason, input.actor);
    return done(result.said);
  });
}

/** The manual flag of design 6.4. It wins over the rule in both directions, and the rule never changes it afterwards. */
export function setPenguin(deps: SalesDeps, input: DealInput & { penguin: boolean }): Promise<SalesResult> {
  return changeDeal(deps, input, async (tx, deal) => {
    if (deal.isPenguin === input.penguin && deal.penguinReason === 'flagged') return { refused: input.penguin ? 'Already marked as a Penguin deal.' : 'Already marked as not a Penguin deal.' };
    await tx.query(
      `UPDATE deals SET is_penguin = $2, penguin_reason = 'flagged', penguin_set_by = $3, deal_room_skipped = false, updated_at = now() WHERE id = $1`,
      [deal.id, input.penguin, input.actor],
    );
    return {
      audit: 'deal.penguin',
      after: { isPenguin: input.penguin, reason: 'flagged' },
      reason: input.penguin ? 'Closed: the deal was marked as a Penguin deal.' : 'Closed: the Penguin mark was removed.',
      said: input.penguin ? 'Marked as a Penguin deal.' : 'Marked as not a Penguin deal.',
    };
  });
}

/** The slug of the room a person created in the deal room app. Patcher cannot create a room or look one up. */
export function setDealRoomSlug(deps: SalesDeps, input: DealInput & { slug: string }): Promise<SalesResult> {
  const slug = input.slug.trim().toLowerCase();
  return changeDeal(deps, input, async (tx, deal) => {
    if (!SLUG.test(slug)) return { refused: 'A slug is lower-case letters, digits and dashes, like "northwind". It is the last part of the room\'s address.' };
    if (deal.dealRoomSlug === slug && !deal.dealRoomSkipped) return { refused: 'That slug is already saved.' };
    await tx.query('UPDATE deals SET deal_room_slug = $2, deal_room_skipped = false, updated_at = now() WHERE id = $1', [deal.id, slug]);
    return { audit: 'deal.slug', after: { slug }, reason: 'Closed: the deal room slug was set.', said: `Saved. Approving the proposal now opens a pull request for content/${slug}/.` };
  });
}

/** "Skip": this deal gets no deal room content, and its proposal is approved like any other. */
export function skipDealRoom(deps: SalesDeps, input: DealInput): Promise<SalesResult> {
  return changeDeal(deps, input, async (tx, deal) => {
    if (deal.dealRoomSkipped) return { refused: 'Already skipped.' };
    await tx.query('UPDATE deals SET deal_room_skipped = true, updated_at = now() WHERE id = $1', [deal.id]);
    return { audit: 'deal.dealroom.skip', after: { skipped: true }, reason: 'Closed: the deal room was skipped for this deal.', said: 'Skipped. The proposal can be approved without a deal room.' };
  });
}

export const MAX_PROPOSAL_CHARS = 60_000;

/**
 * Saves a person's edit as a new version. The text is held to the same rules as a draft
 * (no images, no raw HTML, links with allowed addresses), and what was approved before no
 * longer applies: the earlier version's approval request is closed and a new one is made.
 */
export async function editProposal(
  deps: SalesDeps,
  input: { proposalId: string; contentMd: string; actor: Actor; via: 'slack' | 'ui' },
): Promise<SalesResult & { proposal?: Proposal }> {
  if (!(await maySell(deps.pool, input.actor))) return refuse(NOT_APPROVER);
  const current = await getProposal(deps.pool, input.proposalId);
  if (!current) return refuse('That proposal no longer exists.');
  if (current.status === 'superseded' || current.status === 'dismissed') return refuse('This is not the current version. Open the newest one to edit it.');
  if (input.contentMd.length > MAX_PROPOSAL_CHARS) return refuse('That is too long for a proposal.');

  const cleaned = cleanMarkdown(input.contentMd);
  const doc = splitProposal(cleaned.text);
  if (!doc.sections.length) return refuse('A proposal needs at least one section: a line that starts with "## ".');
  const title = (doc.title || current.title).slice(0, 120);
  const contentMd = doc.title ? `${cleaned.text}\n` : `# ${title}\n\n${cleaned.text}\n`;
  if (sha256(contentMd) === current.contentHash) return done('Nothing changed.');
  const deal = await getDeal(deps.pool, current.dealId);
  const pdf = await renderProposalPdf(contentMd, { title, subtitle: deal ? `Prepared for ${deal.company}` : undefined }).catch((err: unknown) => {
    deps.log.warn('proposal pdf failed', { proposalId: current.id, err });
    return null;
  });

  return withTx(deps.pool, async (tx) => {
    const latest = await tx.query<{ id: string }>('SELECT id FROM proposals WHERE deal_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE', [current.dealId]);
    if (latest.rows[0]?.id !== current.id) return refuse('A newer version was saved while you were editing. Open it and edit that one.');
    const removed = cleaned.removed.length ? [`Removed from the edit: ${cleaned.removed.join(', ')}.`] : [];
    const { proposal, affectedCalls } = await insertProposal(tx, {
      dealId: current.dealId,
      callId: current.callId,
      title,
      summary: current.summary,
      brief: current.brief,
      contentMd,
      gaps: current.gaps,
      flags: [...removed, ...current.flags].slice(0, 30),
      lineItems: current.lineItems,
      pdf,
      createdBy: input.actor,
      note: null,
    });
    await recordAudit(tx, { actor: input.actor, action: 'proposal.edit', target: proposal.id, before: { version: current.version }, after: { version: proposal.version, via: input.via } });
    for (const callId of affectedCalls) await deps.queue.enqueue('sales.post', { callId }, { tx });
    const note = removed.length ? ` ${removed[0]}` : '';
    return { ok: true as const, message: `Saved as v${proposal.version}.${note}`, proposal };
  });
}
