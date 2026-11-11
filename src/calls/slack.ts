import type { Pool } from '../db/pool.js';
import { FIX_ACTION } from '../fix/agentFix.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Catalog } from '../recommendations/catalog.js';
import { CatalogError } from '../recommendations/catalog.js';
import { decide, editRecommendation, getRecommendation } from '../recommendations/service.js';
import type { Recommendation } from '../recommendations/types.js';
import { listProjects } from '../registry/registry.js';
import { canDecide, getUser } from '../settings/users.js';
import type { SlackBlock, SlackClient, SlackView } from '../slack/client.js';
import { clip, decodeRef, encodeRef } from '../slack/messages.js';
import { setCallProject } from './analyze.js';
import { approverNote, withApproverNote } from './brief.js';
import { CALL_KINDS, FOLLOWUP_ACTION, TASK_ACTION } from './catalog.js';
import type { Item } from './delivery.js';
import { CALL_ACTIONS, actionable, decodeCallRef, encodeCallRef, loadCallView } from './delivery.js';
import type { SuggestionType } from './types.js';

/**
 * The buttons and modals of a call's message, handled in the public service like every
 * other Slack interaction: checked, decided in one short transaction, acknowledged. The
 * decisions themselves go through the shared loop (`decide`, `editRecommendation`), so the
 * approver list, the hash on the button and the audit log apply unchanged.
 */
export const PICK_MODAL = 'call_pick_modal';
export const PROJECT_MODAL = 'call_project_modal';
const PICK_BLOCK = 'pick';
const PROJECT_BLOCK = 'project';
const editBlock = (position: number): string => `edit_${position}`;
const NO_PROJECT = 'none';

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export interface CallSlackDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
  log: Logger;
  appBaseUrl: string;
  modals: Pick<SlackClient, 'openView'> | null;
}

const NOT_APPROVER = 'You are not on the approver list for this.';

async function mayDecide(deps: CallSlackDeps, actor: string): Promise<boolean> {
  const user = await getUser(deps.pool, actor);
  return Boolean(user && Object.values(CALL_KINDS).some((kind) => canDecide(user, kind)));
}

/** What the edit box of the Pick modal holds for a suggestion, and how a new text changes its action. */
function editable(rec: Recommendation): { label: string; initial: string; apply(text: string): { body: string; params: unknown } } | null {
  const params = asObject(rec.action.params) ?? {};
  if (rec.action.type === TASK_ACTION) {
    return {
      label: 'What the task is',
      initial: asString(params.detail) ?? '',
      apply: (text) => ({ body: clip(text, 400), params: { ...params, detail: text } }),
    };
  }
  if (rec.action.type === FOLLOWUP_ACTION) {
    return {
      label: 'The drafted message',
      initial: asString(params.draft) ?? '',
      apply: (text) => ({ body: rec.body, params: { ...params, draft: text } }),
    };
  }
  if (rec.action.type === FIX_ACTION) {
    const prompt = asString(params.prompt) ?? '';
    return {
      label: 'Add an instruction for the agent',
      initial: approverNote(prompt),
      apply: (text) => ({ body: rec.body, params: { ...params, prompt: withApproverNote(prompt, text) } }),
    };
  }
  return null;
}

const TAG: Record<SuggestionType, string> = { code_change: 'agent', task: 'task', client_followup: 'draft', note: 'note' };

interface PickMeta {
  c: string;
  v: number;
  /** Position and the reference (id and hash) of each suggestion the modal showed. */
  r: [number, string][];
}

export function pickModal(call: { id: string; version: number; title: string }, items: Item[]): SlackView {
  const options = items.map((item) => ({
    text: { type: 'plain_text', text: clip(`${item.suggestion.position}. ${item.suggestion.title} (${TAG[item.suggestion.type]})`, 75) },
    value: String(item.suggestion.position),
  }));
  const edits: SlackBlock[] = items.flatMap((item) => {
    const field = editable(item.rec);
    if (!field) return [];
    return [
      {
        type: 'input',
        block_id: editBlock(item.suggestion.position),
        optional: true,
        label: { type: 'plain_text', text: clip(`${item.suggestion.position}. ${field.label}`, 150) },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          max_length: 1500,
          ...(field.initial ? { initial_value: field.initial.slice(0, 1500) } : {}),
        },
      },
    ];
  });
  const meta: PickMeta = { c: call.id, v: call.version, r: items.map((item) => [item.suggestion.position, encodeRef(item.rec)]) };
  return {
    type: 'modal',
    callback_id: PICK_MODAL,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Pick suggestions' },
    submit: { type: 'plain_text', text: 'Approve picked' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: PICK_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: clip(`Approve from "${call.title}"`, 150) },
        hint: { type: 'plain_text', text: 'Ticked suggestions are approved. The others are skipped.' },
        element: { type: 'checkboxes', action_id: 'value', options, initial_options: options },
      },
      ...edits,
    ],
  };
}

