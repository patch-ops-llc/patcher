import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../src/audit/auditLog.js';
import {
  RouteValidationError,
  getRoute,
  listChannels,
  listRoutes,
  replaceChannels,
  reportTypes,
  setRoute,
} from '../src/settings/routes.js';
import {
  DEFAULT_PROPOSAL_TEMPLATE,
  SettingValidationError,
  getAllSettings,
  getSetting,
  isDryRun,
  isPaused,
  setSetting,
} from '../src/settings/settings.js';
import {
  UserChangeError,
  canDecide,
  ensureBootstrapOwner,
  getUser,
  hasRole,
  listUsers,
  removeUser,
  saveUser,
} from '../src/settings/users.js';
import { HUB, OWNER, auditActions, resetDb, testPool } from './helpers.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('settings', () => {
  it('returns defaults until a value is saved', async () => {
    expect(await getAllSettings(pool)).toEqual({
      paused: false,
      dry_run: false,
      'approvals.expire_hours': 72,
      'approvals.reminder_hours': 24,
      'slack.max_posts_per_hour': 6,
      'audit.agent_timeout_minutes': 180,
      'ai.audit.enabled': true,
      'ai.audit.model_service': 'claude-sonnet-5-5',
      'ai.audit.model_rollup': 'claude-sonnet-5-5',
      'ai.audit.model_brief': 'claude-sonnet-5-5',
      'ai.audit.daily_budget_usd': 0,
      'ai.audit.monthly_budget_usd': 0,
      'ai.audit.log_token_cap': 4000,
      'ai.audit.wait_minutes': 120,
      'calls.enabled': true,
      'calls.settle_minutes': 10,
      'calls.preferred_copy': 'speakers',
      'calls.retention_days': 180,
      'calls.internal_domains': '',
      'ai.calls.enabled': true,
      'ai.calls.model_match': 'claude-sonnet-5-5',
      'ai.calls.model_suggest': 'claude-sonnet-5-5',
      'ai.calls.model_brief': 'claude-sonnet-5-5',
      'ai.calls.auto_match_confidence': 0.8,
      'ai.calls.ask_confidence': 0.5,
      'ai.calls.max_suggestions': 5,
      'ai.calls.daily_budget_usd': 0,
      'ai.calls.monthly_budget_usd': 0,
      'ai.calls.transcript_token_cap': 40000,
      'sales.enabled': true,
      'sales.penguin_emails': '',
      'sales.title_patterns': 'intro, discovery, proposal, demo, scoping',
      'sales.dealroom_repo': 'patch-ops-llc/penguin-dealroom',
      'sales.dealroom_route': 'pull_request',
      'sales.dealroom_url': '',
      'sales.dealroom_publish': false,
      'sales.currency': 'USD',
      'sales.proposal_template': DEFAULT_PROPOSAL_TEMPLATE,
      'ai.sales.enabled': true,
      'ai.sales.model_classify': 'claude-sonnet-5-5',
      'ai.sales.model_brief': 'claude-sonnet-5-5',
      'ai.sales.model_draft': 'claude-opus-5-5',
      'ai.sales.model_check': 'claude-sonnet-5-5',
      'ai.sales.auto_confidence': 0.8,
      'ai.sales.ask_confidence': 0.5,
      'ai.sales.daily_budget_usd': 0,
      'ai.sales.monthly_budget_usd': 0,
      'inbox.enabled': false,
      'inbox.settle_seconds': 180,
      'inbox.digest_only': false,
      'inbox.quiet_hours': '19:00-07:00',
      'inbox.quiet_tz': 'America/Chicago',
      'inbox.unanalysed_after_minutes': 30,
      'inbox.retention_days': 14,
      'inbox.agent_enabled': true,
      'inbox.email_address': '',
      'inbox.email_senders': '@slack.com, @slack-mail.com',
      'ai.inbox.enabled': true,
      'ai.inbox.model_triage': 'claude-haiku-5-5',
      'ai.inbox.model_recommend': 'claude-sonnet-5-5',
      'ai.inbox.daily_budget_usd': 5,
      'ai.inbox.monthly_budget_usd': 60,
    });
  });

  it('saves a value and writes the change, with before and after, to the audit log', async () => {
    expect(await setSetting(pool, 'approvals.expire_hours', 48, OWNER)).toEqual({ changed: true, value: 48 });
    expect(await getSetting(pool, 'approvals.expire_hours')).toBe(48);
    const [entry] = await listAudit(pool, 10);
    expect(entry).toMatchObject({ actor: OWNER, action: 'setting.update', target: 'approvals.expire_hours', before: 72, after: 48 });
  });

  it('does not log a save that changes nothing', async () => {
    expect((await setSetting(pool, 'dry_run', false, OWNER)).changed).toBe(false);
    expect(await auditActions(pool)).toEqual([]);
  });

  it('rejects values outside the allowed range or of the wrong type', async () => {
    await expect(setSetting(pool, 'approvals.expire_hours', 0, OWNER)).rejects.toThrow(SettingValidationError);
    await expect(setSetting(pool, 'slack.max_posts_per_hour', 1.5, OWNER)).rejects.toThrow(SettingValidationError);
    await expect(setSetting(pool, 'paused', 'yes', OWNER)).rejects.toThrow(SettingValidationError);
    expect(await getSetting(pool, 'approvals.expire_hours')).toBe(72);
  });

  it('falls back to the default if a stored value is no longer valid', async () => {
    await pool.query(`INSERT INTO settings (key, value) VALUES ('approvals.expire_hours', '"soon"')`);
    expect(await getSetting(pool, 'approvals.expire_hours')).toBe(72);
  });

  it('reads the pause and dry-run switches', async () => {
    expect(await isPaused(pool)).toBe(false);
    await setSetting(pool, 'paused', true, OWNER);
    expect(await isPaused(pool)).toBe(true);

    expect(await isDryRun(pool, false)).toBe(false);
    // The environment variable forces dry run on whatever the switch says.
    expect(await isDryRun(pool, true)).toBe(true);
    await setSetting(pool, 'dry_run', true, OWNER);
    expect(await isDryRun(pool, false)).toBe(true);
  });
});

