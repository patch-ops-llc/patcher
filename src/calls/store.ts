import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Queryable } from '../db/pool.js';
import type { Recommendation, RecommendationRow } from '../recommendations/types.js';
import { recommendationFromRow } from '../recommendations/types.js';
import type { Call, CallMatch, CallRow, CallStatus, CallSuggestion, StoredTranscript, SuggestionRow, TranscriptRow } from './types.js';
import { callFromRow, suggestionFromRow, transcriptFromRow } from './types.js';

/** The carrier type of a call's Slack message, on every recommendation made from the call. */
export const CALL_CARRIER = 'call';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export async function getCall(db: Queryable, id: string): Promise<Call | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<CallRow>('SELECT * FROM calls WHERE id = $1', [id]);
  return rows[0] ? callFromRow(rows[0]) : null;
}

export interface CallListItem extends Call {
  projects: string[];
  sources: string[];
  suggestions: number;
  pending: number;
}

export type CallFilter = 'all' | 'unmatched' | 'needs_answer' | 'waiting';

const FILTERS: Record<CallFilter, CallStatus[] | null> = {
  all: null,
  unmatched: ['unmatched'],
  needs_answer: ['needs_project'],
  waiting: ['received', 'analyzing', 'held', 'failed'],
};

export async function listCalls(db: Queryable, filter: CallFilter = 'all', limit = 100): Promise<CallListItem[]> {
  const statuses = FILTERS[filter];
  const { rows } = await db.query<CallRow & { projects: string[] | null; sources: string[] | null; suggestions: string; pending: string }>(
    `SELECT c.*,
            (SELECT array_agg(p.name ORDER BY a.match_conf DESC)
               FROM call_analyses a JOIN projects p ON p.id = a.project_id
              WHERE a.call_id = c.id AND a.state = 'matched') AS projects,
            (SELECT array_agg(DISTINCT t.source) FROM transcripts t WHERE t.call_id = c.id) AS sources,
            (SELECT count(*) FROM call_suggestions s WHERE s.call_id = c.id AND s.version = c.version) AS suggestions,
            (SELECT count(*) FROM recommendations r
              WHERE r.carrier_type = '${CALL_CARRIER}' AND r.carrier_id = c.id::text AND r.status = 'posted') AS pending
       FROM calls c
      WHERE ($1::text[] IS NULL OR c.status = ANY($1))
      ORDER BY coalesce(c.started_at, c.created_at) DESC
      LIMIT $2`,
    [statuses, limit],
  );
  return rows.map((r) => ({
    ...callFromRow(r),
    projects: r.projects ?? [],
    sources: r.sources ?? [],
    suggestions: Number(r.suggestions),
    pending: Number(r.pending),
  }));
}

export async function countCalls(db: Queryable): Promise<Record<CallFilter, number>> {
  const { rows } = await db.query<{ status: CallStatus; n: string }>('SELECT status, count(*) AS n FROM calls GROUP BY status');
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const sum = (statuses: CallStatus[] | null): number =>
    statuses ? statuses.reduce((n, s) => n + (by.get(s) ?? 0), 0) : [...by.values()].reduce((n, v) => n + v, 0);
  return { all: sum(FILTERS.all), unmatched: sum(FILTERS.unmatched), needs_answer: sum(FILTERS.needs_answer), waiting: sum(FILTERS.waiting) };
}

export async function listTranscripts(db: Queryable, callId: string): Promise<StoredTranscript[]> {
  const { rows } = await db.query<TranscriptRow>('SELECT * FROM transcripts WHERE call_id = $1 ORDER BY is_preferred DESC, created_at', [callId]);
  return rows.map(transcriptFromRow);
}

/** The copy that is analysed. Null when every copy's text has been purged. */
export async function preferredTranscript(db: Queryable, callId: string): Promise<StoredTranscript | null> {
  const { rows } = await db.query<TranscriptRow>(
    `SELECT * FROM transcripts WHERE call_id = $1 AND text IS NOT NULL ORDER BY is_preferred DESC, length(text) DESC LIMIT 1`,
    [callId],
  );
  return rows[0] ? transcriptFromRow(rows[0]) : null;
}

