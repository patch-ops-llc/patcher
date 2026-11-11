import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { withTx } from '../db/pool.js';
import { getSetting, isDryRun } from '../settings/settings.js';
import { SlackApiError } from '../slack/client.js';
import { clip, escapeMrkdwn, outcomeReply } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import type { ActionResult } from './catalog.js';
import { renderRecommendation, threadPrefix } from './delivery.js';
import { getRecommendation } from './service.js';
import type { ActionRecord, ActionRow } from './types.js';
import { actionFromRow } from './types.js';

export type ExecuteOutcome =
  | 'done'
  | 'failed'
  /** Paused: the action stays pending and runs after a resume. */
  | 'held'
  /** Already finished by an earlier attempt of this job. */
  | 'already_finished'
  /** Another live process is running this action right now; the job is looked at again shortly. */
  | 'busy'
  | 'not_found';

const INTERRUPTED =
  'Interrupted before the outcome was recorded. Check the target system before retrying.';

type Claim =
  | { state: 'run'; action: ActionRecord; dryRun: boolean }
  | { state: 'held' }
  | { state: 'not_found' }
  | { state: 'finished'; action: ActionRecord };

/**
 * Moves the action from `pending` to `running` under a lock, so that however many times the
 * job is delivered, the catalog entry runs at most once per approval. An action found already
 * `running` means an earlier attempt died mid-flight: it is marked failed for a person to
 * check and retry, never re-run blindly against a third party.
 */
