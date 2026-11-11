import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, PoolClient, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Enqueuer } from '../queue/queue.js';
import type { ReportType } from '../settings/routes.js';
import { getSetting } from '../settings/settings.js';
import { canDecide, getUser } from '../settings/users.js';
import type { Catalog, ProposedAction } from './catalog.js';
import { CatalogError } from './catalog.js';
import { actionHash, hashesMatch } from './hash.js';
import type {
  ActionRecord,
  ActionRow,
  ApprovalRecord,
  Evidence,
  Recommendation,
  RecommendationRow,
  RecommendationStatus,
  Risk,
} from './types.js';
import { actionFromRow, bodySchema, evidenceSchema, recommendationFromRow, titleSchema } from './types.js';

export interface LoopDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
}

export interface NewRecommendation {
  kind: string;
  /** Channel route to post to. Defaults to the kind's own. */
  reportType?: ReportType;
  /** What produced it, for example `transcript` or `audit_finding`, and that thing's id. */
  sourceType: string;
  sourceId?: string;
  title: string;
  body?: string;
  evidence: Evidence[];
  action: ProposedAction;
  risk?: Risk;
  /** A second recommendation with the same key is not created. */
  dedupeKey?: string;
  /**
   * A shared Slack message that shows this recommendation as one of its lines, with its own
   * approve button. The carrier posts and edits that message; the recommendation is decided,
   * executed and logged like any other.
   */
  carrier?: { type: string; id: string };
  createdBy?: Actor;
}

export class RecommendationInputError extends Error {}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'invalid';
}

function validateContent(
  catalog: Catalog,
  input: { title: string; body: string; action: ProposedAction },
): { title: string; body: string; action: ProposedAction } {
  const title = titleSchema.safeParse(input.title);
  if (!title.success) throw new RecommendationInputError(`Title: ${firstIssue(title.error)}`);
  const body = bodySchema.safeParse(input.body);
  if (!body.success) throw new RecommendationInputError(`Body: ${firstIssue(body.error)}`);
  try {
    return { title: title.data, body: body.data, action: catalog.validate(input.action) };
  } catch (err) {
    if (err instanceof CatalogError) throw new RecommendationInputError(err.message);
    throw err;
  }
}

/**
 * The single way a recommendation enters the loop. Every later phase calls this with its own
 * kind and catalog action; posting, approval, execution and logging are shared from here on.
 */
