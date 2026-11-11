import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import { callBlock } from '../calls/match.js';
import type { TranscriptIndex } from '../calls/quotes.js';
import type { Attendee } from '../calls/types.js';
import { cleanLine, cleanText } from '../weekly/wording.js';
import type { Brief, BriefPerson, Quoted } from './types.js';

/**
 * The deal brief (design 6.2, steps 1 and 2). The model extracts what the call established
 * and quotes the words behind each field. Code keeps a field only when its quote is in the
 * transcript; a field that is empty or was dropped is a gap, named and never guessed.
 */
const field = z.strictObject({ text: z.string().max(2000), quote: z.string().max(2000) });

const output = z.strictObject({
  company: field,
  people: z
    .array(
      z.strictObject({
        name: z.string().max(200),
        role: z.string().max(300),
        side: z.enum(['prospect', 'us', 'unknown']),
        quote: z.string().max(2000),
      }),
    )
    .max(15),
  problem: field,
  outcome: field,
  scope: z.array(field).max(15),
  constraints: z.array(field).max(10),
  timeline: field,
  budget: field,
  objections: z.array(field).max(10),
  next_steps: z.array(field).max(10),
});
export type BriefOutput = z.infer<typeof output>;

export const BRIEF_TASK: TaskSpec<BriefOutput> = {
  feature: 'sales',
  task: 'deal-brief',
  tool: { name: 'record_deal_brief', description: 'Record what the sales call established, each point with the words of the call behind it.' },
  schema: output,
  maxTokens: 6000,
  effort: 'medium',
};

const MAX_TEXT = 400;
const MAX_QUOTE = 300;

export function buildBriefInput(
  call: { title: string; startedAt: Date | null; durationSeconds: number | null; attendees: Attendee[] },
  transcript: string,
  earlier: Brief | null,
): string {
  return [
    callBlock(call),
    // A follow-up call is read knowing what the earlier calls with the same prospect established.
    ...(earlier ? [dataBlock('earlier_brief', briefText(earlier))] : []),
    dataBlock('transcript', transcript),
    `Record the brief by calling ${BRIEF_TASK.tool.name}.`,
  ].join('\n\n');
}

export interface CheckedBrief {
  brief: Brief;
  /** Why fields of the reply were not used, for the log. */
  dropped: string[];
}

export function checkBrief(reply: BriefOutput, index: TranscriptIndex): CheckedBrief {
  const dropped: string[] = [];
  const one = (name: string, value: { text: string; quote: string }): Quoted | null => {
    const text = cleanText(value.text, MAX_TEXT);
    if (!text) return null;
    const found = index.find(value.quote);
    if (!found) {
      dropped.push(`${name}: the quote is not in the transcript`);
      return null;
    }
    return { text, quote: cleanText(value.quote, MAX_QUOTE), at: found.at };
  };
  const many = (name: string, values: { text: string; quote: string }[], max: number): Quoted[] => {
    const seen = new Set<string>();
    const kept: Quoted[] = [];
    for (const value of values) {
      const checked = one(name, value);
      if (!checked || seen.has(checked.text.toLowerCase())) continue;
      seen.add(checked.text.toLowerCase());
      kept.push(checked);
      if (kept.length === max) break;
    }
    return kept;
  };

  const people: BriefPerson[] = [];
  for (const person of reply.people) {
    const name = cleanLine(person.name, 80);
    if (!name) continue;
    const found = index.find(person.quote);
    if (!found) {
      dropped.push('person: the quote is not in the transcript');
      continue;
    }
    if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    people.push({ name, role: cleanLine(person.role, 120), side: person.side, quote: cleanText(person.quote, MAX_QUOTE), at: found.at });
    if (people.length === 10) break;
  }

  const company = one('company', reply.company);
  return {
    brief: {
      company: company ? { ...company, text: cleanLine(company.text, 100) || company.text.slice(0, 100) } : null,
      people,
      problem: one('problem', reply.problem),
      outcome: one('outcome', reply.outcome),
      scope: many('scope', reply.scope, 10),
      constraints: many('constraint', reply.constraints, 6),
      timeline: one('timeline', reply.timeline),
      budget: one('budget', reply.budget),
      objections: many('objection', reply.objections, 6),
      nextSteps: many('next step', reply.next_steps, 6),
    },
    dropped,
  };
}

