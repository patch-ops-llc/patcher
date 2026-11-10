import type { Queryable } from '../db/pool.js';

/** Who did something: a Slack user id, or `system` for the worker itself. */
export type Actor = string;
export const SYSTEM_ACTOR: Actor = 'system';

export interface AuditEntry {
  actor: Actor;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  at: Date;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Call inside the same transaction as the change it records. */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, target, before, after) VALUES ($1, $2, $3, $4, $5)`,
    [entry.actor, entry.action, entry.target ?? null, json(entry.before), json(entry.after)],
  );
}

export async function listAudit(db: Queryable, limit = 100, beforeId?: string): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id, actor, action, target, before, after, at
       FROM audit_log
      WHERE ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC
      LIMIT $1`,
    [limit, beforeId ?? null],
  );
  return rows;
}
