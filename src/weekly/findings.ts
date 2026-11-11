import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Evidence } from '../recommendations/types.js';
import type { ActionType, Assessment, Category, FindingDraft, FindingScope, RuleWording, Severity } from './types.js';
import { categories } from './types.js';

export const FINDING_STATES = ['open', 'resolved', 'muted', 'accepted'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export interface Finding {
  id: string;
  fingerprint: string;
  scope: FindingScope;
  category: Category;
  check: string;
  severity: Severity;
  /**
   * The wording in use: the model's, when it assessed the finding in the last run that saw
   * it, and the rule's otherwise. `rule` always holds the rule's.
   */
  title: string;
  cause: string;
  recommendation: string;
  actionType: ActionType;
  rule: RuleWording;
  /** Set only while it applies, that is, when it was written in the finding's last run. */
  assessment: Assessment | null;
  evidence: Evidence[];
  repo: string | null;
  branch: string | null;
  metric: number | null;
  previousMetric: number | null;
  firstRun: string | null;
  lastRun: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  state: FindingState;
  stateBy: string | null;
  stateAt: Date | null;
  stateNote: string | null;
  resolvedAt: Date | null;
  recommendationId: string | null;
  prUrl: string | null;
}

/** A finding as one run saw it: how long it has been open and whether it is getting worse. */
export interface TrackedFinding extends Finding {
  weeksOpen: number;
  isNew: boolean;
  growing: boolean;
}

interface FindingRow {
  id: string;
  fingerprint: string;
  railway_project_id: string;
  environment_id: string | null;
  service_id: string | null;
  project_name: string;
  environment_name: string | null;
  service_name: string | null;
  category: Category;
  check_key: string;
  severity: Severity;
  title: string;
  cause: string;
  recommendation: string;
  action_type: ActionType;
  evidence: Evidence[];
  repo: string | null;
  branch: string | null;
  metric: number | null;
  previous_metric: number | null;
  first_run: string | null;
  last_run: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  state: FindingState;
  state_by: string | null;
  state_at: Date | null;
  state_note: string | null;
  resolved_at: Date | null;
  recommendation_id: string | null;
  pr_url: string | null;
  assessment: Assessment | null;
}

/** A model can narrow what the rule allows (no fix after all), never widen it. */
const allowedAction = (rule: ActionType, model: ActionType): ActionType =>
  model === 'fix_via_agent' && rule !== 'fix_via_agent' ? 'investigate' : model;

function fromRow(r: FindingRow): Finding {
  const rule: RuleWording = { title: r.title, cause: r.cause, recommendation: r.recommendation, actionType: r.action_type };
  const assessment = r.assessment && r.assessment.runId === r.last_run ? r.assessment : null;
  return {
    ...base(r),
    title: assessment?.headline || rule.title,
    cause: assessment ? assessment.cause : rule.cause,
    recommendation: assessment?.recommendation || rule.recommendation,
    actionType: assessment ? allowedAction(rule.actionType, assessment.action) : rule.actionType,
    rule,
    assessment,
  };
}

const base = (r: FindingRow) => ({
  id: r.id,
  fingerprint: r.fingerprint,
  scope: {
    projectId: r.railway_project_id,
    projectName: r.project_name,
    environmentId: r.environment_id ?? undefined,
    environmentName: r.environment_name ?? undefined,
    serviceId: r.service_id ?? undefined,
    serviceName: r.service_name ?? undefined,
  },
  category: r.category,
  check: r.check_key,
  severity: r.severity,
  evidence: r.evidence,
  repo: r.repo,
  branch: r.branch,
  metric: r.metric,
  previousMetric: r.previous_metric,
  firstRun: r.first_run,
  lastRun: r.last_run,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  state: r.state,
  stateBy: r.state_by,
  stateAt: r.state_at,
  stateNote: r.state_note,
  resolvedAt: r.resolved_at,
  recommendationId: r.recommendation_id,
  prUrl: r.pr_url,
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function track(finding: Finding, runId: string, now: Date): TrackedFinding {
  const isNew = finding.firstRun === runId;
  return {
    ...finding,
    weeksOpen: Math.floor(Math.max(0, now.getTime() - finding.firstSeenAt.getTime()) / WEEK_MS) + 1,
    isNew,
    growing:
      !isNew && finding.metric !== null && finding.previousMetric !== null && finding.previousMetric > 0
        ? finding.metric >= finding.previousMetric * 1.25
        : false,
  };
}

const scopeKey = (row: Pick<FindingRow, 'environment_id' | 'service_id' | 'railway_project_id'>): string =>
  row.service_id ? `${row.environment_id ?? ''}:${row.service_id}` : `project:${row.railway_project_id}`;

export interface SaveInput {
  runId: string;
  now: Date;
  drafts: FindingDraft[];
  /** `check|scope` for every place a check ran this time. */
  checkedScopes: Set<string>;
  /** Every scope that still exists in the workspace. */
  liveScopes: Set<string>;
}

/**
 * Matches this run's findings against earlier ones by fingerprint. A finding seen before
 * keeps its first-seen date and its state (a muted finding stays muted); one that was
 * resolved and has come back starts a new streak. An open finding that was not raised again
 * is resolved only where its check ran, or where the service no longer exists: "not checked"
 * never resolves anything.
 */
export async function saveFindings(tx: Queryable, input: SaveInput): Promise<{ tracked: TrackedFinding[]; resolved: number }> {
  const { runId, now } = input;
  const tracked: TrackedFinding[] = [];
  const seen = new Set<string>();

  for (const draft of input.drafts) {
    // Two checks cannot produce the same fingerprint, but a check could repeat one.
    if (seen.has(draft.fingerprint)) continue;
    seen.add(draft.fingerprint);
    const { rows } = await tx.query<FindingRow>(
      `INSERT INTO audit_findings
         (fingerprint, railway_project_id, environment_id, service_id, project_name, environment_name, service_name,
          category, check_key, severity, title, cause, recommendation, action_type, evidence, repo, branch, metric,
          first_run, last_run, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $20)
       ON CONFLICT (fingerprint) DO UPDATE SET
         project_name = EXCLUDED.project_name,
         environment_name = EXCLUDED.environment_name,
         service_name = EXCLUDED.service_name,
         severity = EXCLUDED.severity,
         title = EXCLUDED.title,
         cause = EXCLUDED.cause,
         recommendation = EXCLUDED.recommendation,
         action_type = EXCLUDED.action_type,
         evidence = EXCLUDED.evidence,
         repo = EXCLUDED.repo,
         branch = EXCLUDED.branch,
         metric = EXCLUDED.metric,
         last_run = EXCLUDED.last_run,
         last_seen_at = EXCLUDED.last_seen_at,
         first_run = CASE WHEN audit_findings.state = 'resolved' THEN EXCLUDED.first_run ELSE audit_findings.first_run END,
         first_seen_at = CASE WHEN audit_findings.state = 'resolved' THEN EXCLUDED.first_seen_at ELSE audit_findings.first_seen_at END,
         previous_metric = CASE WHEN audit_findings.state = 'resolved' THEN NULL ELSE audit_findings.metric END,
         pr_url = CASE WHEN audit_findings.state = 'resolved' THEN NULL ELSE audit_findings.pr_url END,
         resolved_at = NULL,
         state = CASE WHEN audit_findings.state = 'resolved' THEN 'open' ELSE audit_findings.state END
       RETURNING *`,
      [
        draft.fingerprint,
        draft.scope.projectId,
        draft.scope.environmentId ?? null,
        draft.scope.serviceId ?? null,
        draft.scope.projectName,
        draft.scope.environmentName ?? null,
        draft.scope.serviceName ?? null,
        draft.category,
        draft.check,
        draft.severity,
        draft.title.slice(0, 300),
        draft.cause,
        draft.recommendation,
        draft.actionType,
        JSON.stringify(draft.evidence),
        draft.repo ?? null,
        draft.branch ?? null,
        draft.metric ?? null,
        runId,
        now,
      ],
    );
    tracked.push(track(fromRow(rows[0]!), runId, now));
  }

  const stale = await tx.query<FindingRow>(
    `SELECT * FROM audit_findings WHERE state = 'open' AND (last_run IS DISTINCT FROM $1) FOR UPDATE`,
    [runId],
  );
  const resolvable = stale.rows
    .filter((row) => {
      const scope = scopeKey(row);
      return !input.liveScopes.has(scope) || input.checkedScopes.has(`${row.check_key}|${scope}`);
    })
    .map((row) => row.id);
  if (resolvable.length) {
    await tx.query(`UPDATE audit_findings SET state = 'resolved', resolved_at = $2 WHERE id = ANY($1)`, [resolvable, now]);
  }
  return { tracked, resolved: resolvable.length };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getFinding(db: Queryable, id: string): Promise<Finding | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<FindingRow>('SELECT * FROM audit_findings WHERE id = $1', [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** The given findings, whatever their state. Order is not kept. */
export async function findingsByIds(db: Queryable, ids: string[]): Promise<Finding[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<FindingRow>('SELECT * FROM audit_findings WHERE id = ANY($1)', [ids.filter((id) => UUID.test(id))]);
  return rows.map(fromRow);
}

/** Stores what the model drafted for a finding, if the run that asked is still the last to have seen it. */
export async function saveAssessment(db: Queryable, findingId: string, assessment: Assessment): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE audit_findings SET assessment = $2 WHERE id = $1 AND last_run = $3', [
    findingId,
    JSON.stringify(assessment),
    assessment.runId,
  ]);
  return Boolean(rowCount);
}

export async function listFindings(db: Queryable, states: FindingState[], limit = 500): Promise<Finding[]> {
  const { rows } = await db.query<FindingRow>(
    `SELECT * FROM audit_findings WHERE state = ANY($1) ORDER BY last_seen_at DESC LIMIT $2`,
    [states, limit],
  );
  return rank(rows.map(fromRow));
}

export class FindingStateError extends Error {}

/**
 * Mute: stop reporting this finding. Accept: the risk is known and will not be fixed. Both
 * keep the finding out of the report and its counts until someone reopens it.
 */
export async function setFindingState(
  pool: Pool,
  id: string,
  state: 'open' | 'muted' | 'accepted',
  actor: Actor,
  note = '',
): Promise<Finding> {
  return withTx(pool, async (tx) => {
    const before = UUID.test(id)
      ? await tx.query<FindingRow>('SELECT * FROM audit_findings WHERE id = $1 FOR UPDATE', [id])
      : { rows: [] as FindingRow[] };
    const row = before.rows[0];
    if (!row) throw new FindingStateError('That finding does not exist.');
    if (row.state === 'resolved') throw new FindingStateError('That finding is resolved. It reopens by itself if it comes back.');
    if (row.state === state) return fromRow(row);
    const { rows } = await tx.query<FindingRow>(
      `UPDATE audit_findings SET state = $2, state_by = $3, state_at = now(), state_note = $4 WHERE id = $1 RETURNING *`,
      [id, state, actor, note.trim().slice(0, 300) || null],
    );
    await recordAudit(tx, {
      actor,
      action: `finding.${state === 'open' ? 'reopen' : state === 'muted' ? 'mute' : 'accept'}`,
      target: id,
      before: { state: row.state },
      after: { state, note: note.trim().slice(0, 300) || undefined },
    });
    return fromRow(rows[0]!);
  });
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * The order of the report: severity first, then the category order of the design (an outage
 * before a hygiene item), production before other environments, and the larger number first.
 * Ties fall back to names, so the same input always gives the same order.
 */
export function rank<T extends Pick<Finding, 'severity' | 'category' | 'scope' | 'title' | 'check'> & { metric?: number | null | undefined }>(
  findings: T[],
): T[] {
  const production = (f: T) => (!f.scope.environmentName || f.scope.environmentName.toLowerCase() === 'production' ? 0 : 1);
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      categories.indexOf(a.category) - categories.indexOf(b.category) ||
      production(a) - production(b) ||
      a.check.localeCompare(b.check) ||
      (b.metric ?? 0) - (a.metric ?? 0) ||
      a.scope.projectName.localeCompare(b.scope.projectName) ||
      (a.scope.serviceName ?? '').localeCompare(b.scope.serviceName ?? '') ||
      a.title.localeCompare(b.title),
  );
}
