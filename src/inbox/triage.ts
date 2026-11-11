import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import { projectCard } from '../calls/match.js';
import type { Project } from '../registry/registry.js';
import { cleanLine } from '../weekly/wording.js';
import type { PastDecision } from './store.js';
import { READER_NAME, quoteIn } from './text.js';
import type { Label, TriageResult, Urgency } from './types.js';
import { LABELS, URGENCIES } from './types.js';

/**
 * Triage (design 8.6, step 4): the small model labels a bundle, sets its urgency, says
 * whether it is addressed to the owner and which project it is about, and quotes the words
 * that show it. Code decides what of that is believed and what happens next.
 */
const output = z.strictObject({
  label: z.enum(LABELS),
  urgency: z.enum(URGENCIES),
  addressed: z.boolean(),
  /** The reference of a listed project, like "P2", or empty. */
  project: z.string().max(12),
  quote: z.string().max(600),
  reason: z.string().max(300),
});
export type TriageOutput = z.infer<typeof output>;

export const TRIAGE_TASK: TaskSpec<TriageOutput> = {
  feature: 'inbox',
  task: 'slack-triage',
  tool: { name: 'record_triage', description: 'Record what this Slack conversation needs from the owner, if anything.' },
  schema: output,
  maxTokens: 600,
  effort: 'low',
};

export const TRIAGE_OUTPUT_TOKENS = 150;
const MAX_CARDS = 40;

export interface TriageInput {
  user: string;
  refs: Map<string, Project>;
}

export interface Where {
  workspaceName: string;
  /** "#project-portal", "a direct message" or "a group message". */
  channel: string;
  inThread: boolean;
  /** How the messages reached Patcher, which decides how much of the conversation it has. */
  completeness: 'conversation' | 'notification';
}

export function whereBlock(where: Where): string {
  return dataBlock(
    'where',
    [
      `Workspace: ${where.workspaceName}`,
      `Conversation: ${where.channel}${where.inThread ? ', in a thread' : ''}`,
      where.completeness === 'conversation'
        ? 'These are the new messages of the conversation, in order.'
        : 'This is the text of a notification about the conversation. The messages around it are not available.',
    ].join('\n'),
  );
}

export function buildTriageInput(input: { where: Where; projects: Project[]; examples: PastDecision[]; earlier: string | null; messages: string }): TriageInput {
  const refs = new Map<string, Project>();
  const cards = input.projects.slice(0, MAX_CARDS).map((project, index) => {
    const ref = `P${index + 1}`;
    refs.set(ref, project);
    return [`[${ref}]`, ...projectCard(project)].join('\n');
  });
  const examples = input.examples.map((e) => `- In ${e.channel}: "${e.summary}" was ${e.outcome}.`);
  return {
    refs,
    user: [
      whereBlock(input.where),
      dataBlock('projects', cards.length ? cards.join('\n\n') : 'No project is registered for this workspace.'),
      dataBlock('past_decisions', examples.length ? examples.join('\n') : 'None yet.'),
      ...(input.earlier ? [dataBlock('earlier', input.earlier)] : []),
      dataBlock('messages', input.messages),
      `Record your reading by calling ${TRIAGE_TASK.tool.name}.`,
    ].join('\n\n'),
  };
}

export interface CheckedTriage {
  result: TriageResult;
  project: Project | null;
  /** The quoted words, when they are in the messages. */
  quote: string | null;
}

/** Labels that lead to a recommendation, and so need words from the messages behind them. */
const ACTIONABLE = new Set<Label>(['reply', 'task', 'escalate']);
export const isActionable = (label: Label): boolean => ACTIONABLE.has(label);

export function checkTriage(reply: TriageOutput, input: { refs: Map<string, Project>; texts: string[]; addressedByRule: boolean }): CheckedTriage {
  const grounded = quoteIn(reply.quote, input.texts);
  return {
    result: {
      label: reply.label,
      urgency: reply.urgency,
      addressed: input.addressedByRule || reply.addressed,
      reason: cleanLine(reply.reason, 200),
      grounded,
    },
    project: input.refs.get(reply.project.trim().toUpperCase()) ?? null,
    quote: grounded ? reply.quote.replace(/\s+/g, ' ').trim() : null,
  };
}

/** `HH:MM-HH:MM` in the given zone, which may run over midnight. An empty setting means no quiet hours. */
export function inQuietHours(now: Date, hours: string, timeZone: string): boolean {
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(hours);
  if (!m) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const at = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (from === to) return false;
  return from < to ? at >= from && at < to : at >= from || at < to;
}

export interface DeliveryRules {
  /** The channel's rule, when it has one. */
  rule: 'include' | 'exclude' | 'digest_only' | 'urgent' | null;
  digestOnly: boolean;
  quiet: boolean;
}

/**
 * Design 8.6, step 7: urgent items at once, the rest in the next digest. Urgent is the
 * model's `escalate` or `now`, or a channel a person marked as always urgent. A person's
 * settings win over the model's reading: a digest-only channel never interrupts, and during
 * quiet hours only an escalation or an always-urgent channel does.
 */
export function decideDelivery(reading: { label: Label; urgency: Urgency } | null, rules: DeliveryRules): { urgent: boolean; delivery: 'now' | 'digest' } {
  const byRule = rules.rule === 'urgent';
  const urgent = byRule || reading?.label === 'escalate' || reading?.urgency === 'now';
  if (!urgent || rules.digestOnly || rules.rule === 'digest_only') return { urgent, delivery: 'digest' };
  if (rules.quiet && !byRule && reading?.label !== 'escalate') return { urgent, delivery: 'digest' };
  return { urgent, delivery: 'now' };
}

export { READER_NAME };