/** A later call adds to what earlier calls with the same prospect established; it does not erase it. */
export function mergeBriefs(earlier: Brief | null, latest: Brief): Brief {
  if (!earlier) return latest;
  const list = (a: Quoted[], b: Quoted[], max: number): Quoted[] => {
    const seen = new Set<string>();
    return [...b, ...a].filter((q) => (seen.has(q.text.toLowerCase()) ? false : (seen.add(q.text.toLowerCase()), true))).slice(0, max);
  };
  const people = [...latest.people];
  for (const person of earlier.people) if (!people.some((p) => p.name.toLowerCase() === person.name.toLowerCase())) people.push(person);
  return {
    company: latest.company ?? earlier.company,
    people: people.slice(0, 10),
    problem: latest.problem ?? earlier.problem,
    outcome: latest.outcome ?? earlier.outcome,
    scope: list(earlier.scope, latest.scope, 12),
    constraints: list(earlier.constraints, latest.constraints, 8),
    timeline: latest.timeline ?? earlier.timeline,
    budget: latest.budget ?? earlier.budget,
    objections: list(earlier.objections, latest.objections, 8),
    nextSteps: latest.nextSteps.length ? latest.nextSteps : earlier.nextSteps,
  };
}

/** Step 2: what a proposal needs and the calls did not cover. Decided by code from the checked brief. */
export function briefGaps(brief: Brief): string[] {
  const gaps: string[] = [];
  if (!brief.company) gaps.push('company name');
  if (!brief.problem) gaps.push('problem');
  if (!brief.outcome) gaps.push('desired outcome');
  if (!brief.scope.length) gaps.push('scope');
  if (!brief.timeline) gaps.push('start date');
  if (!brief.budget) gaps.push('budget');
  if (!brief.nextSteps.length) gaps.push('next steps');
  return gaps;
}

/** Whether the calls gave a proposal anything to stand on. Without one of these, nothing is drafted. */
export const hasSubstance = (brief: Brief): boolean => Boolean(brief.problem ?? brief.outcome ?? brief.scope[0]);

const said = (q: Quoted): string => `${q.text} (said: "${q.quote}")`;

/** The brief as the drafting and checking prompts read it. */
export function briefText(brief: Brief): string {
  const lines: string[] = [];
  const add = (label: string, value: Quoted | null) => lines.push(`${label}: ${value ? said(value) : 'not covered in the call'}`);
  const addList = (label: string, values: Quoted[]) => {
    if (!values.length) lines.push(`${label}: not covered in the call`);
    else lines.push(`${label}:`, ...values.map((v) => `- ${said(v)}`));
  };
  add('Company', brief.company);
  if (brief.people.length) {
    lines.push('People:', ...brief.people.map((p) => `- ${p.name}${p.role ? `, ${p.role}` : ''} (${p.side === 'us' ? 'our side' : p.side === 'prospect' ? "the prospect's side" : 'side unclear'})`));
  }
  add('Problem', brief.problem);
  add('Desired outcome', brief.outcome);
  addList('Scope items', brief.scope);
  addList('Constraints', brief.constraints);
  add('Timeline', brief.timeline);
  add('Budget signals', brief.budget);
  addList('Objections', brief.objections);
  addList('Agreed next steps', brief.nextSteps);
  return lines.join('\n');
}

/** The quotes a recommendation carries as its evidence (guardrail 2). */
export function briefEvidence(brief: Brief, source: string): { quote: string; source: string }[] {
  const picked = [brief.problem, brief.outcome, ...brief.scope, brief.timeline, brief.budget, ...brief.nextSteps].filter((q): q is Quoted => q !== null);
  return picked.slice(0, 6).map((q) => ({ quote: q.quote, source: q.at ? `${source} at ${q.at}` : source }));
}
