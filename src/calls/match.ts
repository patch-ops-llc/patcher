import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import type { Project } from '../registry/registry.js';
import { cleanText } from '../weekly/wording.js';
import type { ProjectHints } from './hints.js';
import type { TranscriptIndex } from './quotes.js';
import type { Attendee } from './types.js';
import { minutes } from './types.js';

/**
 * Step two of matching (design 5.2): the model reads the call next to the project cards
 * and the registry's hints, and says which project it is about, how sure it is, and which
 * words of the call show it. Code then decides what of that is believed: a project that is
 * not on the list, or a quote that is not in the transcript, counts for nothing.
 */
const output = z.strictObject({
  summary: z.string().max(2000),
  matches: z
    .array(
      z.strictObject({
        project: z.string().max(12),
        confidence: z.number().min(0).max(1),
        quote: z.string().max(2000),
      }),
    )
    .max(10),
});
export type MatchOutput = z.infer<typeof output>;

export const MATCH_TASK: TaskSpec<MatchOutput> = {
  feature: 'calls',
  task: 'call-match',
  tool: { name: 'record_call_match', description: 'Record which registered project or projects the call is about.' },
  schema: output,
  maxTokens: 2500,
  effort: 'medium',
};

/** A call maps to at most this many projects, and the question offers at most this many. */
export const MAX_PROJECTS = 3;
const MAX_CARDS = 60;

const one = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const domainOf = (email: string | null): string | null => (email?.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : null);

/** Names and e-mail domains only. Addresses are not sent to the model. */
export function attendeeLine(attendees: Attendee[]): string {
  const parts = attendees.slice(0, 30).map((a) => {
    const domain = domainOf(a.email);
    return `${one(a.name ?? 'unnamed', 80)}${domain ? ` (${domain})` : ''}`;
  });
  return parts.length ? parts.join('; ') : 'not given by the source';
}

export function callBlock(call: { title: string; startedAt: Date | null; durationSeconds: number | null; attendees: Attendee[] }): string {
  return dataBlock(
    'call',
    [
      `Title: ${one(call.title, 200)}`,
      `Date: ${call.startedAt ? call.startedAt.toISOString().slice(0, 10) : 'unknown'}`,
      `Length: ${minutes(call.durationSeconds) ?? 'unknown'}`,
      `Attendees: ${attendeeLine(call.attendees)}`,
    ].join('\n'),
  );
}

/** What the model is told about a project: the registry's card, nothing from other calls. */
export function projectCard(project: Project): string[] {
  const repos = project.links.filter((l) => l.kind === 'repo').map((l) => l.externalId);
  return [
    `Name: ${one(project.name, 100)}`,
    ...(project.client ? [`Client: ${one(project.client, 100)}`] : []),
    ...(project.description ? [`About: ${one(project.description, 400)}`] : []),
    ...(project.aliases.length ? [`Also called: ${project.aliases.map((a) => one(a, 60)).join(', ')}`] : []),
    ...(project.domains.length ? [`Client e-mail domains: ${project.domains.join(', ')}`] : []),
    ...(repos.length ? [`Repositories: ${repos.join(', ')}`] : []),
  ];
}

export interface MatchInput {
  user: string;
  /** The short reference each project was given in the prompt. */
  refs: Map<string, Project>;
}

export function buildMatchInput(
  call: { title: string; startedAt: Date | null; durationSeconds: number | null; attendees: Attendee[] },
  projects: Project[],
  hints: Map<string, ProjectHints>,
  transcript: string,
): MatchInput {
  // With a very long registry, the projects the hints point at come first and the rest are cut.
  const ordered = [...projects].sort((a, b) => (hints.get(b.id)?.score ?? 0) - (hints.get(a.id)?.score ?? 0)).slice(0, MAX_CARDS);
  const refs = new Map<string, Project>();
  const cards = ordered.map((project, index) => {
    const ref = `P${index + 1}`;
    refs.set(ref, project);
    const hint = hints.get(project.id);
    return [`[${ref}]`, ...projectCard(project), `Registry hints for this call: ${hint ? hint.lines.join(' ') : 'none'}`].join('\n');
  });
  return {
    refs,
    user: [
      callBlock(call),
      dataBlock('projects', cards.join('\n\n')),
      dataBlock('transcript', transcript),
      `Record your reading by calling ${MATCH_TASK.tool.name}.`,
    ].join('\n\n'),
  };
}

