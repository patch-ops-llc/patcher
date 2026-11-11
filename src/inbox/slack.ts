import type { Pool } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Catalog } from '../recommendations/catalog.js';
import { decide } from '../recommendations/service.js';
import { canDecide, getUser } from '../settings/users.js';
import type { SlackBlock, SlackClient, SlackView } from '../slack/client.js';
import { clip, decodeRef, encodeRef, escapeMrkdwn } from '../slack/messages.js';
import { FIX_ACTION } from '../fix/agentFix.js';
import { INBOX_ACTIONS, itemHead, itemState } from './delivery.js';
import type { Item } from './store.js';
import { getItem, isUuid, setDismissReason } from './store.js';
import { DISMISS_REASONS, isDismissReason } from './types.js';

/**
 * The buttons and the modal of a Slack item, handled in the public service like every
 * other interaction: checked, decided in one short transaction, acknowledged. Approve and
 * Dismiss on an item's own message are the loop's own buttons. What is added here is the
 * item view (the draft to copy, the link, and the decision for a digest line) and the
 * one-tap reason after a dismissal.
 */
export const ITEM_MODAL = 'inbox_item_modal';
const DRAFT_BLOCK = 'draft';
const DECISION_BLOCK = 'decision';
const APPROVE = 'approve';

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export interface InboxSlackDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
  log: Logger;
  appBaseUrl: string;
  modals: Pick<SlackClient, 'openView'> | null;
}

export interface InboxClick {
  actor: string;
  actionId: string;
  value: unknown;
  triggerId: string | undefined;
  tell: (text: string) => Promise<void>;
}

const NO_ACCESS = 'You do not have access to Patcher.';

export function itemModal(item: Item, options: { mayDecide: boolean }): SlackView {
  const { bundle, rec } = item;
  const pending = rec?.status === 'posted';
  const lines = [
    itemHead(item),
    escapeMrkdwn(clip(bundle.summary ?? rec?.title ?? 'A Slack message', 200)),
    bundle.status === 'unanalysed'
      ? `_${escapeMrkdwn(clip(bundle.statusDetail ?? 'Not analysed.', 200))}_`
      : `Suggest: ${escapeMrkdwn(clip(bundle.suggestion ?? 'read it in Slack', 200))}`,
    ...(bundle.link ? [`<${bundle.link}|Open the message in Slack>`] : []),
  ];
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (bundle.draft) {
    blocks.push({
      type: 'input',
      block_id: DRAFT_BLOCK,
      optional: true,
      label: { type: 'plain_text', text: 'Draft reply' },
      hint: { type: 'plain_text', text: 'Copy it and send it yourself in Slack. Patcher sends nothing, and changes here are not kept.' },
      element: { type: 'plain_text_input', action_id: 'value', multiline: true, initial_value: bundle.draft.slice(0, 2900) },
    });
  }
  if (rec && pending && options.mayDecide) {
    const option = (text: string, value: string) => ({ text: { type: 'plain_text', text }, value });
    blocks.push({
      type: 'input',
      block_id: DECISION_BLOCK,
      optional: true,
      label: { type: 'plain_text', text: 'Decision' },
      element: {
        type: 'static_select',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: 'Leave it waiting' },
        options: [
          option(rec.action.type === FIX_ACTION ? 'Start the agent' : 'Record a task', APPROVE),
          ...Object.entries(DISMISS_REASONS).map(([reason, label]) => option(`Dismiss: ${label.toLowerCase()}`, reason)),
        ],
      },
    });
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: pending ? 'You are not on the approver list for this.' : `Status: ${itemState(item)}` }] });
  }
  return {
    type: 'modal',
    callback_id: ITEM_MODAL,
    private_metadata: rec ? `${bundle.id}|${encodeRef(rec)}` : bundle.id,
    title: { type: 'plain_text', text: 'Slack item' },
    submit: { type: 'plain_text', text: 'Done' },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

/** True when the click was one of the item's own buttons, whatever came of it. */
export async function handleInboxAction(deps: InboxSlackDeps, click: InboxClick): Promise<boolean> {
  if (click.actionId === INBOX_ACTIONS.link) return true;

  if (click.actionId === INBOX_ACTIONS.reason) {
    const [bundleId, reason] = typeof click.value === 'string' ? click.value.split('|') : [];
    const user = await getUser(deps.pool, click.actor);
    if (!user) {
      await click.tell(NO_ACCESS);
      return true;
    }
    if (!isUuid(bundleId) || !isDismissReason(reason)) return true;
    const item = await getItem(deps.pool, bundleId);
    if (!item?.rec || !canDecide(user, item.rec.kind)) {
      await click.tell('You are not on the approver list for this.');
      return true;
    }
    if (await setDismissReason(deps.pool, bundleId, reason, click.actor)) {
      await deps.queue.enqueue('recommendation.sync', { recommendationId: item.rec.id });
    }
    return true;
  }

  if (click.actionId === INBOX_ACTIONS.open) {
    const user = await getUser(deps.pool, click.actor);
    if (!user) {
      await click.tell(NO_ACCESS);
      return true;
    }
    const item = isUuid(click.value) ? await getItem(deps.pool, click.value) : null;
    if (!item) {
      await click.tell('This item is no longer kept.');
      return true;
    }
    const page = `${deps.appBaseUrl}/inbox/items/${item.bundle.id}`;
    if (!deps.modals || !click.triggerId) {
      await click.tell(`Open it in Patcher: ${page}`);
      return true;
    }
    try {
      await deps.modals.openView({ triggerId: click.triggerId, view: itemModal(item, { mayDecide: Boolean(item.rec && canDecide(user, item.rec.kind)) }) });
    } catch (err) {
      deps.log.warn('could not open the slack item', { err });
      await click.tell(`Could not open it here. Open it in Patcher: ${page}`);
    }
    return true;
  }
  return false;
}

export async function handleInboxModal(deps: InboxSlackDeps, actor: string, view: Json): Promise<{ handled: boolean; errors?: Record<string, string> }> {
  if (view.callback_id !== ITEM_MODAL) return { handled: false };
  const meta = asString(view.private_metadata) ?? '';
  const bundleId = meta.slice(0, 36);
  const ref = decodeRef(meta.slice(37));
  const values = asObject(asObject(view.state)?.values) ?? {};
  const selected = asString(asObject(asObject(asObject(values[DECISION_BLOCK])?.value)?.selected_option)?.value);
  if (!selected) return { handled: true };
  if (!ref || !isUuid(bundleId)) return { handled: true, errors: { [DECISION_BLOCK]: 'This form is out of date. Close it and open the item again.' } };
  if (selected !== APPROVE && !isDismissReason(selected)) return { handled: true };

  const result = await decide(deps, { id: ref.id, hash: ref.hash, actor, via: 'slack', decision: selected === APPROVE ? 'approve' : 'dismiss' });
  if (!result.ok) return { handled: true, errors: { [DECISION_BLOCK]: clip(result.message, 150) } };
  if (selected !== APPROVE && isDismissReason(selected)) await setDismissReason(deps.pool, bundleId, selected, actor);
  return { handled: true };
}