async function claim(deps: WorkerDeps, actionId: string): Promise<Claim> {
  return withTx(deps.pool, async (tx) => {
    const ref = await tx.query<{ recommendation_id: string }>(
      'SELECT recommendation_id FROM actions WHERE id = $1',
      [actionId],
    );
    if (!ref.rows[0]) return { state: 'not_found' };
    const recId = ref.rows[0].recommendation_id;
    // Same lock order as a decision (recommendation, then action), so the two cannot deadlock.
    await tx.query('SELECT id FROM recommendations WHERE id = $1 FOR UPDATE', [recId]);
    const { rows } = await tx.query<ActionRow>('SELECT * FROM actions WHERE id = $1 FOR UPDATE', [actionId]);
    const action = actionFromRow(rows[0]!);

    if (action.status === 'pending') {
      if (await getSetting(tx, 'paused')) return { state: 'held' };
      const dryRun = await isDryRun(tx, deps.dryRunEnv);
      const updated = await tx.query<ActionRow>(
        `UPDATE actions SET status = 'running', attempts = attempts + 1, dry_run = $2, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [actionId, dryRun],
      );
      await tx.query(`UPDATE recommendations SET status = 'executing', updated_at = now() WHERE id = $1`, [recId]);
      return { state: 'run', action: actionFromRow(updated.rows[0]!), dryRun };
    }

    if (action.status === 'running') {
      const failed = await finish(tx, action, { ok: false, error: INTERRUPTED });
      return { state: 'finished', action: failed };
    }
    return { state: 'finished', action };
  });
}

type Outcome = { ok: true; result: ActionResult } | { ok: false; error: string };

async function finish(
  tx: Parameters<Parameters<typeof withTx>[1]>[0],
  action: ActionRecord,
  outcome: Outcome,
): Promise<ActionRecord> {
  const status = outcome.ok ? 'done' : 'failed';
  const error = outcome.ok ? null : clip(outcome.error, 500);
  // Same lock order as a decision and a claim: recommendation first, then action.
  await tx.query('SELECT id FROM recommendations WHERE id = $1 FOR UPDATE', [action.recommendationId]);
  const { rows } = await tx.query<ActionRow>(
    `UPDATE actions SET status = $2, external_ref = $3, last_error = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [action.id, status, outcome.ok ? (outcome.result.externalRef ?? null) : null, error],
  );
  await tx.query(`UPDATE recommendations SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [
    action.recommendationId,
    status,
    error,
  ]);
  await recordAudit(tx, {
    actor: SYSTEM_ACTOR,
    action: outcome.ok ? 'action.done' : 'action.failed',
    target: action.recommendationId,
    after: {
      actionId: action.id,
      type: action.type,
      attempt: action.attempts,
      dryRun: action.dryRun,
      ...(outcome.ok ? { externalRef: outcome.result.externalRef ?? null } : { error }),
    },
  });
  return actionFromRow(rows[0]!);
}

/** What the action wrote for a person to use, quoted under the outcome line. */
function produced(action: ActionRecord, result?: ActionResult): string {
  if (action.status !== 'done' || action.dryRun || !result?.detail) return '';
  const lines = escapeMrkdwn(result.detail.trim().slice(0, 2500)).split('\n');
  return `\n${lines.map((line) => `> ${line}`).join('\n')}`;
}

/** Edits the message to its one-line outcome and adds one thread reply. Runs once per action. */
async function report(deps: WorkerDeps, action: ActionRecord, result?: ActionResult): Promise<void> {
  if (action.reportedAt) return;
  const rec = await getRecommendation(deps.pool, action.recommendationId);
  if (rec?.slackChannel && rec.slackTs) {
    try {
      await renderRecommendation(deps, rec);
      await deps.slack.postMessage({
        channel: rec.slackChannel,
        threadTs: rec.slackTs,
        text: `${await threadPrefix(deps, rec)}${outcomeReply(action, result?.summary)}${produced(action, result)}`,
      });
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.retryable) throw err;
      deps.log.warn('could not report action outcome to slack', { actionId: action.id, code: err.code });
    }
  }
  await deps.pool.query('UPDATE actions SET reported_at = now() WHERE id = $1', [action.id]);
}

const BUSY_RECHECK_SECONDS = 30;

/**
 * Runs an approved action. A session-level advisory lock on the action is held for the whole
 * run, which is how a second delivery of the job tells "another process is still running this"
 * (lock taken: look again later) from "the process that started this died" (lock free but the
 * row says running: mark it failed for a person to check).
 */
export async function executeAction(deps: WorkerDeps, actionId: string): Promise<ExecuteOutcome> {
  const session = await deps.pool.connect();
  let locked = false;
  try {
    const lock = await session.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended('action:' || $1, 0)) AS locked`,
      [actionId],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      await deps.queue.enqueue('action.execute', { actionId }, { startAfter: BUSY_RECHECK_SECONDS });
      return 'busy';
    }
    return await runLocked(deps, actionId);
  } finally {
    if (locked) {
      await session
        .query(`SELECT pg_advisory_unlock(hashtextextended('action:' || $1, 0))`, [actionId])
        .catch(() => undefined);
    }
    session.release();
  }
}

async function runLocked(deps: WorkerDeps, actionId: string): Promise<ExecuteOutcome> {
  const claimed = await claim(deps, actionId);
  if (claimed.state === 'not_found' || claimed.state === 'held') return claimed.state;
  if (claimed.state === 'finished') {
    await report(deps, claimed.action);
    return 'already_finished';
  }

  const { action, dryRun } = claimed;
  const log = deps.log.child({ actionId, actionType: action.type, recommendationId: action.recommendationId });
  let outcome: Outcome;
  try {
    const definition = deps.catalog.action(action.type);
    const params: unknown = definition.params.parse(action.request);
    if (dryRun) {
      log.info('dry run: action not executed', { request: action.request });
      outcome = { ok: true, result: {} };
    } else {
      outcome = {
        ok: true,
        result: await definition.execute(params, {
          idempotencyKey: action.idempotencyKey,
          recommendationId: action.recommendationId,
          log,
        }),
      };
    }
  } catch (err) {
    log.warn('action failed', { err });
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const finished = await withTx(deps.pool, (tx) => finish(tx, action, outcome));
  await report(deps, finished, outcome.ok ? outcome.result : undefined);
  return outcome.ok ? 'done' : 'failed';
}
