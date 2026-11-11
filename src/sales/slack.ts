import type { SlackBlock, SlackClient, SlackView } from '../slack/client.js';
import { clip } from '../slack/messages.js';
import { getUser } from '../settings/users.js';
import type { SalesDeps, SalesResult } from './actions.js';
import { editProposal, maySell, notADeal, regenerate, reofferDealRoom, setDealRoomSlug, setPenguin, setSalesCall, skipDealRoom } from './actions.js';
import type { SalesView } from './delivery.js';
import { SALES_ACTIONS, decodeSalesRef, loadSalesView } from './delivery.js';
import { joinProposal, splitProposal } from './markdown.js';
import { penguinReasonText } from './penguin.js';

/**
 * The buttons and modals of a sales call's message, handled in the public service like every
 * other Slack interaction. Approve and Retry are the shared loop's own buttons and never
 * reach this module, and that includes Publish and "Write to live room", which are approvals
 * of their own. What is handled here changes the draft or the deal, not the outside.
 */
export const REVIEW_MODAL = 'sales_review_modal';
export const REGENERATE_MODAL = 'sales_regenerate_modal';
export const SLUG_MODAL = 'sales_slug_modal';
const NOTE_BLOCK = 'note';
const SLUG_BLOCK = 'slug';
const PENGUIN_BLOCK = 'penguin';
const sectionBlock = (index: number): string => `section_${index}`;
/** Slack's limit for a text input is 3000 characters. */
const MAX_INPUT = 2900;
const MAX_SECTIONS = 20;

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export interface SalesSlackDeps extends SalesDeps {
  appBaseUrl: string;
  modals: Pick<SlackClient, 'openView'> | null;
}

interface Meta {
  c: string;
  v: number;
  /** The proposal the form showed. */
  p?: string;
}

const encodeMeta = (meta: Meta): string => JSON.stringify(meta);

function decodeMeta(value: unknown): Meta | null {
  try {
    const meta = JSON.parse(asString(value) ?? '') as Meta;
    return typeof meta.c === 'string' && typeof meta.v === 'number' ? meta : null;
  } catch {
    return null;
  }
}

const PENGUIN_OPTIONS = [
  { text: { type: 'plain_text', text: 'Penguin deal' }, value: 'yes' },
  { text: { type: 'plain_text', text: 'Not a Penguin deal' }, value: 'no' },
];

/** Review: what to check, each section in a box that can be changed, and the Penguin mark. */
export function reviewModal(view: SalesView, appBaseUrl: string): SlackView {
  const { sales, proposal, deal } = view;
  const doc = splitProposal(proposal!.contentMd);
  const link = `${appBaseUrl}/sales/proposals/${proposal!.id}`;
  const notes = [
    `*${clip(proposal!.title, 120)}* · v${proposal!.version} · <${link}|open in Patcher>`,
    proposal!.gaps.length ? `*Gaps:* ${clip(proposal!.gaps.join(', '), 400)}` : '',
    ...proposal!.flags.slice(0, 8).map((flag) => `• ${clip(flag, 250)}`),
    proposal!.flags.length > 8 ? `…and ${proposal!.flags.length - 8} more in Patcher.` : '',
  ].filter(Boolean);

  const tooLong: string[] = [];
  const inputs: SlackBlock[] = [];
  doc.sections.slice(0, MAX_SECTIONS).forEach((section, index) => {
    if (section.body.length > MAX_INPUT) {
      tooLong.push(section.heading);
      return;
    }
    inputs.push({
      type: 'input',
      block_id: sectionBlock(index),
      optional: true,
      label: { type: 'plain_text', text: clip(section.heading, 150) },
      element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: MAX_INPUT, ...(section.body ? { initial_value: section.body } : {}) },
    });
  });
  if (tooLong.length || doc.sections.length > MAX_SECTIONS) {
    notes.push(`Some sections are too long to edit here (${clip(tooLong.join(', ') || 'the last ones', 200)}). Edit them in Patcher.`);
  }

  const current = deal?.isPenguin === true ? PENGUIN_OPTIONS[0] : deal?.isPenguin === false ? PENGUIN_OPTIONS[1] : undefined;
  const mark = deal?.isPenguin === null || !deal ? 'not known' : `${deal.isPenguin ? 'yes' : 'no'}${deal.penguinReason ? `, ${penguinReasonText(deal.penguinReason, deal.penguinSetBy)}` : ''}`;
  return {
    type: 'modal',
    callback_id: REVIEW_MODAL,
    private_metadata: encodeMeta({ c: sales.callId, v: sales.version, p: proposal!.id }),
    title: { type: 'plain_text', text: 'Review proposal' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: clip(notes.join('\n'), 2900) } },
      ...inputs,
      {
        type: 'input',
        block_id: PENGUIN_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: 'Penguin deal' },
        hint: { type: 'plain_text', text: clip(`Now: ${mark}. Changing a section saves a new version; an empty box removes the section. Saving does not approve anything.`, 150) },
        element: { type: 'static_select', action_id: 'value', options: PENGUIN_OPTIONS, ...(current ? { initial_option: current } : {}) },
      },
    ],
  };
}