export function projectModal(call: { id: string; version: number; title: string }, projects: { id: string; name: string }[]): SlackView {
  const options = [
    ...projects.slice(0, 99).map((p) => ({ text: { type: 'plain_text', text: clip(p.name, 75) }, value: p.id })),
    { text: { type: 'plain_text', text: 'None of these / new' }, value: NO_PROJECT },
  ];
  return {
    type: 'modal',
    callback_id: PROJECT_MODAL,
    private_metadata: encodeCallRef(call),
    title: { type: 'plain_text', text: 'Wrong project' },
    submit: { type: 'plain_text', text: 'Move the call' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: PROJECT_BLOCK,
        label: { type: 'plain_text', text: clip(`Which project is "${call.title}" about?`, 150) },
        hint: { type: 'plain_text', text: 'Suggestions still waiting are closed, and new ones are drafted for the project you choose.' },
        element: { type: 'static_select', action_id: 'value', options },
      },
    ],
  };
}

export interface CallClick {
  actor: string;
  /** The action id without its numeric suffix. */
  actionId: string;
  value: unknown;
  triggerId: string | undefined;
  tell(text: string): Promise<void>;
}

const CALL_ACTION_IDS: readonly string[] = Object.values(CALL_ACTIONS);

/** Handles a click on a call's message. False when the action is not one of a call's. */
export async function handleCallAction(deps: CallSlackDeps, click: CallClick): Promise<boolean> {
  if (!CALL_ACTION_IDS.includes(click.actionId)) return false;

  if (click.actionId === CALL_ACTIONS.approveAll) {
    const refs = typeof click.value === 'string' ? click.value.split(',').map(decodeRef) : [];
    const refused = new Set<string>();
    for (const ref of refs.slice(0, 10)) {
      if (!ref) continue;
      const result = await decide(deps, { id: ref.id, hash: ref.hash, actor: click.actor, via: 'slack', decision: 'approve' });
      if (!result.ok) refused.add(result.message);
    }
    if (refused.size) await click.tell([...refused].slice(0, 3).join(' '));
    return true;
  }

  const ref = decodeCallRef(click.value);
  if (!ref) return true;
  const link = `${deps.appBaseUrl}/calls/${ref.callId}`;

  if (click.actionId === CALL_ACTIONS.details) {
    if (await getUser(deps.pool, click.actor)) await deps.queue.enqueue('calls.details', { callId: ref.callId });
    else await click.tell('You do not have access to Patcher.');
    return true;
  }

  if (!(await mayDecide(deps, click.actor))) {
    await click.tell(NOT_APPROVER);
    return true;
  }

  if (click.actionId === CALL_ACTIONS.project) {
    const result = await setCallProject(deps, {
      callId: ref.callId,
      projectId: ref.extra && ref.extra !== NO_PROJECT ? ref.extra : null,
      actor: click.actor,
      via: 'slack',
      expectedVersion: ref.version,
    });
    if (!result.ok) await click.tell(result.message);
    return true;
  }

  const view = await loadCallView(deps.pool, ref.callId);
  if (!view || view.call.version !== ref.version || view.call.status === 'deleted') {
    await click.tell('This message is out of date. Check the current one.');
    return true;
  }
  let modal: SlackView;
  if (click.actionId === CALL_ACTIONS.pick) {
    const pending = actionable(view).filter((item) => item.rec.status === 'posted');
    if (!pending.length) {
      await click.tell('Nothing on this call is waiting for a decision.');
      return true;
    }
    modal = pickModal(view.call, pending.slice(0, 10));
  } else {
    const projects = (await listProjects(deps.pool)).filter((p) => p.status === 'active');
    modal = projectModal(view.call, projects);
  }
  if (!deps.modals || !click.triggerId) {
    await click.tell(`Do this in Patcher: ${link}`);
    return true;
  }
  try {
    await deps.modals.openView({ triggerId: click.triggerId, view: modal });
  } catch (err) {
    deps.log.warn('could not open call modal', { err });
    await click.tell(`Could not open the form here. Do this in Patcher: ${link}`);
  }
  return true;
}

