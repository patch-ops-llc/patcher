import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import type { Project } from '../registry/registry.js';
import { cleanLine, cleanText, namesAnother } from '../weekly/wording.js';
import { callBlock, projectCard } from './match.js';
import type { TranscriptIndex } from './quotes.js';
import type { Attendee, SuggestionType } from './types.js';
import { SUGGESTION_TYPES } from './types.js';

/**
 * Suggested changes for a matched call (design 5.3). The model lists what the call asks
 * for; code keeps an item only if its quote is in the transcript, cuts it to the shapes the
 * Slack message allows, and decides what approving it may do. The model cannot choose an
 * action: it names a type, and code maps the type onto the catalog or downgrades it.
 */
const output = z.strictObject({
  suggestions: z
    .array(
      z.strictObject({
        type: z.enum(SUGGESTION_TYPES),
        title: z.string().max(400),
        detail: z.string().max(4000),
        quote: z.string().max(2000),
        repo: z.string().max(200),
        draft: z.string().max(6000),
      }),
    )
    .max(12),
});
export type SuggestOutput = z.infer<typeof output>;

export const SUGGEST_TASK: TaskSpec<SuggestOutput> = {
  feature: 'calls',
  task: 'call-suggestions',
  tool: { name: 'record_suggestions', description: 'Record the follow-up work the call asks for on the project.' },
  schema: output,
  maxTokens: 6000,
  effort: 'medium',
};

export const MAX_TITLE = 80;
const MAX_DETAIL = 700;
const MAX_DRAFT = 1500;
const MAX_README_CHARS = 6000;

export interface RepoContext {
  repo: string;
  readme: string | null;
  pulls: string[];
}

export interface PastDecision {
  title: string;
  decision: 'approved' | 'dismissed';
}

/** The README and open pull requests as text, for the suggestion prompt and the brief prompt. */
export function repoContextText(contexts: RepoContext[]): string {
  return contexts
    .map((c) =>
      [
        `Repository: ${c.repo}`,
        c.pulls.length ? `Open pull requests:\n${c.pulls.slice(0, 15).map((t) => `- ${t}`).join('\n')}` : 'Open pull requests: none read',
        c.readme ? `README (start):\n${c.readme.slice(0, Math.floor(MAX_README_CHARS / contexts.length))}` : 'README: not read',
      ].join('\n'),
    )
    .join('\n\n');
}

export function buildSuggestInput(
  call: { title: string; startedAt: Date | null; durationSeconds: number | null; attendees: Attendee[] },
  project: Project,
  contexts: RepoContext[],
  past: PastDecision[],
  transcript: string,
): string {
  return [
    dataBlock('project', projectCard(project).join('\n')),
    dataBlock('repository', repoContextText(contexts) || 'The project has no repository Patcher could read.'),
    dataBlock('past_decisions', past.length ? past.map((p) => `- ${p.decision}: ${p.title}`).join('\n') : 'None yet.'),
    callBlock(call),
    dataBlock('transcript', transcript),
    `Record the suggestions by calling ${SUGGEST_TASK.tool.name}.`,
  ].join('\n\n');
}

export interface CheckedSuggestion {
  type: SuggestionType;
  /** Set when code changed the type the model gave, with why. */
  draftedType: SuggestionType | null;
  typeNote: string | null;
  title: string;
  detail: string;
  draft: string | null;
  quote: string;
  quoteAt: string | null;
  repo: string | null;
}

export interface SuggestRules {
  /** The project's linked repositories, lower case. */
  repos: string[];
  /** Why a code change cannot be offered at all right now, if it cannot. */
  agentUnavailable: string | null;
  /** Names of the other projects and clients in the registry. */
  otherNames: string[];
  max: number;
}

const URL = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

const clipTitle = (title: string): string => (title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title);

export function checkSuggestions(
  reply: SuggestOutput,
  project: Pick<Project, 'name'>,
  transcript: string,
  index: TranscriptIndex,
  rules: SuggestRules,
): { kept: CheckedSuggestion[]; dropped: string[] } {
  const kept: CheckedSuggestion[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  const spoken = fold(transcript);

  for (const item of reply.suggestions) {
    const title = clipTitle(cleanLine(item.title, 300));
    const label = title || '(no title)';
    if (title.length < 4) {
      dropped.push(`${label}: no usable title`);
      continue;
    }
    // Evidence or nothing: the words must be in the call.
    const found = index.find(item.quote);
    if (!found) {
      dropped.push(`${label}: the quote is not in the transcript`);
      continue;
    }
    if (seen.has(fold(title))) {
      dropped.push(`${label}: listed twice`);
      continue;
    }
    const detail = cleanText(item.detail, MAX_DETAIL);
    let draft = item.type === 'client_followup' ? cleanText(item.draft, MAX_DRAFT) : '';
    // A link nobody said on the call is not something to pass on to a client or an agent.
    const links = `${title} ${detail} ${draft}`.match(URL) ?? [];
    if (links.some((link) => !spoken.includes(fold(link).replace(/[.,;]+$/, '')))) {
      dropped.push(`${label}: it contains a link that is not in the call`);
      continue;
    }
    // One client's line must not carry another's name.
    if (namesAnother(`${title} ${detail} ${draft}`, project.name, rules.otherNames)) {
      dropped.push(`${label}: it names another project or client`);
      continue;
    }

    let type: SuggestionType = item.type;
    let typeNote: string | null = null;
    let repo: string | null = null;
    if (type === 'code_change') {
      const named = item.repo.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, '');
      if (rules.agentUnavailable) typeNote = rules.agentUnavailable;
      else if (!rules.repos.length) typeNote = 'the project has no linked repository';
      else if (rules.repos.length === 1) repo = rules.repos[0]!;
      else if (rules.repos.includes(named)) repo = named;
      else typeNote = 'the call does not say which of the project’s repositories this belongs in';
      if (typeNote) type = 'task';
    }
    if (type === 'client_followup' && draft.length < 10) {
      if (detail.length >= 10) draft = detail;
      else {
        type = 'task';
        typeNote = 'no message was drafted for it';
      }
    }

    seen.add(fold(title));
    kept.push({
      type,
      draftedType: type === item.type ? null : item.type,
      typeNote,
      title,
      detail,
      draft: type === 'client_followup' ? draft : null,
      quote: cleanText(item.quote, 300),
      quoteAt: found.at,
      repo,
    });
    if (kept.length >= rules.max) break;
  }
  return { kept, dropped };
}
