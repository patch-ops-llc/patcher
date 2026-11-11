import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import type { TrackedFinding } from './findings.js';
import type { AuditReport, FixInfo } from './report.js';
import { CATEGORIES, subject } from './types.js';
import { cleanLine, numbersGrounded, namesAnother } from './wording.js';

/**
 * Step 3 of the analysis (design 7.3 and 10.1, "Audit rollup"): one call that is given every
 * open finding above informational, with last week's report for comparison, and returns the
 * order to read them in and the wording of the few that go to Slack. It sees one short entry
 * per finding and no logs. It cannot add, remove or re-grade a finding: the counts in the
 * message come from the rules.
 */

const output = z.strictObject({
  ranking: z.array(z.string().max(12)).max(400),
  top: z.array(z.strictObject({ finding: z.string().max(12), line: z.string().max(600) })).max(10),
});
export type RollupOutput = z.infer<typeof output>;

export const ROLLUP_TASK: TaskSpec<RollupOutput> = {
  feature: 'audit',
  task: 'audit-rollup',
  tool: {
    name: 'record_ranking',
    description: 'Record the order in which the findings should be read and the wording of the first five.',
  },
  schema: output,
  maxTokens: 8000,
  effort: 'medium',
};

/** More open findings than this above informational: the first ones by the rules are ranked, the rest follow in the rules' order. */
export const MAX_RANKED = 150;
export const MAX_LINE = 110;
const MAX_GONE = 25;

const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const FIX_NOTE: Partial<Record<FixInfo['status'], string>> = {
  in_progress: 'a fix is already waiting for a decision, running, or has a pull request open',
};

export interface RollupInput {
  user: string;
  /** Reference used in the prompt ("R1") to finding id. */
  refs: Record<string, string>;
}

/**
 * The findings must come in the rules' order. Returns null when nothing is above
 * informational, in which case there is nothing to rank and no call is made.
 */
export function buildRollupInput(
  ruleRanked: TrackedFinding[],
  fixes: Map<string, FixInfo>,
  previous: AuditReport | null,
): RollupInput | null {
  const candidates = ruleRanked.filter((f) => f.severity !== 'info').slice(0, MAX_RANKED);
  if (!candidates.length) return null;
  const lastWeek = new Map((previous?.findings ?? []).map((f, index) => [f.id, index + 1]));
  const refs: Record<string, string> = {};
  const entries: string[] = [];
  candidates.forEach((f, index) => {
    const ref = `R${index + 1}`;
    refs[ref] = f.id;
    const where = [f.scope.projectName, f.scope.serviceName].filter(Boolean).join(' / ');
    const place = lastWeek.get(f.id);
    entries.push(
      `${ref} · ${f.severity} · ${CATEGORIES[f.category]} · ${where}${f.scope.environmentName ? ` (${f.scope.environmentName})` : ''}`,
      `found: ${flat(f.title, 300)}`,
      ...(f.cause ? [`cause: ${flat(f.cause, 300)}`] : []),
      `open: ${f.isNew ? 'new this week' : `week ${f.weeksOpen}${f.growing ? ', growing' : ''}`}`,
      ...(FIX_NOTE[fixes.get(f.id)?.status ?? 'none'] ? [`fix: ${FIX_NOTE[fixes.get(f.id)!.status]!}`] : []),
      ...(previous ? [`last week: ${place ? `number ${place} in the report` : 'not in the report'}`] : []),
      '',
    );
  });

  const open = new Set(ruleRanked.map((f) => f.id));
  const gone = (previous?.findings ?? []).filter((f) => f.severity !== 'info' && !open.has(f.id)).slice(0, MAX_GONE);
  return {
    refs,
    user: [
      dataBlock('findings', entries.join('\n')),
      dataBlock(
        'last_week',
        !previous
          ? 'There is no earlier report: this is the first audit.'
          : gone.length
            ? gone.map((f) => `- ${f.severity} · ${f.subject} ${flat(f.title, 200)}`).join('\n')
            : 'Every finding above informational from last week is still open.',
      ),
      `Rank the findings by calling ${ROLLUP_TASK.tool.name}.`,
    ].join('\n\n'),
  };
}

export interface Rollup {
  /** Every open finding: the ones the model ranked in its order, then the rest in the rules' order. */
  order: TrackedFinding[];
  /** Drafted Slack wording by finding id, for the ones that passed the checks. */
  lines: Map<string, string>;
  ranked: number;
  /** Drafted lines that failed a check. The finding's own wording is used instead. */
  rejectedLines: number;
}

/**
 * Applies the model's order and wording. A reference it did not give keeps its place in the
 * rules' order after the ranked ones, so nothing can fall out of the report. A drafted line
 * is used only if it fits, states no number the finding does not state, and names no other
 * project.
 */
export function applyRollup(reply: RollupOutput, refs: Record<string, string>, ruleRanked: TrackedFinding[], projectNames: string[]): Rollup {
  const byId = new Map(ruleRanked.map((f) => [f.id, f]));
  const placed = new Set<string>();
  const order: TrackedFinding[] = [];
  for (const ref of reply.ranking) {
    const id = refs[ref.trim()];
    const finding = id ? byId.get(id) : undefined;
    if (!finding || placed.has(finding.id)) continue;
    placed.add(finding.id);
    order.push(finding);
  }
  const ranked = order.length;
  for (const finding of ruleRanked) if (!placed.has(finding.id)) order.push(finding);

  const lines = new Map<string, string>();
  let rejectedLines = 0;
  for (const item of reply.top) {
    const id = refs[item.finding.trim()];
    const finding = id ? byId.get(id) : undefined;
    if (!finding || lines.has(finding.id)) continue;
    const line = cleanLine(item.line, MAX_LINE);
    const grounds = [finding.title, finding.rule.title, finding.cause, String(finding.weeksOpen), ...finding.evidence.flatMap((e) => [e.quote, e.source])];
    if (line.length >= 8 && numbersGrounded(line, grounds) && !namesAnother(line, finding.scope.projectName, projectNames)) {
      lines.set(finding.id, line);
    } else {
      rejectedLines += 1;
    }
  }
  return { order, lines, ranked, rejectedLines };
}

/** "acme api crash loop since Tuesday": the subject is always put in front by code, never by the model. */
export const lineFor = (finding: TrackedFinding, line: string | undefined): string => `${subject(finding.scope)} ${line ?? finding.title}`;
