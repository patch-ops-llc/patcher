import type { FeatureStatus } from '../config.js';
import type { UnreadEnvironment } from '../railway/collect.js';
import type { InventoryChange } from '../railway/inventory.js';
import type { Evidence } from '../recommendations/types.js';
import type { TrackedFinding } from './findings.js';
import type { ActionType, Category, CheckCoverage, Severity } from './types.js';
import { CATEGORIES, subject } from './types.js';

/** How many findings the Slack message lists: the five-line rule leaves room for three. */
export const TOP_FINDINGS = 3;

export type FixStatus =
  /** A fix recommendation was created for this run's report. */
  | 'proposed'
  /** A fix can be proposed from the finding's page. */
  | 'available'
  /** An earlier fix is still waiting, running, or has a pull request open. */
  | 'in_progress'
  /** A code change could address it, but something is missing; `reason` says what. */
  | 'unavailable'
  /** Not something a code change addresses. */
  | 'none';

export interface FixInfo {
  status: FixStatus;
  reason?: string;
  recommendationId?: string;
}

export interface ReportFinding {
  id: string;
  subject: string;
  title: string;
  severity: Severity;
  category: Category;
  check: string;
  projectName: string;
  environmentName: string | null;
  serviceName: string | null;
  cause: string;
  recommendation: string;
  actionType: ActionType;
  evidence: Evidence[];
  weeksOpen: number;
  isNew: boolean;
  growing: boolean;
  fix: FixInfo;
  /** The wording, cause and recommendation were drafted by the model and passed the checks. */
  ai?: boolean;
}

export interface AuditCounts {
  projects: number;
  services: number;
  critical: number;
  warning: number;
  info: number;
  /** Services with no open critical or warning finding. */
  healthy: number;
  muted: number;
  accepted: number;
  resolved: number;
}

export interface TopItem {
  findingId: string;
  /** "acme api crashed 6 times in the last 7 days · still open, week 3" */
  line: string;
  recommendationId: string | null;
}

export type StepStatus = 'done' | 'partial' | 'skipped' | 'failed';

/** One model step of the analysis and how it went, in a sentence for the run's page. */
export interface AnalysisStep {
  key: 'service' | 'rollup' | 'brief';
  status: StepStatus;
  detail: string;
}

/** Why the rules ranked the report instead of the model. */
export type RulesReason = 'not_configured' | 'disabled' | 'budget' | 'failed';

/** What goes on the counts line of the Slack message when the rules ranked. A few words, so the message stays five lines. */
export const RULES_NOTE: Record<RulesReason, string> = {
  not_configured: 'ranked by rules (AI not configured)',
  disabled: 'ranked by rules (AI is switched off)',
  budget: 'ranked by rules (AI budget reached)',
  failed: 'ranked by rules (AI ranking failed)',
};

export const RULES_DETAIL: Record<RulesReason, string> = {
  not_configured: 'ANTHROPIC_API_KEY is not set on the worker',
  disabled: 'the model is switched off for the audit in Settings',
  budget: 'the budget for audit model calls is used up',
  failed: 'the model did not return a usable ranking',
};

export interface AnalysisInfo {
  /** Who decided the order of the findings. */
  ranking: 'model' | 'rules';
  /** Why the rules ranked: the model could not be asked, or its ranking could not be used. Null when it ranked, or had nothing to rank. */
  reason: RulesReason | null;
  steps: AnalysisStep[];
}

export interface AuditReport {
  version: 1;
  generatedAt: string;
  windowStart: string;
  windowDays: number;
  counts: AuditCounts;
  /** Open findings in report order. Muted and accepted ones are counted, not listed. */
  findings: ReportFinding[];
  top: TopItem[];
  inventory: { initial: boolean; changes: InventoryChange[] };
  coverage: CheckCoverage[];
  unread: UnreadEnvironment[];
  integrations: Record<string, FeatureStatus>;
  railwayRequests: number;
  /** Absent on reports from before the model steps existed, and while a run waits for its analysis. */
  analysis?: AnalysisInfo;
}

/** The few words added to the counts line, or null when the model ranked or there was nothing to rank. */
export const rulesNote = (report: Pick<AuditReport, 'analysis'>): string | null =>
  report.analysis?.ranking === 'rules' && report.analysis.reason ? RULES_NOTE[report.analysis.reason] : null;

export function history(finding: Pick<TrackedFinding, 'weeksOpen' | 'isNew' | 'growing'>): string {
  const parts: string[] = [];
  if (finding.weeksOpen > 1) parts.push(`still open, week ${finding.weeksOpen}`);
  else if (finding.isNew) parts.push('new');
  if (finding.growing) parts.push('growing');
  return parts.join(', ');
}

export function toReportFinding(finding: TrackedFinding, fix: FixInfo): ReportFinding {
  return {
    id: finding.id,
    subject: subject(finding.scope),
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    check: finding.check,
    projectName: finding.scope.projectName,
    environmentName: finding.scope.environmentName ?? null,
    serviceName: finding.scope.serviceName ?? null,
    cause: finding.cause,
    recommendation: finding.recommendation,
    actionType: finding.actionType,
    evidence: finding.evidence,
    weeksOpen: finding.weeksOpen,
    isNew: finding.isNew,
    growing: finding.growing,
    fix,
    ...(finding.assessment ? { ai: true } : {}),
  };
}

