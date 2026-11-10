import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';

export const ROLES = ['viewer', 'approver', 'owner'] as const;
export type Role = (typeof ROLES)[number];

const rank: Record<Role, number> = { viewer: 1, approver: 2, owner: 3 };

export interface User {
  slackUserId: string;
  role: Role;
  /** Kinds this person may decide; null means every kind. */
  approvalKinds: string[] | null;
  displayName: string | null;
  email: string | null;
}

interface UserRow {
  slack_user_id: string;
  role: Role;
  approval_kinds: string[] | null;
  display_name: string | null;
  email: string | null;
}

const fromRow = (r: UserRow): User => ({
  slackUserId: r.slack_user_id,
  role: r.role,
  approvalKinds: r.approval_kinds,
  displayName: r.display_name,
  email: r.email,
});

const COLUMNS = 'slack_user_id, role, approval_kinds, display_name, email';

export const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;

export function hasRole(user: Pick<User, 'role'>, atLeast: Role): boolean {
  return rank[user.role] >= rank[atLeast];
}

/** The approver list of section 4: owner or approver, and allowed to decide this kind. */
export function canDecide(user: Pick<User, 'role' | 'approvalKinds'>, kind: string): boolean {
  if (!hasRole(user, 'approver')) return false;
  return user.approvalKinds === null || user.approvalKinds.includes(kind);
}

export async function getUser(db: Queryable, slackUserId: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE slack_user_id = $1`, [
    slackUserId,
  ]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listUsers(db: Queryable): Promise<User[]> {
  const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users ORDER BY created_at, slack_user_id`);
  return rows.map(fromRow);
}

export class UserChangeError extends Error {}

async function ownerCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE role = 'owner'`);
  return Number(rows[0]?.n ?? 0);
}

export async function saveUser(
  pool: Pool,
  input: { slackUserId: string; role: Role; approvalKinds: string[] | null },
  actor: Actor,
): Promise<User> {
  if (!SLACK_USER_ID_PATTERN.test(input.slackUserId)) {
    throw new UserChangeError('That is not a Slack member ID. It looks like U012ABCDEF.');
  }
  if (!ROLES.includes(input.role)) throw new UserChangeError('Unknown role.');
  return withTx(pool, async (tx) => {
    // Serialize people changes so two requests cannot both remove the last owner.
    await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const before = await getUser(tx, input.slackUserId);
    if (before?.role === 'owner' && input.role !== 'owner' && (await ownerCount(tx)) <= 1) {
      throw new UserChangeError('There must be at least one owner.');
    }
    const { rows } = await tx.query<UserRow>(
      `INSERT INTO users (slack_user_id, role, approval_kinds) VALUES ($1, $2, $3)
       ON CONFLICT (slack_user_id) DO UPDATE
         SET role = EXCLUDED.role, approval_kinds = EXCLUDED.approval_kinds, updated_at = now()
       RETURNING ${COLUMNS}`,
      [input.slackUserId, input.role, input.approvalKinds],
    );
    const after = fromRow(rows[0]!);
    await recordAudit(tx, {
      actor,
      action: before ? 'user.update' : 'user.add',
      target: input.slackUserId,
      before: before && { role: before.role, approvalKinds: before.approvalKinds },
      after: { role: after.role, approvalKinds: after.approvalKinds },
    });
    return after;
  });
}

export async function removeUser(pool: Pool, slackUserId: string, actor: Actor): Promise<void> {
  await withTx(pool, async (tx) => {
    await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const before = await getUser(tx, slackUserId);
    if (!before) return;
    if (before.role === 'owner' && (await ownerCount(tx)) <= 1) {
      throw new UserChangeError('There must be at least one owner.');
    }
    // Sessions go with the user (ON DELETE CASCADE), so access ends immediately.
    await tx.query('DELETE FROM users WHERE slack_user_id = $1', [slackUserId]);
    await recordAudit(tx, {
      actor,
      action: 'user.remove',
      target: slackUserId,
      before: { role: before.role, approvalKinds: before.approvalKinds },
    });
  });
}

/**
 * The first owner is named by an environment variable. This only ever adds that person when
 * they are absent; it never restores a role someone has since changed in the UI.
 */
export async function ensureBootstrapOwner(pool: Pool, slackUserId: string): Promise<boolean> {
  return withTx(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO users (slack_user_id, role) VALUES ($1, 'owner') ON CONFLICT (slack_user_id) DO NOTHING`,
      [slackUserId],
    );
    if (!rowCount) return false;
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'user.bootstrap_owner',
      target: slackUserId,
      after: { role: 'owner' },
    });
    return true;
  });
}

/** Keeps the name shown in the UI fresh from what Slack tells us at sign-in or on a click. */
export async function touchProfile(
  db: Queryable,
  slackUserId: string,
  profile: { displayName?: string | null; email?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE users
        SET display_name = COALESCE($2, display_name), email = COALESCE($3, email)
      WHERE slack_user_id = $1
        AND (display_name IS DISTINCT FROM COALESCE($2, display_name) OR email IS DISTINCT FROM COALESCE($3, email))`,
    [slackUserId, profile.displayName ?? null, profile.email ?? null],
  );
}