export function regenerateModal(view: SalesView): SlackView {
  return {
    type: 'modal',
    callback_id: REGENERATE_MODAL,
    private_metadata: encodeMeta({ c: view.sales.callId, v: view.sales.version }),
    title: { type: 'plain_text', text: 'Regenerate proposal' },
    submit: { type: 'plain_text', text: 'Draft again' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: NOTE_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: 'What should the new draft do differently?' },
        hint: { type: 'plain_text', text: 'The note can change emphasis and length. Facts still come only from the call, and prices only from the rate card.' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 1000 },
      },
    ],
  };
}

export function slugModal(view: SalesView): SlackView {
  return {
    type: 'modal',
    callback_id: SLUG_MODAL,
    private_metadata: encodeMeta({ c: view.sales.callId, v: view.sales.version }),
    title: { type: 'plain_text', text: 'Deal room slug' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: SLUG_BLOCK,
        label: { type: 'plain_text', text: clip(`The slug of the room for ${view.deal?.company ?? 'this deal'}`, 150) },
        hint: { type: 'plain_text', text: 'The last part of the room\'s address, for example "northwind".' },
        element: { type: 'plain_text_input', action_id: 'value', max_length: 63 },
      },
    ],
  };
}

export interface SalesClick {
  actor: string;
  /** The action id without its numeric suffix. */
  actionId: string;
  value: unknown;
  triggerId: string | undefined;
  tell(text: string): Promise<void>;
}

const SALES_ACTION_IDS: readonly string[] = Object.values(SALES_ACTIONS);

/** Handles a click on a sales call's message. False when the action is not one of its own. */
export async function handleSalesAction(deps: SalesSlackDeps, click: SalesClick): Promise<boolean> {
  if (!SALES_ACTION_IDS.includes(click.actionId)) return false;
  // A link button: Slack opens the address itself and only reports the click.
  if (click.actionId === SALES_ACTIONS.openPr || click.actionId === SALES_ACTIONS.openRoom) return true;
  const ref = decodeSalesRef(click.value);
  if (!ref) return true;
  if (!(await getUser(deps.pool, click.actor))) {
    await click.tell('You do not have access to Patcher.');
    return true;
  }
  const input = { callId: ref.callId, actor: click.actor, via: 'slack' as const, expectedVersion: ref.version };
  const report = async (result: SalesResult) => {
    if (!result.ok) await click.tell(result.message);
  };

  switch (click.actionId) {
    case SALES_ACTIONS.yes:
      await report(await setSalesCall(deps, { ...input, sales: true }));
      return true;
    case SALES_ACTIONS.no:
      await report(await setSalesCall(deps, { ...input, sales: false }));
      return true;
    case SALES_ACTIONS.notDeal:
      await report(await notADeal(deps, input));
      return true;
    case SALES_ACTIONS.retry:
      await report(await regenerate(deps, input));
      return true;
    case SALES_ACTIONS.reoffer:
      await report(await reofferDealRoom(deps, input));
      return true;
    default:
      break;
  }

  if (!(await maySell(deps.pool, click.actor))) {
    await click.tell('You are not on the approver list for this.');
    return true;
  }
  const view = await loadSalesView(deps.pool, ref.callId);
  if (!view || view.sales.version !== ref.version || view.call.status === 'deleted') {
    await click.tell('This message is out of date. Check the current one.');
    return true;
  }
  const dealInput = view.deal ? { dealId: view.deal.id, actor: click.actor, via: 'slack' as const, callId: ref.callId, expectedVersion: ref.version } : null;
  if (click.actionId === SALES_ACTIONS.penguinYes || click.actionId === SALES_ACTIONS.penguinNo || click.actionId === SALES_ACTIONS.skip) {
    if (!dealInput) await click.tell('This call has no deal yet.');
    else if (click.actionId === SALES_ACTIONS.skip) await report(await skipDealRoom(deps, dealInput));
    else await report(await setPenguin(deps, { ...dealInput, penguin: click.actionId === SALES_ACTIONS.penguinYes }));
    return true;
  }

  const link = view.proposal ? `${deps.appBaseUrl}/sales/proposals/${view.proposal.id}` : `${deps.appBaseUrl}/sales`;
  let modal: SlackView;
  if (click.actionId === SALES_ACTIONS.review) {
    if (!view.proposal) {
      await click.tell('There is no proposal to review yet.');
      return true;
    }
    modal = reviewModal(view, deps.appBaseUrl);
  } else if (click.actionId === SALES_ACTIONS.regenerate) {
    modal = regenerateModal(view);
  } else {
    if (!view.deal) {
      await click.tell('This call has no deal yet.');
      return true;
    }
    modal = slugModal(view);
  }
  if (!deps.modals || !click.triggerId) {
    await click.tell(`Do this in Patcher: ${link}`);
    return true;
  }
  try {
    await deps.modals.openView({ triggerId: click.triggerId, view: modal });
  } catch (err) {
    deps.log.warn('could not open sales modal', { err });
    await click.tell(`Could not open the form here. Do this in Patcher: ${link}`);
  }
  return true;
}