export async function createRecommendation(
  deps: LoopDeps,
  input: NewRecommendation,
): Promise<{ recommendation: Recommendation; created: boolean }> {
  let kind;
  try {
    kind = deps.catalog.kind(input.kind);
  } catch (err) {
    throw new RecommendationInputError((err as Error).message);
  }
  const evidence = z.array(evidenceSchema).min(1).max(20).safeParse(input.evidence);
  if (!evidence.success) {
    throw new RecommendationInputError('A recommendation needs at least one quote with its source.');
  }
  const content = validateContent(deps.catalog, {
    title: input.title,
    body: input.body ?? '',
    action: input.action,
  });
  const hash = actionHash(content);
  const actor = input.createdBy ?? SYSTEM_ACTOR;

  return withTx(deps.pool, async (tx) => {
    const { rows } = await tx.query<RecommendationRow>(
      `INSERT INTO recommendations
         (kind, report_type, source_type, source_id, title, body, evidence, proposed_action, action_hash, risk, dedupe_key,
          carrier_type, carrier_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [
        kind.kind,
        input.reportType ?? kind.defaultReportType,
        input.sourceType,
        input.sourceId ?? null,
        content.title,
        content.body,
        JSON.stringify(evidence.data),
        JSON.stringify(content.action),
        hash,
        input.risk ?? 'low',
        input.dedupeKey ?? null,
        input.carrier?.type ?? null,
        input.carrier?.id ?? null,
      ],
    );
    if (!rows[0]) {
      const existing = await tx.query<RecommendationRow>('SELECT * FROM recommendations WHERE dedupe_key = $1', [
        input.dedupeKey,
      ]);
      return { recommendation: recommendationFromRow(existing.rows[0]!), created: false };
    }
    const recommendation = recommendationFromRow(rows[0]);
    await recordAudit(tx, {
      actor,
      action: 'recommendation.create',
      target: recommendation.id,
      after: { kind: recommendation.kind, title: recommendation.title, actionHash: hash },
    });
    // A carried recommendation is posted by its carrier, once the shared message is ready.
    if (!input.carrier) {
      await deps.queue.enqueue('recommendation.post', { recommendationId: recommendation.id }, { tx });
    }
    return { recommendation, created: true };
  });
}

export type RefusalReason =
  /** No such recommendation. */
  | 'not_found'
  /** The person is not on the approver list, or may not decide this kind. */
  | 'forbidden'
  /** It was already decided, expired, or has not been posted. */
  | 'not_pending'
  /** The button or form was for an earlier version of the content. */
  | 'stale'
  /** The global pause is on, and approving would run an action. */
  | 'paused'
  /** The edited content does not validate. */
  | 'invalid';

export type DecisionResult =
  | { ok: true; recommendation: Recommendation; changed: boolean }
  | { ok: false; reason: RefusalReason; message: string; recommendation?: Recommendation };

export interface DecisionInput {
  id: string;
  /** The hash the approver was shown. */
  hash: string;
  actor: Actor;
  via: 'slack' | 'ui';
}

const refusal = (reason: RefusalReason, message: string, recommendation?: Recommendation): DecisionResult => ({
  ok: false,
  reason,
  message,
  ...(recommendation ? { recommendation } : {}),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeState(rec: Recommendation): string {
  switch (rec.status) {
    case 'drafted':
      return 'This has not been posted yet.';
    case 'expired':
      return 'This expired without a decision.';
    case 'dismissed':
      return `Already dismissed${rec.decidedBy ? ` by <@${rec.decidedBy}>` : ''}.`;
    case 'posted':
      return 'This is still waiting for a decision.';
    default:
      return `Already approved${rec.decidedBy ? ` by <@${rec.decidedBy}>` : ''}.`;
  }
}

/**
 * Locks the row and runs the checks every decision shares: it exists, the person may decide
 * this kind, it is in the expected state, and the hash is the one stored. The row lock is
 * what makes a double click or two approvers resolve to exactly one decision.
 */
async function lockForDecision(
  tx: PoolClient,
  input: DecisionInput,
  expected: RecommendationStatus,
): Promise<{ rec: Recommendation } | { refused: DecisionResult }> {
  if (!UUID.test(input.id)) return { refused: refusal('not_found', 'That recommendation no longer exists.') };
  const { rows } = await tx.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = $1 FOR UPDATE', [
    input.id,
  ]);
  if (!rows[0]) return { refused: refusal('not_found', 'That recommendation no longer exists.') };
  const rec = recommendationFromRow(rows[0]);

  const user = await getUser(tx, input.actor);
  if (!user || !canDecide(user, rec.kind)) {
    return { refused: refusal('forbidden', 'You are not on the approver list for this.', rec) };
  }
  if (rec.status !== expected) return { refused: refusal('not_pending', describeState(rec), rec) };
  if (!hashesMatch(rec.actionHash, input.hash)) {
    return { refused: refusal('stale', 'This was edited after you opened it. Check the current version.', rec) };
  }
  return { rec };
}

async function insertApproval(
  tx: PoolClient,
  rec: Recommendation,
  decision: ApprovalRecord['decision'],
  input: DecisionInput,
  editedPayload?: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO approvals (recommendation_id, decision, actor, via, version, action_hash, edited_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      rec.id,
      decision,
      input.actor,
      input.via,
      rec.version,
      rec.actionHash,
      editedPayload === undefined ? null : JSON.stringify(editedPayload),
    ],
  );
}

const PAUSED_MESSAGE = 'Patcher is paused, so nothing can be approved. Resume it first.';

export async function decide(
  deps: LoopDeps,
  input: DecisionInput & { decision: 'approve' | 'dismiss' },
): Promise<DecisionResult> {
  return withTx(deps.pool, async (tx) => {
    const locked = await lockForDecision(tx, input, 'posted');
    if ('refused' in locked) return locked.refused;
    const { rec } = locked;

    if (input.decision === 'approve' && (await getSetting(tx, 'paused'))) {
      return refusal('paused', PAUSED_MESSAGE, rec);
    }

    const status: RecommendationStatus = input.decision === 'approve' ? 'approved' : 'dismissed';
    const { rows } = await tx.query<RecommendationRow>(
      `UPDATE recommendations
          SET status = $2, decided_at = now(), decided_by = $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [rec.id, status, input.actor],
    );
    await insertApproval(tx, rec, input.decision === 'approve' ? 'approved' : 'dismissed', input);
    await recordAudit(tx, {
      actor: input.actor,
      action: input.decision === 'approve' ? 'recommendation.approve' : 'recommendation.dismiss',
      target: rec.id,
      before: { status: rec.status },
      after: { status, via: input.via, version: rec.version, actionHash: rec.actionHash },
    });

    if (input.decision === 'approve') {
      const action = await tx.query<{ id: string }>(
        `INSERT INTO actions (recommendation_id, type, request, idempotency_key)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [rec.id, rec.action.type, JSON.stringify(rec.action.params), `rec:${rec.id}:v${rec.version}`],
      );
      await deps.queue.enqueue('action.execute', { actionId: action.rows[0]!.id }, { tx });
    }
    await deps.queue.enqueue('recommendation.sync', { recommendationId: rec.id }, { tx });
    return { ok: true, recommendation: recommendationFromRow(rows[0]!), changed: true };
  });
}

export interface EditInput extends DecisionInput {
  title: string;
  body: string;
  /** New parameters for the same catalog action. The action type cannot be changed by an edit. */
  params: unknown;
}

/** An edit makes a new version with a new hash; buttons for the old version stop working. */
export async function editRecommendation(deps: LoopDeps, input: EditInput): Promise<DecisionResult> {
  return withTx(deps.pool, async (tx) => {
    const locked = await lockForDecision(tx, input, 'posted');
    if ('refused' in locked) return locked.refused;
    const { rec } = locked;

    let content;
    try {
      content = validateContent(deps.catalog, {
        title: input.title,
        body: input.body,
        action: { type: rec.action.type, params: input.params },
      });
    } catch (err) {
      if (err instanceof RecommendationInputError) return refusal('invalid', err.message, rec);
      throw err;
    }
    const hash = actionHash(content);
    if (hash === rec.actionHash) return { ok: true, recommendation: rec, changed: false };

    const expireHours = await getSetting(tx, 'approvals.expire_hours');
    const { rows } = await tx.query<RecommendationRow>(
      `UPDATE recommendations
          SET title = $2, body = $3, proposed_action = $4, action_hash = $5, version = version + 1,
              expires_at = now() + make_interval(hours => $6), reminded_at = NULL, details_ts = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [rec.id, content.title, content.body, JSON.stringify(content.action), hash, expireHours],
    );
    const updated = recommendationFromRow(rows[0]!);
    await insertApproval(tx, updated, 'edited', input, content);
    await recordAudit(tx, {
      actor: input.actor,
      action: 'recommendation.edit',
      target: rec.id,
      before: { version: rec.version, title: rec.title, body: rec.body, action: rec.action, actionHash: rec.actionHash },
      after: { version: updated.version, ...content, actionHash: hash, via: input.via },
    });
    await deps.queue.enqueue('recommendation.sync', { recommendationId: rec.id }, { tx });
    return { ok: true, recommendation: updated, changed: true };
  });
}

/** Runs a failed action again. Failures are never retried against a third party on their own. */
export async function retryRecommendation(deps: LoopDeps, input: DecisionInput): Promise<DecisionResult> {
  return withTx(deps.pool, async (tx) => {
    const locked = await lockForDecision(tx, input, 'failed');
    if ('refused' in locked) return locked.refused;
    const { rec } = locked;
    if (await getSetting(tx, 'paused')) return refusal('paused', PAUSED_MESSAGE, rec);

    const action = await tx.query<{ id: string }>(
      `UPDATE actions SET status = 'pending', reported_at = NULL, updated_at = now()
        WHERE idempotency_key = $1 AND status = 'failed'
        RETURNING id`,
      [`rec:${rec.id}:v${rec.version}`],
    );
    if (!action.rows[0]) return refusal('not_pending', 'There is no failed action to retry.', rec);

    const { rows } = await tx.query<RecommendationRow>(
      `UPDATE recommendations SET status = 'approved', last_error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [rec.id],
    );
    await insertApproval(tx, rec, 'retried', input);
    await recordAudit(tx, {
      actor: input.actor,
      action: 'recommendation.retry',
      target: rec.id,
      before: { status: 'failed' },
      after: { status: 'approved', via: input.via },
    });
    await deps.queue.enqueue('action.execute', { actionId: action.rows[0].id }, { tx });
    await deps.queue.enqueue('recommendation.sync', { recommendationId: rec.id }, { tx });
    return { ok: true, recommendation: recommendationFromRow(rows[0]!), changed: true };
  });
}

// Reads ----------------------------------------------------------------------------------

export async function getRecommendation(db: Queryable, id: string): Promise<Recommendation | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<RecommendationRow>('SELECT * FROM recommendations WHERE id = $1', [id]);
  return rows[0] ? recommendationFromRow(rows[0]) : null;
}

export async function listRecommendations(
  db: Queryable,
  statuses: RecommendationStatus[],
  limit = 50,
): Promise<Recommendation[]> {
  const { rows } = await db.query<RecommendationRow>(
    `SELECT * FROM recommendations WHERE status = ANY($1) ORDER BY created_at DESC LIMIT $2`,
    [statuses, limit],
  );
  return rows.map(recommendationFromRow);
}

export async function countByStatus(db: Queryable): Promise<Record<RecommendationStatus, number>> {
  const { rows } = await db.query<{ status: RecommendationStatus; n: string }>(
    'SELECT status, count(*) AS n FROM recommendations GROUP BY status',
  );
  const out = {
    drafted: 0,
    posted: 0,
    approved: 0,
    executing: 0,
    done: 0,
    failed: 0,
    dismissed: 0,
    expired: 0,
  };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function listApprovals(db: Queryable, recommendationId: string): Promise<ApprovalRecord[]> {
  const { rows } = await db.query<ApprovalRecord>(
    'SELECT decision, actor, via, version, at FROM approvals WHERE recommendation_id = $1 ORDER BY id',
    [recommendationId],
  );
  return rows;
}

export async function listActions(db: Queryable, recommendationId: string): Promise<ActionRecord[]> {
  const { rows } = await db.query<ActionRow>(
    'SELECT * FROM actions WHERE recommendation_id = $1 ORDER BY created_at',
    [recommendationId],
  );
  return rows.map(actionFromRow);
}
