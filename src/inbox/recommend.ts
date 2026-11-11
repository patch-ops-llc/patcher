import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import { projectCard } from '../calls/match.js';
import type { Project } from '../registry/registry.js';
import { clip } from '../slack/messages.js';
import { cleanLine, namesAnother, safeInstruction } from '../weekly/wording.js';
import { cleanDraft, quoteIn } from './text.js';
import type { Where } from './triage.js';
import { whereBlock } from './triage.js';
import type { Label } from './types.js';

/**
 * Recommend (design 8.6, step 5): the mid model writes a one-line summary, the recommended
 * action and, where one is needed, a draft reply. It words things; it starts nothing. What
 * it returns is checked here, and a person decides in Slack.
 */
export const SUGGESTED_ACTIONS = ['reply', 'task', 'reply_and_task', 'code_change', 'none'] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

const output = z.strictObject({
  summary: z.string().max(300),
  action: z.enum(SUGGESTED_ACTIONS),
  task_title: z.string().max(200),
  draft_reply: z.string().max(2000),
  quote: z.string().max(600),
});
export type RecommendOutput = z.infer<typeof output>;

export const RECOMMEND_TASK: TaskSpec<RecommendOutput> = {
  feature: 'inbox',
  task: 'slack-recommend',
  tool: { name: 'record_recommendation', description: 'Record the summary, the recommended action and a draft reply for this Slack conversation.' },
  schema: output,
  maxTokens: 1500,
  effort: 'medium',
};

export const RECOMMEND_OUTPUT_TOKENS = 350;

export function buildRecommendInput(input: { where: Where; label: Label; project: Project | null; earlier: string | null; messages: string }): string {
  return [
    whereBlock(input.where),
    dataBlock('triage', `The sorting step labelled this conversation: ${input.label}`),
    dataBlock('project', input.project ? projectCard(input.project).join('\n') : 'No registered project was matched.'),
    ...(input.earlier ? [dataBlock('earlier', input.earlier)] : []),
    dataBlock('messages', input.messages),
    `Record your recommendation by calling ${RECOMMEND_TASK.tool.name}.`,
  ].join('\n\n');
}

export interface Wording {
  summary: string;
  action: SuggestedAction;
  taskTitle: string;
  /** Null when no reply is suggested, or the draft did not pass the checks. */
  draft: string | null;
  /** The quoted words, when they are in the messages. */
  quote: string | null;
  /** Whether the model's wording was used, or the rule's. */
  source: 'model' | 'rules';
}

export interface WordingContext {
  sender: string | null;
  channel: string;
  label: Label;
  texts: string[];
  /** The matched project's name, and every other project's, for the cross-client check. */
  ownProject: string;
  otherProjects: string[];
}

const SUMMARY_MAX = 140;
const TITLE_MAX = 120;
const DRAFT_MAX = 1200;

/** What an item says when the model's wording cannot be used: where the message is and who wrote it. */
export function ruleWording(ctx: WordingContext): Wording {
  const from = ctx.sender ? `${ctx.sender} wrote` : 'New message';
  const summary = clip(`${from} in ${ctx.channel}`, SUMMARY_MAX);
  return {
    summary,
    action: 'none',
    taskTitle: clip(`Follow up: ${ctx.sender ?? 'a message'} in ${ctx.channel}`, TITLE_MAX),
    draft: null,
    quote: null,
    source: 'rules',
  };
}

/**
 * Applies the rules to the model's reply. A summary that is empty, too long or names another
 * client's project is replaced by the rule's; a draft that names another project is dropped;
 * a quote that is not in the messages is not used as evidence.
 */
export function checkWording(reply: RecommendOutput, ctx: WordingContext): Wording {
  const fallback = ruleWording(ctx);
  const leaks = (text: string) => namesAnother(text, ctx.ownProject, ctx.otherProjects);
  const summary = cleanLine(reply.summary, SUMMARY_MAX);
  if (!summary || leaks(summary)) return { ...fallback, quote: quoteIn(reply.quote, ctx.texts) ? reply.quote.replace(/\s+/g, ' ').trim() : null };
  const title = cleanLine(reply.task_title, TITLE_MAX);
  const taskTitle = title && !leaks(title) ? title : clip(summary, TITLE_MAX);
  const wantsReply = reply.action === 'reply' || reply.action === 'reply_and_task';
  const cleaned = wantsReply ? cleanDraft(reply.draft_reply, ctx.texts, DRAFT_MAX) : '';
  const draft = cleaned.length >= 2 && !leaks(cleaned) ? cleaned : null;
  return {
    summary,
    action: reply.action,
    taskTitle,
    draft,
    quote: quoteIn(reply.quote, ctx.texts) ? reply.quote.replace(/\s+/g, ' ').trim() : null,
    source: 'model',
  };
}

const quoted = (draft: string): string => `"${clip(draft.replace(/\s+/g, ' '), 60)}"`;

/** The "Suggest:" line of the item, composed by rule from the checked wording. */
export function suggestion(wording: Wording, agent: boolean): string {
  switch (wording.action) {
    case 'reply':
      return wording.draft ? `reply ${quoted(wording.draft)}` : 'reply in Slack';
    case 'reply_and_task':
      return wording.draft ? `reply ${quoted(wording.draft)} and open a task` : 'reply in Slack and open a task';
    case 'task':
      return clip(`open a task: ${wording.taskTitle}`, 140);
    case 'code_change':
      return clip(`${agent ? 'start an agent' : 'open a task'}: ${wording.taskTitle}`, 140);
    default:
      return 'read it in Slack';
  }
}

/**
 * The brief for an agent started from a Slack message. It is composed by rule from Patcher's
 * own summary and task title. The words of the Slack message are never passed to the agent,
 * so nothing written in a channel can instruct it. Null when either line could send an
 * agent to the network or a shell.
 */
export function agentBrief(input: { summary: string; taskTitle: string; projectName: string; workspaceName: string }): string | null {
  if (!safeInstruction(input.summary) || !safeInstruction(input.taskTitle)) return null;
  return [
    `A message in the ${input.workspaceName} Slack workspace asked for a change to ${input.projectName}.`,
    '',
    `Task: ${input.taskTitle}`,
    `What was asked, as summarised by Patcher (not the sender's words): ${input.summary}`,
    '',
    'Find the code this concerns and make the smallest change that does the task. Add or update a test where the repository has tests.',
    'Open a pull request and do not merge it. If the task is not clear enough from the two lines above to act on safely, change nothing and say in the pull request description what is missing.',
  ].join('\n');
}
