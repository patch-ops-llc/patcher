import type { ActionRecord, Recommendation } from '../recommendations/types.js';
import type { SlackBlock, SlackMessage, SlackView } from './client.js';

/** Section 4.1: a top-level message is at most five lines of text and one row of four buttons. */
export const MAX_LINES = 5;
export const MAX_BUTTONS = 4;
const MAX_LINE_LENGTH = 160;

export const ACTION_IDS = {
  approve: 'rec_approve',
  edit: 'rec_edit',
  dismiss: 'rec_dismiss',
  details: 'rec_details',
  retry: 'rec_retry',
} as const;
export const EDIT_MODAL_CALLBACK = 'rec_edit_modal';
export const EDIT_FIELDS = { title: 'title', body: 'body', params: 'params' } as const;

/**
 * Text from outside (a transcript, a Slack message, a model) must not be able to mention
 * `@channel`, fake a link or break out of the layout. Slack's own escaping covers that.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The value a button carries: which recommendation, and the hash of what was shown. */
export function encodeRef(rec: Pick<Recommendation, 'id' | 'actionHash'>): string {
  return `${rec.id}|${rec.actionHash}`;
}

const REF_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([0-9a-f]{64})$/;

export function decodeRef(value: unknown): { id: string; hash: string } | null {
  if (typeof value !== 'string') return null;
  const match = REF_PATTERN.exec(value);
  return match ? { id: match[1]!, hash: match[2]! } : null;
}

function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): SlackBlock {
  return {
    type: 'button',
    action_id: actionId,
    text: { type: 'plain_text', text },
    value,
    ...(style ? { style } : {}),
  };
}

function message(lines: string[], buttons: SlackBlock[] = []): SlackMessage {
  const kept = lines.slice(0, MAX_LINES);
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: kept.join('\n') } }];
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons.slice(0, MAX_BUTTONS) });
  return { text: kept[0]!.replace(/\*/g, ''), blocks };
}

function headline(rec: Recommendation, label: string): string {
  return `*${escapeMrkdwn(label)}* · ${escapeMrkdwn(clip(rec.title, MAX_LINE_LENGTH))}`;
}

const by = (rec: Recommendation) => (rec.decidedBy ? ` by <@${rec.decidedBy}>` : '');

/**
 * The one top-level message for a recommendation, for whatever state it is in. While it
 * waits for a decision it shows the content and the buttons; afterwards it is one line.
 */
export function recommendationMessage(rec: Recommendation, label: string): SlackMessage {
  const head = headline(rec, label);
  const ref = encodeRef(rec);
  switch (rec.status) {
    case 'drafted':
    case 'posted': {
      const bodyLines = rec.body
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, MAX_LINES - 1)
        .map((l) => escapeMrkdwn(clip(l, MAX_LINE_LENGTH)));
      return message(
        [head, ...bodyLines],
        [
          button('Approve', ACTION_IDS.approve, ref, 'primary'),
          button('Edit', ACTION_IDS.edit, ref),
          button('Dismiss', ACTION_IDS.dismiss, ref),
          button('Details', ACTION_IDS.details, ref),
        ],
      );
    }
    case 'approved':
    case 'executing':
      return message([`${head} · approved${by(rec)} · running`]);
    case 'done':
      return message([`${head} · approved${by(rec)} · done`]);
    case 'failed':
      return message(
        [`${head} · approved${by(rec)} · failed`],
        [button('Retry', ACTION_IDS.retry, ref), button('Details', ACTION_IDS.details, ref)],
      );
    case 'dismissed':
      return message([`${head} · dismissed${by(rec)}`]);
    case 'expired':
      return message([`${head} · expired with no decision`]);
  }
}

/** Thread reply behind the Details button: the evidence and exactly what approval runs. */
export function detailsReply(rec: Recommendation, actionDescription: string, appBaseUrl: string): SlackMessage {
  const quotes = rec.evidence.slice(0, 3).map((e) => {
    const source = e.url ? `<${e.url}|${escapeMrkdwn(clip(e.source, 60))}>` : escapeMrkdwn(clip(e.source, 60));
    return `> ${escapeMrkdwn(clip(e.quote, 240))} (${source})`;
  });
  const more = rec.evidence.length > 3 ? [`…and ${rec.evidence.length - 3} more in the full view.`] : [];
  const lines = [
    ...quotes,
    ...more,
    `On approval: ${escapeMrkdwn(clip(actionDescription, 240))}`,
    `<${appBaseUrl}/approvals/${rec.id}|Open in Patcher>`,
  ];
  const text = lines.join('\n');
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

/** Thread reply reporting how an approved action ended. */
export function outcomeReply(action: Pick<ActionRecord, 'status' | 'dryRun' | 'lastError' | 'externalRef'>, summary?: string): string {
  if (action.status === 'failed') return `Failed: ${escapeMrkdwn(clip(action.lastError ?? 'unknown error', 300))}`;
  if (action.dryRun) return 'Dry run: logged, nothing was executed.';
  const ref = action.externalRef ? ` ${escapeMrkdwn(clip(action.externalRef, 200))}` : '';
  return `${escapeMrkdwn(clip(summary ?? 'Done.', 200))}${ref}`;
}

export function reminderReply(hoursLeft: number): string {
  const when = hoursLeft < 1.5 ? 'soon' : `in about ${Math.round(hoursLeft)} hours`;
  return `Reminder: still waiting for a decision. This expires ${when}.`;
}

/** The App Home tab: the pending approvals, each linking to its message or the UI. */
export function homeView(
  pending: Recommendation[],
  labelFor: (kind: string) => string,
  appBaseUrl: string,
  paused: boolean,
): SlackView {
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Pending approvals' } },
  ];
  if (paused) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Patcher is paused.' }] });
  }
  if (!pending.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Nothing is waiting for a decision.' } });
  }
  for (const rec of pending.slice(0, 20)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: headline(rec, labelFor(rec.kind)) },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Open' },
        url: `${appBaseUrl}/approvals/${rec.id}`,
        action_id: `home_open_${rec.id}`,
      },
    });
  }
  if (pending.length > 20) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${appBaseUrl}/approvals|All ${pending.length} pending>` }],
    });
  }
  return { type: 'home', blocks };
}

function input(
  blockId: string,
  label: string,
  initial: string,
  options: { multiline?: boolean; maxLength: number; optional?: boolean },
): SlackBlock {
  return {
    type: 'input',
    block_id: blockId,
    optional: options.optional ?? false,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: options.multiline ?? false,
      max_length: options.maxLength,
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

/** The Edit modal. Saving makes a new version; the old buttons stop working. */
export function editModal(rec: Recommendation): SlackView {
  return {
    type: 'modal',
    callback_id: EDIT_MODAL_CALLBACK,
    private_metadata: encodeRef(rec),
    title: { type: 'plain_text', text: 'Edit recommendation' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      input(EDIT_FIELDS.title, 'Title', rec.title, { maxLength: 150 }),
      input(EDIT_FIELDS.body, 'Summary', rec.body, { multiline: true, maxLength: 2000, optional: true }),
      input(EDIT_FIELDS.params, `Action parameters (${rec.action.type}), as JSON`, JSON.stringify(rec.action.params, null, 2), {
        multiline: true,
        maxLength: 3000,
      }),
    ],
  };
}
