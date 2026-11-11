import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import { cleanLine } from '../weekly/wording.js';
import { briefText } from './brief.js';
import { catalogText } from './draft.js';
import type { ProposalDoc } from './markdown.js';
import type { Brief, CatalogItem } from './types.js';

/**
 * The grounding check (design 6.2, step 4): a second model call, with its own prompt, reads
 * the draft next to the brief and the catalog and points at what does not trace to either.
 * It returns excerpts only. Code finds each excerpt in the draft and removes the sentence or
 * list item it is in, or keeps it and flags it for the person reviewing. An excerpt that is
 * not in the draft changes nothing.
 */
const output = z.strictObject({
  issues: z
    .array(
      z.strictObject({
        excerpt: z.string().max(2000),
        problem: z.string().max(1000),
        action: z.enum(['remove', 'flag']),
      }),
    )
    .max(30),
});
export type CheckOutput = z.infer<typeof output>;

export const CHECK_TASK: TaskSpec<CheckOutput> = {
  feature: 'sales',
  task: 'proposal-check',
  tool: { name: 'record_grounding_check', description: 'Record the parts of the draft that do not trace to the brief or the catalog.' },
  schema: output,
  maxTokens: 4000,
  effort: 'medium',
};

const MIN_EXCERPT = 12;
const fold = (text: string): string => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function buildCheckInput(input: { brief: Brief; catalog: CatalogItem[]; doc: ProposalDoc }): string {
  const draft = input.doc.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
  return [
    dataBlock('brief', briefText(input.brief)),
    dataBlock('catalog', catalogText(input.catalog)),
    dataBlock('draft', `# ${input.doc.title}\n\n${draft}`),
    `Record what you found by calling ${CHECK_TASK.tool.name}.`,
  ].join('\n\n');
}

/** Removes from one line the sentences that hold the excerpt; the whole line when it is a list item or the excerpt spans sentences. */
function cutLine(line: string, wanted: string): string {
  const item = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line);
  if (item) return '';
  const sentences = line.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !fold(sentence).includes(wanted));
  return kept.length === sentences.length ? '' : kept.join(' ');
}

export interface CheckResult {
  doc: ProposalDoc;
  flags: string[];
  removed: number;
  /** Issues whose excerpt is not in the draft, for the log. */
  ignored: number;
}

export function applyCheck(doc: ProposalDoc, reply: CheckOutput): CheckResult {
  const sections = doc.sections.map((s) => ({ ...s }));
  const flags: string[] = [];
  let removed = 0;
  let ignored = 0;

  for (const issue of reply.issues) {
    const wanted = fold(issue.excerpt);
    const problem = cleanLine(issue.problem, 160) || 'not supported by the brief';
    const shown = cleanLine(issue.excerpt, 140) || `${issue.excerpt.replace(/\s+/g, ' ').slice(0, 120)}…`;
    if (wanted.length < MIN_EXCERPT) {
      ignored += 1;
      continue;
    }
    const section = sections.find((s) => fold(s.body).includes(wanted));
    if (!section) {
      ignored += 1;
      continue;
    }
    if (issue.action === 'flag') {
      flags.push(`Check in "${section.heading}": "${shown}" (${problem})`);
      continue;
    }
    const lines = section.body.split('\n');
    const at = lines.findIndex((line) => !/^\s*#/.test(line) && fold(line).includes(wanted));
    if (at < 0) {
      // The excerpt runs across lines or is a heading: too coarse to cut safely, so a person decides.
      flags.push(`Check in "${section.heading}": "${shown}" (${problem})`);
      continue;
    }
    lines[at] = cutLine(lines[at]!, wanted);
    section.body = lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    removed += 1;
    flags.push(`Removed from "${section.heading}": "${shown}" (${problem})`);
  }

  const kept = sections.filter((s) => {
    if (s.body.replace(/^\s*#+.*$/gm, '').trim()) return true;
    flags.push(`The section "${s.heading}" was left out: nothing in it traced to the brief.`);
    return false;
  });
  return { doc: { ...doc, sections: kept }, flags, removed, ignored };
}
