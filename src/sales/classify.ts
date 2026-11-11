import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import { externalDomains } from '../calls/hints.js';
import { callBlock } from '../calls/match.js';
import type { TranscriptIndex } from '../calls/quotes.js';
import type { Attendee } from '../calls/types.js';
import type { Project } from '../registry/registry.js';
import { cleanText } from '../weekly/wording.js';
import type { CallType } from './types.js';
import { CALL_TYPES } from './types.js';

/**
 * Detecting a sales call (design 6.1). The model says what kind of call it read and quotes
 * the words that show it; code decides what that is worth. A reading whose quote is not in
 * the transcript is never sure enough to start a proposal without asking.
 */
const output = z.strictObject({
  type: z.enum(CALL_TYPES),
  confidence: z.number().min(0).max(1),
  quote: z.string().max(2000),
});
export type ClassifyOutput = z.infer<typeof output>;

export const CLASSIFY_TASK: TaskSpec<ClassifyOutput> = {
  feature: 'sales',
  task: 'sales-classify',
  tool: { name: 'record_call_type', description: 'Record what kind of call this was.' },
  schema: output,
  maxTokens: 1200,
  effort: 'low',
};

/** The deterministic hints of design 6.1. Facts the registry and the settings give, not the model's reading. */
export interface TypeHints {
  /** An external attendee's e-mail domain belongs to an active project: a client already. */
  knownClient: boolean;
  /** The words set in the UI that the call's title contains. */
  titleWords: string[];
  /** The earlier analysis matched the call to a registered project. */
  matchedProject: boolean;
}

export function typeHints(
  call: { title: string; hostEmail: string | null; attendees: Attendee[] },
  options: { projects: Project[]; internalDomains: string[]; titlePatterns: string[]; matchedProject: boolean },
): TypeHints {
  const external = new Set(externalDomains(call, options.internalDomains));
  const clientDomains = new Set(options.projects.filter((p) => p.status === 'active').flatMap((p) => p.domains.map((d) => d.toLowerCase())));
  const title = call.title.toLowerCase();
  return {
    knownClient: [...external].some((domain) => clientDomains.has(domain)),
    titleWords: options.titlePatterns.filter((word) => word && title.includes(word)),
    matchedProject: options.matchedProject,
  };
}

export const parsePatterns = (list: string): string[] =>
  list
    .split(/[,\n]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

export function buildClassifyInput(
  call: { title: string; startedAt: Date | null; durationSeconds: number | null; attendees: Attendee[] },
  hints: TypeHints,
  transcript: string,
): string {
  const lines = [
    `An external attendee's e-mail domain belongs to an active client project: ${hints.knownClient ? 'yes' : 'no'}`,
    `The call was matched to a registered client project: ${hints.matchedProject ? 'yes' : 'no'}`,
    `Words in the title that are set as sales hints: ${hints.titleWords.length ? hints.titleWords.join(', ') : 'none'}`,
  ];
  return [
    callBlock(call),
    dataBlock('hints', lines.join('\n')),
    dataBlock('transcript', transcript),
    `Record your reading by calling ${CLASSIFY_TASK.tool.name}.`,
  ].join('\n\n');
}

export interface CheckedType {
  type: CallType;
  confidence: number;
  /** The words of the call behind the reading, when they are in the transcript. */
  quote: string | null;
  at: string | null;
}

export function checkType(reply: ClassifyOutput, index: TranscriptIndex, autoThreshold: number): CheckedType {
  const found = index.find(reply.quote);
  const confidence = found ? reply.confidence : Math.min(reply.confidence, Math.max(0, autoThreshold - 0.01));
  return {
    type: reply.type,
    confidence: Math.round(confidence * 1000) / 1000,
    quote: found ? cleanText(reply.quote, 300) : null,
    at: found?.at ?? null,
  };
}