export async function listMatches(db: Queryable, callId: string): Promise<CallMatch[]> {
  const { rows } = await db.query<{
    project_id: string;
    name: string;
    match_conf: string;
    state: CallMatch['state'];
    source: CallMatch['source'];
    decided_by: string | null;
    evidence: CallMatch['evidence'];
  }>(
    `SELECT a.project_id, p.name, a.match_conf, a.state, a.source, a.decided_by, a.evidence
       FROM call_analyses a JOIN projects p ON p.id = a.project_id
      WHERE a.call_id = $1
      ORDER BY (a.state = 'matched') DESC, a.match_conf DESC, p.name`,
    [callId],
  );
  return rows.map((r) => ({
    projectId: r.project_id,
    projectName: r.name,
    confidence: Number(r.match_conf),
    state: r.state,
    source: r.source,
    decidedBy: r.decided_by,
    evidence: r.evidence,
  }));
}

/** Suggestions of the call's current version, in the order they are numbered. */
export async function listSuggestions(db: Queryable, callId: string, version?: number): Promise<CallSuggestion[]> {
  const { rows } = await db.query<SuggestionRow>(
    `SELECT s.* FROM call_suggestions s JOIN calls c ON c.id = s.call_id
      WHERE s.call_id = $1 AND s.version = coalesce($2, c.version)
      ORDER BY s.position`,
    [callId, version ?? null],
  );
  return rows.map(suggestionFromRow);
}

/** The recommendations a call's message carries, for its current version. */
export async function carriedRecommendations(db: Queryable, callId: string): Promise<Recommendation[]> {
  const { rows } = await db.query<RecommendationRow>(
    `SELECT r.* FROM recommendations r
       JOIN call_suggestions s ON s.recommendation_id = r.id
       JOIN calls c ON c.id = s.call_id AND c.version = s.version
      WHERE r.carrier_type = $1 AND r.carrier_id = $2
      ORDER BY s.position`,
    [CALL_CARRIER, callId],
  );
  return rows.map(recommendationFromRow);
}

/**
 * Closes what a call still has waiting for a decision, when the call is moved to another
 * project or its recording is deleted. What was already approved stays as it is. The caller
 * redraws the call's message, once.
 */
export async function closeCallRecommendations(
  tx: Queryable,
  callId: string,
  options: { reason: string; actor: Actor; blankEvidence?: boolean },
): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE recommendations
        SET status = 'expired', last_error = $3, updated_at = now()
            ${options.blankEvidence ? `, evidence = '[{"quote": "[removed]", "source": "The recording was deleted at its source"}]'::jsonb` : ''}
      WHERE carrier_type = $1 AND carrier_id = $2 AND status IN ('drafted', 'posted')
      RETURNING id`,
    [CALL_CARRIER, callId, options.reason],
  );
  for (const rec of rows) {
    await recordAudit(tx, {
      actor: options.actor,
      action: 'recommendation.expire',
      target: rec.id,
      after: { status: 'expired', reason: options.reason },
    });
  }
  return rows.length;
}

export interface ProjectTask {
  id: string;
  projectId: string;
  kind: 'task' | 'followup';
  title: string;
  body: string;
  callId: string | null;
  recommendationId: string | null;
  status: 'open' | 'done';
  doneBy: string | null;
  doneAt: Date | null;
  createdAt: Date;
}

interface ProjectTaskRow {
  id: string;
  project_id: string;
  kind: ProjectTask['kind'];
  title: string;
  body: string;
  call_id: string | null;
  recommendation_id: string | null;
  status: ProjectTask['status'];
  done_by: string | null;
  done_at: Date | null;
  created_at: Date;
}

export async function listProjectTasks(db: Queryable, projectId: string, limit = 50): Promise<ProjectTask[]> {
  if (!UUID.test(projectId)) return [];
  const { rows } = await db.query<ProjectTaskRow>(
    `SELECT * FROM project_tasks WHERE project_id = $1 ORDER BY (status = 'open') DESC, created_at DESC LIMIT $2`,
    [projectId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    callId: r.call_id,
    recommendationId: r.recommendation_id,
    status: r.status,
    doneBy: r.done_by,
    doneAt: r.done_at,
    createdAt: r.created_at,
  }));
}

export async function setTaskDone(db: Queryable, projectId: string, taskId: string, done: boolean, actor: Actor): Promise<boolean> {
  if (!UUID.test(taskId) || !UUID.test(projectId)) return false;
  const { rowCount } = await db.query(
    `UPDATE project_tasks SET status = $3, done_by = $4, done_at = CASE WHEN $3 = 'done' THEN now() END
      WHERE id = $1 AND project_id = $2 AND status <> $3`,
    [taskId, projectId, done ? 'done' : 'open', done ? actor : null],
  );
  if (rowCount) await recordAudit(db, { actor, action: done ? 'project.task.done' : 'project.task.reopen', target: projectId, after: { taskId } });
  return Boolean(rowCount);
}