describe('channel routing', () => {
  it('has a route slot for each report type the design names', () => {
    expect(reportTypes).toEqual(['calls', 'sales', 'audit', 'inbox', 'errors']);
  });

  it('sets, changes and clears a route, logging each change', async () => {
    expect(await getRoute(pool, 'calls')).toBeNull();
    await setRoute(pool, { reportType: 'calls', teamId: HUB, channelId: 'C0CALLS' }, OWNER);
    expect(await getRoute(pool, 'calls')).toMatchObject({ teamId: HUB, channelId: 'C0CALLS' });

    await setRoute(pool, { reportType: 'calls', teamId: HUB, channelId: 'C0OTHER' }, OWNER);
    expect((await listRoutes(pool)).get('calls')!.channelId).toBe('C0OTHER');
    expect((await setRoute(pool, { reportType: 'calls', teamId: HUB, channelId: 'C0OTHER' }, OWNER)).changed).toBe(false);

    await setRoute(pool, { reportType: 'calls', teamId: HUB, channelId: null }, OWNER);
    expect(await getRoute(pool, 'calls')).toBeNull();

    const audit = (await listAudit(pool, 10)).reverse();
    expect(audit.map((a) => [a.action, a.before, a.after])).toEqual([
      ['route.update', null, { channelId: 'C0CALLS' }],
      ['route.update', { channelId: 'C0CALLS' }, { channelId: 'C0OTHER' }],
      ['route.update', { channelId: 'C0OTHER' }, null],
    ]);
  });

  it('rejects something that is not a channel ID', async () => {
    await expect(setRoute(pool, { reportType: 'calls', teamId: HUB, channelId: '#ops-calls' }, OWNER)).rejects.toThrow(
      RouteValidationError,
    );
  });

  it('replaces the cached channel list for the picker', async () => {
    await replaceChannels(pool, HUB, [
      { channelId: 'C1', name: 'ops-log', isPrivate: false, isMember: true },
      { channelId: 'C2', name: 'general', isPrivate: false, isMember: false },
    ]);
    await replaceChannels(pool, HUB, [{ channelId: 'C3', name: 'ops-calls', isPrivate: true, isMember: true }]);
    expect(await listChannels(pool, HUB)).toEqual([{ channelId: 'C3', name: 'ops-calls', isPrivate: true, isMember: true }]);
  });
});