/**
 * A finding's line in the Slack message. The subject and the history are always put there
 * by code; `wording` is the model's line for the message when it drafted one that passed.
 */
export function topLine(finding: ReportFinding, wording?: string): string {
  const tail = history(finding);
  // "new" says nothing on a first report, where everything is new; it is kept for the UI.
  const suffix = tail && tail !== 'new' ? ` · ${tail}` : '';
  return `${finding.subject} ${wording ?? finding.title}${suffix}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function countsLine(counts: AuditCounts, note?: string | null): string {
  return `${counts.critical} critical · ${plural(counts.warning, 'warning')} · ${counts.healthy} healthy${note ? ` · ${note}` : ''}`;
}

export function titleLine(counts: AuditCounts): string {
  return `Weekly Railway audit · ${plural(counts.projects, 'project')} · ${plural(counts.services, 'service')}`;
}

const FIX_TEXT: Record<FixStatus, string> = {
  proposed: 'Fix via agent proposed in Slack',
  available: 'Fix via agent can be proposed',
  in_progress: 'A fix is already in progress',
  unavailable: 'Fix via agent unavailable',
  none: '',
};

export function fixText(fix: FixInfo): string {
  const text = FIX_TEXT[fix.status];
  return fix.reason ? `${text}: ${fix.reason}` : text;
}

/** Which checks ran and which could not, in sentences. Shared by the UI and the dry run. */
export function coverageLines(coverage: CheckCoverage[]): { ran: string[]; partly: string[]; notRun: string[] } {
  const ran: string[] = [];
  const partly: string[] = [];
  const notRun: string[] = [];
  for (const c of coverage) {
    const name = `${CATEGORIES[c.category]}: ${c.label}`;
    const reasons = Object.entries(c.reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} (${n})`)
      .join('; ');
    if (c.notChecked === 0) {
      ran.push(c.checked === 0 ? `${name}: nothing to check` : `${name}: ${c.checked} checked`);
    } else if (c.checked === 0) {
      notRun.push(`${name}: not checked. ${reasons}`);
    } else {
      partly.push(`${name}: ${c.checked} checked, ${c.notChecked} not checked. ${reasons}`);
    }
  }
  return { ran, partly, notRun };
}

/** The full report as Markdown, for the dry run. The UI renders the same data as a page. */
export function renderMarkdown(report: AuditReport, options: { maxFindings?: number } = {}): string {
  const out: string[] = [];
  const { counts } = report;
  out.push(`# ${titleLine(counts)}`, '');
  out.push(`Generated ${report.generatedAt} for the ${report.windowDays} days from ${report.windowStart.slice(0, 10)}.`, '');
  out.push(
    `${countsLine(counts)} · ${counts.info} informational${counts.muted + counts.accepted ? ` · ${counts.muted} muted · ${counts.accepted} accepted` : ''}`,
    '',
  );

  if (report.unread.length) {
    out.push('## Environments that could not be read', '');
    for (const u of report.unread) out.push(`- ${u.projectName} (${u.environmentName}): ${u.reason}`);
    out.push('');
  }

  const max = options.maxFindings ?? report.findings.length;
  if (report.analysis) {
    out.push(
      report.analysis.ranking === 'model'
        ? 'Ranked by the model on top of the rule-based checks.'
        : `Ranked by the rules${report.analysis.reason ? `: ${RULES_DETAIL[report.analysis.reason]}` : ''}.`,
      '',
    );
  }
  out.push('## Findings, ranked', '');
  if (!report.findings.length) out.push('No open findings.', '');
  report.findings.slice(0, max).forEach((f, i) => {
    const tail = history(f);
    out.push(`${i + 1}. **${f.severity}** · ${CATEGORIES[f.category]} · ${f.subject} ${f.title}${tail ? ` (${tail})` : ''}`);
    for (const e of f.evidence) out.push(`   - Evidence: ${e.quote} _(${e.source})_`);
    if (f.cause) out.push(`   - Likely cause: ${f.cause}`);
    out.push(`   - Recommended: ${f.recommendation}`);
    const fix = fixText(f.fix);
    if (fix) out.push(`   - ${fix}`);
  });
  if (report.findings.length > max) out.push('', `…and ${report.findings.length - max} more.`);
  out.push('');

  const { ran, partly, notRun } = coverageLines(report.coverage);
  out.push('## Checks that ran', '', ...ran.map((l) => `- ${l}`), '');
  if (partly.length) out.push('## Checks that ran for some services only', '', ...partly.map((l) => `- ${l}`), '');
  if (notRun.length) out.push('## Checks that could not run', '', ...notRun.map((l) => `- ${l}`), '');

  out.push('## Inventory', '');
  if (report.inventory.initial) out.push('First inventory: nothing to compare with yet.');
  else if (!report.inventory.changes.length) out.push('No projects, environments or services were added, removed or renamed.');
  for (const c of report.inventory.changes) {
    out.push(
      c.change === 'renamed'
        ? `- ${c.kind} renamed: ${c.previousName ?? '?'} is now ${c.name} (${c.projectName})`
        : `- ${c.kind} ${c.change}: ${c.name}${c.kind === 'project' ? '' : ` (${c.projectName})`}`,
    );
  }
  out.push('');
  return out.join('\n');
}