export interface CheckedMatch {
  project: Project;
  confidence: number;
  /** The words of the call behind the match, as found in the transcript. Null: the registry's hints are the evidence. */
  quote: string | null;
  at: string | null;
  hints: string[];
  source: 'model' | 'rules';
}

export interface CheckedMatches {
  summary: string;
  matches: CheckedMatch[];
  /** Why entries of the reply were not used, for the log. */
  dropped: string[];
}

/**
 * Applies the rules to the model's reply. An entry is kept when it names a listed project
 * and has evidence: a quote that is in the transcript, or a registry hint. Without a quote
 * that is in the transcript, a match is never sure enough to be made without asking.
 */
export function checkMatches(
  reply: MatchOutput,
  input: Pick<MatchInput, 'refs'>,
  index: TranscriptIndex,
  hints: Map<string, ProjectHints>,
  autoThreshold: number,
): CheckedMatches {
  const byProject = new Map<string, CheckedMatch>();
  const dropped: string[] = [];
  for (const entry of reply.matches) {
    const project = input.refs.get(entry.project.trim().replace(/^\[|\]$/g, '').toUpperCase());
    if (!project) {
      dropped.push(`${entry.project.slice(0, 12)}: not a listed project`);
      continue;
    }
    const hint = hints.get(project.id);
    const found = index.find(entry.quote);
    if (!found && !hint) {
      dropped.push(`${project.name}: the quote is not in the transcript and the registry has no hint`);
      continue;
    }
    const confidence = found ? entry.confidence : Math.min(entry.confidence, Math.max(0, autoThreshold - 0.01));
    const kept: CheckedMatch = {
      project,
      confidence: Math.round(confidence * 1000) / 1000,
      quote: found ? cleanText(entry.quote, 300) : null,
      at: found?.at ?? null,
      hints: hint?.lines ?? [],
      source: 'model',
    };
    const earlier = byProject.get(project.id);
    if (!earlier || earlier.confidence < kept.confidence) byProject.set(project.id, kept);
  }
  return {
    summary: cleanText(reply.summary, 400),
    matches: [...byProject.values()].sort((a, b) => b.confidence - a.confidence),
    dropped,
  };
}

export interface MatchDecision {
  status: 'matched' | 'needs_project' | 'unmatched';
  /** Projects the call is matched to without asking. */
  matched: CheckedMatch[];
  /** What the question offers, or what the Unmatched list shows as closest. */
  candidates: CheckedMatch[];
}

/** The thresholds of design 5.2: match, ask with the top three, or leave on the Unmatched list. */
export function decideMatch(
  matches: CheckedMatch[],
  hints: Map<string, ProjectHints>,
  projects: Project[],
  thresholds: { auto: number; ask: number },
): MatchDecision {
  const sure = matches.filter((m) => m.confidence >= thresholds.auto).slice(0, MAX_PROJECTS);
  if (sure.length) return { status: 'matched', matched: sure, candidates: [] };

  // Projects the registry points at that the model did not name still make useful buttons.
  const named = new Set(matches.map((m) => m.project.id));
  const hinted: CheckedMatch[] = projects
    .filter((p) => hints.has(p.id) && !named.has(p.id))
    .sort((a, b) => hints.get(b.id)!.score - hints.get(a.id)!.score)
    .map((project) => ({ project, confidence: 0, quote: null, at: null, hints: hints.get(project.id)!.lines, source: 'rules' as const }));
  const candidates = [...matches, ...hinted].slice(0, MAX_PROJECTS);
  const top = matches[0]?.confidence ?? 0;
  return { status: top >= thresholds.ask ? 'needs_project' : 'unmatched', matched: [], candidates };
}