describe('people and roles', () => {
  it('orders roles viewer < approver < owner', () => {
    expect(hasRole({ role: 'owner' }, 'approver')).toBe(true);
    expect(hasRole({ role: 'approver' }, 'approver')).toBe(true);
    expect(hasRole({ role: 'approver' }, 'owner')).toBe(false);
    expect(hasRole({ role: 'viewer' }, 'approver')).toBe(false);
  });

  it('lets approvers decide all kinds, or only the kinds listed for them', () => {
    expect(canDecide({ role: 'approver', approvalKinds: null }, 'test')).toBe(true);
    expect(canDecide({ role: 'approver', approvalKinds: ['test'] }, 'test')).toBe(true);
    expect(canDecide({ role: 'approver', approvalKinds: ['sales.proposal'] }, 'test')).toBe(false);
    expect(canDecide({ role: 'approver', approvalKinds: [] }, 'test')).toBe(false);
    expect(canDecide({ role: 'viewer', approvalKinds: null }, 'test')).toBe(false);
    // The list applies to owners too; an owner can change their own list in settings.
    expect(canDecide({ role: 'owner', approvalKinds: null }, 'test')).toBe(true);
    expect(canDecide({ role: 'owner', approvalKinds: ['sales.proposal'] }, 'test')).toBe(false);
  });

  it('adds, changes and removes a person, logging each change', async () => {
    await saveUser(pool, { slackUserId: OWNER, role: 'owner', approvalKinds: null }, 'system');
    await saveUser(pool, { slackUserId: 'U0NEW', role: 'viewer', approvalKinds: null }, OWNER);
    await saveUser(pool, { slackUserId: 'U0NEW', role: 'approver', approvalKinds: ['test'] }, OWNER);
    expect(await getUser(pool, 'U0NEW')).toMatchObject({ role: 'approver', approvalKinds: ['test'] });
    await removeUser(pool, 'U0NEW', OWNER);
    expect(await getUser(pool, 'U0NEW')).toBeNull();
    expect(await auditActions(pool)).toEqual(['user.add', 'user.add', 'user.update', 'user.remove']);
  });

  it('rejects a member ID or role that is not valid', async () => {
    await expect(saveUser(pool, { slackUserId: '@olive', role: 'owner', approvalKinds: null }, OWNER)).rejects.toThrow(UserChangeError);
    await expect(
      saveUser(pool, { slackUserId: 'U0NEW', role: 'admin' as 'owner', approvalKinds: null }, OWNER),
    ).rejects.toThrow(UserChangeError);
  });

  it('never leaves the allowlist without an owner', async () => {
    await saveUser(pool, { slackUserId: OWNER, role: 'owner', approvalKinds: null }, 'system');
    await expect(saveUser(pool, { slackUserId: OWNER, role: 'approver', approvalKinds: null }, OWNER)).rejects.toThrow(/at least one owner/);
    await expect(removeUser(pool, OWNER, OWNER)).rejects.toThrow(/at least one owner/);

    await saveUser(pool, { slackUserId: 'U0SECOND', role: 'owner', approvalKinds: null }, OWNER);
    const outcomes = await Promise.allSettled([removeUser(pool, OWNER, OWNER), removeUser(pool, 'U0SECOND', OWNER)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect((await listUsers(pool)).filter((u) => u.role === 'owner')).toHaveLength(1);
  });

  it('removing a person ends their sessions', async () => {
    await saveUser(pool, { slackUserId: OWNER, role: 'owner', approvalKinds: null }, 'system');
    await saveUser(pool, { slackUserId: 'U0NEW', role: 'viewer', approvalKinds: null }, OWNER);
    await pool.query(
      `INSERT INTO sessions (id_hash, slack_user_id, csrf_token, expires_at) VALUES ('h', 'U0NEW', 'c', now() + interval '1 day')`,
    );
    await removeUser(pool, 'U0NEW', OWNER);
    expect((await pool.query('SELECT 1 FROM sessions')).rowCount).toBe(0);
  });

  it('adds the bootstrap owner only when absent, and never restores a changed role', async () => {
    expect(await ensureBootstrapOwner(pool, OWNER)).toBe(true);
    expect(await ensureBootstrapOwner(pool, OWNER)).toBe(false);
    await saveUser(pool, { slackUserId: 'U0SECOND', role: 'owner', approvalKinds: null }, OWNER);
    await saveUser(pool, { slackUserId: OWNER, role: 'viewer', approvalKinds: null }, 'U0SECOND');
    expect(await ensureBootstrapOwner(pool, OWNER)).toBe(false);
    expect((await getUser(pool, OWNER))!.role).toBe('viewer');
    expect((await auditActions(pool)).filter((a) => a === 'user.bootstrap_owner')).toHaveLength(1);
  });
});
