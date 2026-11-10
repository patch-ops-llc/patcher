import { recordAudit } from '../audit/auditLog.js';
import type { Pool } from '../db/pool.js';
import type { SlackIdentity } from '../slack/oidc.js';
import type { User } from '../settings/users.js';
import { ensureBootstrapOwner, getUser, touchProfile } from '../settings/users.js';

export type LoginDecision =
  | { ok: true; user: User }
  | { ok: false; reason: 'wrong_workspace' | 'not_on_allowlist' };

/**
 * Design section 9.1: a login is accepted only if the team is the hub workspace and the
 * Slack user is on the allowlist. Both outcomes are written to the audit log.
 */
export async function authorizeLogin(
  pool: Pool,
  identity: SlackIdentity,
  rules: { hubTeamId: string; bootstrapOwner: string | undefined },
): Promise<LoginDecision> {
  const deny = async (reason: 'wrong_workspace' | 'not_on_allowlist'): Promise<LoginDecision> => {
    await recordAudit(pool, {
      actor: identity.userId,
      action: 'auth.login_denied',
      target: identity.userId,
      after: { reason, teamId: identity.teamId },
    });
    return { ok: false, reason };
  };

  if (identity.teamId !== rules.hubTeamId) return deny('wrong_workspace');
  if (rules.bootstrapOwner && identity.userId === rules.bootstrapOwner) {
    await ensureBootstrapOwner(pool, identity.userId);
  }
  if (!(await getUser(pool, identity.userId))) return deny('not_on_allowlist');

  await touchProfile(pool, identity.userId, { displayName: identity.name, email: identity.email });
  const user = (await getUser(pool, identity.userId))!;
  await recordAudit(pool, { actor: user.slackUserId, action: 'auth.login', target: user.slackUserId });
  return { ok: true, user };
}