export type ModalAnswer = { handled: false } | { handled: true; errors?: Record<string, string> };

/** Handles the submission of a call's modal. `errors` goes back to Slack to be shown on the form. */
export async function handleCallModal(deps: CallSlackDeps, actor: string, view: Json): Promise<ModalAnswer> {
  const callbackId = view.callback_id;
  if (callbackId !== PICK_MODAL && callbackId !== PROJECT_MODAL) return { handled: false };
  const values = asObject(asObject(view.state)?.values) ?? {};
  const element = (block: string): Json => asObject(asObject(values[block])?.value) ?? {};

  if (callbackId === PROJECT_MODAL) {
    const fail = (text: string): ModalAnswer => ({ handled: true, errors: { [PROJECT_BLOCK]: clip(text, 150) } });
    const ref = decodeCallRef(view.private_metadata);
    const chosen = asString(asObject(element(PROJECT_BLOCK).selected_option)?.value);
    if (!ref || !chosen) return fail('Choose a project.');
    if (!(await mayDecide(deps, actor))) return fail(NOT_APPROVER);
    const result = await setCallProject(deps, {
      callId: ref.callId,
      projectId: chosen === NO_PROJECT ? null : chosen,
      actor,
      via: 'slack',
      expectedVersion: ref.version,
    });
    return result.ok ? { handled: true } : fail(result.message);
  }

  const fail = (text: string): ModalAnswer => ({ handled: true, errors: { [PICK_BLOCK]: clip(text, 150) } });
  let meta: PickMeta;
  try {
    meta = JSON.parse(asString(view.private_metadata) ?? '') as PickMeta;
    if (!Array.isArray(meta.r)) throw new Error('no refs');
  } catch {
    return fail('This form is out of date. Close it and try again.');
  }
  const selected = element(PICK_BLOCK).selected_options;
  const picked = new Set((Array.isArray(selected) ? selected : []).map((option) => asString(asObject(option)?.value)));

  // Every new wording is checked before anything is decided, so a form with a mistake in
  // one box changes nothing and can be corrected and sent again.
  const plan: { position: number; id: string; hash: string; approve: boolean; edit?: { title: string; body: string; params: unknown } }[] = [];
  for (const [position, encoded] of meta.r.slice(0, 10)) {
    const ref = decodeRef(encoded);
    if (!ref) continue;
    const approve = picked.has(String(position));
    const step: (typeof plan)[number] = { position, id: ref.id, hash: ref.hash, approve };
    if (approve) {
      const rec = await getRecommendation(deps.pool, ref.id);
      const field = rec ? editable(rec) : null;
      const typed = (asString(element(editBlock(position)).value) ?? '').replace(/\r/g, '').trim();
      if (rec && field && typed !== field.initial.slice(0, 1500).trim()) {
        const change = field.apply(typed);
        try {
          deps.catalog.validate({ type: rec.action.type, params: change.params });
        } catch (err) {
          if (!(err instanceof CatalogError)) throw err;
          return { handled: true, errors: { [editBlock(position)]: clip(err.message, 150) } };
        }
        step.edit = { title: rec.title, ...change };
      }
    }
    plan.push(step);
  }

  const problems: string[] = [];
  for (const step of plan) {
    let hash = step.hash;
    if (step.edit) {
      const edited = await editRecommendation(deps, { id: step.id, hash, actor, via: 'slack', ...step.edit });
      if (!edited.ok) {
        if (edited.reason !== 'not_pending') problems.push(`${step.position}: ${edited.message}`);
        continue;
      }
      hash = edited.recommendation.actionHash;
    }
    const result = await decide(deps, { id: step.id, hash, actor, via: 'slack', decision: step.approve ? 'approve' : 'dismiss' });
    // Already decided by someone else in the meantime: the message shows it, and it is not this person's mistake.
    if (!result.ok && result.reason !== 'not_pending') problems.push(`${step.position}: ${result.message}`);
  }
  return problems.length ? fail(problems.join(' ')) : { handled: true };
}