export type SalesModalAnswer = { handled: false } | { handled: true; errors?: Record<string, string> };

/** Handles the submission of one of the sales modals. `errors` goes back to Slack to be shown on the form. */
export async function handleSalesModal(deps: SalesSlackDeps, actor: string, view: Json): Promise<SalesModalAnswer> {
  const callbackId = view.callback_id;
  if (callbackId !== REVIEW_MODAL && callbackId !== REGENERATE_MODAL && callbackId !== SLUG_MODAL) return { handled: false };
  const values = asObject(asObject(view.state)?.values) ?? {};
  const element = (block: string): Json => asObject(asObject(values[block])?.value) ?? {};
  const typed = (block: string): string => (asString(element(block).value) ?? '').replace(/\r/g, '').trim();
  const firstBlock = callbackId === REGENERATE_MODAL ? NOTE_BLOCK : callbackId === SLUG_MODAL ? SLUG_BLOCK : PENGUIN_BLOCK;
  const fail = (text: string, block = firstBlock): SalesModalAnswer => ({ handled: true, errors: { [block]: clip(text, 150) } });
  const answer = (result: SalesResult, block = firstBlock): SalesModalAnswer => (result.ok ? { handled: true } : fail(result.message, block));

  const meta = decodeMeta(view.private_metadata);
  if (!meta) return fail('This form is out of date. Close it and try again.');
  const input = { callId: meta.c, actor, via: 'slack' as const, expectedVersion: meta.v };

  if (callbackId === REGENERATE_MODAL) return answer(await regenerate(deps, { ...input, note: typed(NOTE_BLOCK) }));

  const current = await loadSalesView(deps.pool, meta.c);
  if (!current || current.sales.version !== meta.v) return fail('The proposal changed while this form was open. Close it and open Review again.');
  if (!current.deal) return fail('This call has no deal yet.');
  const dealInput = { dealId: current.deal.id, actor, via: 'slack' as const };

  if (callbackId === SLUG_MODAL) return answer(await setDealRoomSlug(deps, { ...dealInput, slug: typed(SLUG_BLOCK), callId: meta.c, expectedVersion: meta.v }));

  // Review: the text first, then the mark. The version was checked above; each step raises it.
  if (!current.proposal || current.proposal.id !== meta.p) return fail('The proposal changed while this form was open. Close it and open Review again.');
  if (!(await maySell(deps.pool, actor))) return fail('You are not on the approver list for this.');
  const doc = splitProposal(current.proposal.contentMd);
  let changed = false;
  const sections = doc.sections.flatMap((section, index) => {
    // A section the form had no box for is kept as it is.
    if (index >= MAX_SECTIONS || section.body.length > MAX_INPUT || !(sectionBlock(index) in values)) return [section];
    const body = typed(sectionBlock(index));
    if (body === section.body.trim()) return [section];
    changed = true;
    return body ? [{ heading: section.heading, body }] : [];
  });
  if (changed) {
    if (!sections.length) return fail('A proposal needs at least one section.', sectionBlock(0));
    const saved = await editProposal(deps, { proposalId: current.proposal.id, contentMd: joinProposal({ ...doc, sections }), actor, via: 'slack' });
    if (!saved.ok) return fail(saved.message);
  }
  const chosen = asString(asObject(element(PENGUIN_BLOCK).selected_option)?.value);
  const penguin = chosen === 'yes' ? true : chosen === 'no' ? false : null;
  if (penguin !== null && penguin !== current.deal.isPenguin) return answer(await setPenguin(deps, { ...dealInput, penguin }));
  return { handled: true };
}
