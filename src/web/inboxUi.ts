import { createHash } from 'node:crypto';
import type { Response, Router } from 'express';
import { spentSince } from '../ai/run.js';
import { recordAudit } from '../audit/auditLog.js';
import { resumeHeldInboxPosts } from '../inbox/delivery.js';
import { activeAlias, forwardingAddress, issueAlias, recentMail } from '../inbox/email.js';
import { ReaderOAuthError, missingHistoryScopes } from '../inbox/reader.js';
import {
  RuleInputError,
  WorkspaceInputError,
  addEmailWorkspace,
  digestItems,
  dropCounts,
  getDigest,
  getItem,
  getWorkspace,
  isUuid,
  listBundles,
  listDigests,
  listRules,
  listWorkspaces,
  looseTasks,
  recentItems,
  removeRule,
  ruleSuggestions,
  saveRule,
  setDismissReason,
  setLooseTaskDone,
  updateWorkspace,
} from '../inbox/store.js';
import type { Rule } from '../inbox/types.js';
import { RULES, isDismissReason } from '../inbox/types.js';
import type { BackfillRow } from '../inbox/workspace.js';
import { MAX_BACKFILL_HOURS, lastBackfill, requestBackfill, saveGrant } from '../inbox/workspace.js';
import { listIntegrations } from '../integrations/status.js';
import { getProject, listProjects } from '../registry/registry.js';
import { getRoute } from '../settings/routes.js';
import type { AllSettings, SettingKey } from '../settings/settings.js';
import { SettingValidationError, getAllSettings, setSetting, settingDefs } from '../settings/settings.js';
import { canDecide } from '../settings/users.js';
import type { UiHelpers } from './auditUi.js';
import type { WebDeps } from './deps.js';
import type { SafeHtml } from './html.js';
import type { InboxPageData } from './inboxViews.js';
import { digestPage, inboxPage, inboxSettingsCard, itemPage } from './inboxViews.js';
import type { Session } from './session.js';
import { statesMatch } from './session.js';
import type { PageContext } from './views.js';
import { errorPage } from './views.js';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const CONNECT_ERRORS: Record<string, string> = {
  denied: 'Slack did not grant the authorisation, so nothing is connected.',
  state: 'The authorisation did not start from this session. Start again from this screen.',
  wrong_workspace: 'That authorisation is for another workspace. Only PatchOps is read through the app.',
  wrong_person: 'Slack authorised a different person than the one signed in here. Sign in to Slack as yourself and try again.',
  scopes: 'Slack did not grant permission to read messages, so nothing is connected.',
  failed: 'Slack did not complete the authorisation. Try again.',
};

/** The Slack inbox card on the Settings screen. */
export async function inboxSettings(deps: WebDeps, ctx: PageContext, settings: AllSettings): Promise<SafeHtml> {
  const [integrations, spentDay, spentMonth] = await Promise.all([listIntegrations(deps.pool), spentSince(deps.pool, 'inbox', 24), spentSince(deps.pool, 'inbox', 24 * 30)]);
  return inboxSettingsCard(ctx, {
    settings,
    ai: { configured: integrations.find((i) => i.name === 'anthropic')?.configured ?? null, spentDay, spentMonth },
  });
}

/** The Slack inbox screens, the reader's authorisation, and the inbox settings (design sections 8 and 12). */
export function inboxRoutes(router: Router, deps: WebDeps, ui: UiHelpers): void {
  const redirectUri = `${deps.appBaseUrl}/auth/slack/reader/callback`;
  const canConnect = (): boolean => Boolean(deps.readerOAuth && deps.hubTeamId && deps.seal);
  const sessionOf = (res: Response): Session => res.locals.session as Session;
  // Only this session can produce it, and it is useless as the CSRF token itself.
  const stateFor = (session: Session): string => createHash('sha256').update(`slack-reader:${session.csrfToken}`).digest('base64url');

  const pageData = async (extra: Pick<InboxPageData, 'issuedAddress'> = {}): Promise<InboxPageData> => {
    const [settings, workspaces, rules, suggestions, projects, items, log, drops, digests, mail, tasks, route, alias] = await Promise.all([
      getAllSettings(deps.pool),
      listWorkspaces(deps.pool),
      listRules(deps.pool),
      ruleSuggestions(deps.pool),
      listProjects(deps.pool),
      recentItems(deps.pool, 40),
      listBundles(deps.pool, { limit: 60 }),
      dropCounts(deps.pool, 7),
      listDigests(deps.pool, 8),
      recentMail(deps.pool, 15),
      looseTasks(deps.pool),
      getRoute(deps.pool, 'inbox'),
      activeAlias(deps.pool),
    ]);
    const backfills = new Map<string, BackfillRow>();
    for (const w of workspaces.filter((w) => w.readMode === 'api')) {
      const last = await lastBackfill(deps.pool, w.id);
      if (last) backfills.set(w.id, last);
    }
    return {
      settings,
      workspaces,
      backfills,
      rules,
      suggestions,
      projects,
      items,
      log,
      drops,
      digests,
      mail,
      tasks,
      hasRoute: route !== null,
      canConnect: canConnect(),
      mailReady: Boolean(deps.inboundEmailSecret && settings['inbox.email_address']),
      hasAlias: alias !== null,
      ...extra,
    };
  };

  router.get('/inbox', async (req, res) => {
    const [ctx, data] = await Promise.all([ui.context(req, res), pageData()]);
    res.send(inboxPage(ctx, data));
  });

  router.get('/inbox/digests/:id', async (req, res) => {
    const id = String(req.params.id);
    const digest = isUuid(id) ? await getDigest(deps.pool, id) : null;
    if (!digest) {
      res.status(404).send(errorPage(404, 'That digest does not exist.'));
      return;
    }
    const [ctx, items] = await Promise.all([ui.context(req, res), digestItems(deps.pool, digest.id)]);
    res.send(digestPage(ctx, { digest, items }));
  });

  router.get('/inbox/items/:id', async (req, res) => {
    const id = String(req.params.id);
    const item = isUuid(id) ? await getItem(deps.pool, id) : null;
    if (!item) {
      res.status(404).send(errorPage(404, 'That item does not exist.'));
      return;
    }
    res.send(itemPage(await ui.context(req, res), { item }));
  });

  // Authorising the reader ---------------------------------------------------------------------

  router.get('/inbox/connect', ui.owner, async (_req, res) => {
    if (!deps.readerOAuth || !canConnect()) {
      await ui.back(res, '/inbox', 'error', 'PatchOps cannot be connected yet: the Slack app variables and TOKEN_PUBLIC_KEY must be set on the web service.');
      return;
    }
    res.redirect(deps.readerOAuth.authorizeUrl({ state: stateFor(sessionOf(res)), redirectUri }));
  });

  router.get('/auth/slack/reader/callback', ui.owner, async (req, res) => {
    const fail = (reason: keyof typeof CONNECT_ERRORS) => ui.back(res, '/inbox', 'error', CONNECT_ERRORS[reason]!);
    const session = sessionOf(res);
    if (!deps.readerOAuth || !deps.hubTeamId || !deps.seal) return fail('failed');
    if (!statesMatch(stateFor(session), req.query.state)) return fail('state');
    const code = text(req.query.code);
    if (!code) return fail(text(req.query.error) ? 'denied' : 'failed');

    let grant;
    try {
      grant = await deps.readerOAuth.exchange({ code, redirectUri });
    } catch (err) {
      if (!(err instanceof ReaderOAuthError)) throw err;
      deps.log.warn('slack reader authorisation failed', { err });
      return fail('failed');
    }
    // A token that will not be kept is given back rather than left valid and unused.
    const refuse = async (reason: keyof typeof CONNECT_ERRORS) => {
      await deps.readerOAuth?.revoke(grant.token);
      deps.log.warn('slack reader authorisation refused', { reason });
      return fail(reason);
    };
    if (grant.teamId !== deps.hubTeamId) return refuse('wrong_workspace');
    if (grant.userId !== session.user.slackUserId) return refuse('wrong_person');
    if (missingHistoryScopes(grant.scopes).length) return refuse('scopes');

    const actor = ui.actorOf(res);
    const saved = await saveGrant(
      deps.pool,
      { teamId: grant.teamId, teamName: grant.teamName, userId: grant.userId, scopes: grant.scopes, sealedToken: deps.seal(grant.token) },
      actor,
    );
    await deps.queue.enqueue('inbox.workspace.check', { workspaceId: saved.id });
    if (saved.reconnected && saved.lastEventAt) {
      const earliest = new Date(Date.now() - MAX_BACKFILL_HOURS * 3_600_000);
      const since = saved.lastEventAt > earliest ? saved.lastEventAt : earliest;
      await requestBackfill(deps, { workspaceId: saved.id, since, reason: 'reconnect', requestedBy: actor });
    }
    await ui.back(
      res,
      '/inbox',
      'ok',
      saved.reconnected ? 'PatchOps is connected again. Messages since the last one seen are being caught up.' : 'PatchOps is connected. New messages are read from now on.',
    );
  });

  // Workspaces -----------------------------------------------------------------------------------

  router.post('/inbox/workspaces', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      await addEmailWorkspace(deps.pool, { domain: text(body.domain), name: text(body.name) }, ui.actorOf(res));
      await ui.back(res, '/inbox#workspaces', 'ok', 'Added, switched off. Switch it on to read its forwarded mail.');
    } catch (err) {
      if (!(err instanceof WorkspaceInputError)) throw err;
      await ui.back(res, '/inbox#workspaces', 'error', err.message);
    }
  });

  router.post('/inbox/workspaces/:id', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const workspace = isUuid(id) ? await getWorkspace(deps.pool, id) : null;
    if (!workspace) {
      await ui.back(res, '/inbox#workspaces', 'error', 'That workspace does not exist.');
      return;
    }
    const projectId = text(body.project_id) || null;
    if (projectId !== null && !(isUuid(projectId) && (await getProject(deps.pool, projectId)))) {
      await ui.back(res, '/inbox#workspaces', 'error', 'That project does not exist.');
      return;
    }
    const actor = ui.actorOf(res);
    const result = await updateWorkspace(
      deps.pool,
      id,
      {
        enabled: body.enabled === '1',
        readDms: body.read_dms === '1',
        channelDefault: body.channel_default === 'exclude' ? 'exclude' : 'include',
        projectId,
      },
      actor,
    );
    if (result.switchedOff) await deps.queue.enqueue('inbox.workspace.off', { workspaceId: id, requestedBy: actor });
    await ui.back(
      res,
      '/inbox#workspaces',
      'ok',
      result.switchedOff ? 'Switched off. The messages stored for it are deleted.' : result.changed ? 'Saved.' : 'Nothing changed.',
    );
  });

  router.post('/inbox/workspaces/:id/backfill', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    const hours = Number(text((req.body as Record<string, unknown>).hours));
    if (!isUuid(id) || !Number.isInteger(hours) || hours < 1 || hours > MAX_BACKFILL_HOURS) {
      await ui.back(res, '/inbox#workspaces', 'error', `Choose between 1 and ${MAX_BACKFILL_HOURS} hours.`);
      return;
    }
    const outcome = await requestBackfill(deps, { workspaceId: id, since: new Date(Date.now() - hours * 3_600_000), reason: 'manual', requestedBy: ui.actorOf(res) });
    const message = {
      started: `Catching up on the last ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
      running: 'A catch-up is already running for this workspace.',
      not_connected: 'This workspace is not connected and switched on, so there is nothing to read.',
    }[outcome];
    await ui.back(res, '/inbox#workspaces', outcome === 'started' ? 'ok' : 'error', message);
  });

  // Channel rules --------------------------------------------------------------------------------

  router.post('/inbox/rules', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const workspaceId = text(body.workspace_id);
    const rule = text(body.rule);
    const projectId = text(body.project_id) || null;
    try {
      if (!isUuid(workspaceId) || !(await getWorkspace(deps.pool, workspaceId))) throw new RuleInputError('Choose a workspace.');
      if (!(RULES as readonly string[]).includes(rule)) throw new RuleInputError('Choose a rule.');
      if (projectId !== null && !(isUuid(projectId) && (await getProject(deps.pool, projectId)))) throw new RuleInputError('That project does not exist.');
      await saveRule(deps.pool, { workspaceId, channel: text(body.channel), rule: rule as Rule, projectId }, ui.actorOf(res));
      await ui.back(res, '/inbox#rules', 'ok', 'Rule saved. It applies to messages from now on.');
    } catch (err) {
      if (!(err instanceof RuleInputError)) throw err;
      await ui.back(res, '/inbox#rules', 'error', err.message);
    }
  });

  router.post('/inbox/rules/:id/remove', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    const removed = isUuid(id) && (await removeRule(deps.pool, id, ui.actorOf(res)));
    await ui.back(res, '/inbox#rules', removed ? 'ok' : 'error', removed ? 'Rule removed.' : 'That rule does not exist.');
  });

  // Forwarded mail -------------------------------------------------------------------------------

  router.post('/inbox/email/alias', ui.owner, async (req, res) => {
    const settings = await getAllSettings(deps.pool);
    if (!settings['inbox.email_address']) {
      await ui.back(res, '/inbox#email', 'error', 'Save the inbound address of the mail service in Settings first.');
      return;
    }
    const token = await issueAlias(deps.pool, ui.actorOf(res));
    // Rendered here rather than after a redirect: the address is a secret and is never stored, not even as a flash.
    const [ctx, data] = await Promise.all([ui.context(req, res), pageData({ issuedAddress: forwardingAddress(settings['inbox.email_address'], token) })]);
    res.set('Cache-Control', 'no-store').send(inboxPage(ctx, data));
  });

  // Items ------------------------------------------------------------------------------------------

  router.post('/inbox/digest/run', ui.approver, async (_req, res) => {
    await deps.queue.enqueue('schedule.run', { key: 'slack.digest', trigger: 'manual', scheduledFor: new Date().toISOString() });
    await recordAudit(deps.pool, { actor: ui.actorOf(res), action: 'schedule.run_now', target: 'slack.digest' });
    await ui.back(res, '/inbox', 'ok', 'A digest is being put together. Nothing is posted when nothing needs you.');
  });

  router.post('/inbox/items/:id/post', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const item = isUuid(id) ? await getItem(deps.pool, id) : null;
    if (!item?.rec || item.rec.status !== 'drafted') {
      await ui.back(res, isUuid(id) ? `/inbox/items/${id}` : '/inbox', 'error', 'That item is not waiting to be posted.');
      return;
    }
    await deps.pool.query('UPDATE slack_bundles SET post_error = NULL WHERE id = $1', [id]);
    await deps.queue.enqueue('inbox.post', { bundleId: id });
    await ui.back(res, `/inbox/items/${id}`, 'ok', 'Posting to Slack.');
  });

  router.post('/inbox/items/:id/reason', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const reason = text((req.body as Record<string, unknown>).reason);
    const item = isUuid(id) ? await getItem(deps.pool, id) : null;
    if (!item?.rec || !isDismissReason(reason)) {
      await ui.back(res, '/inbox', 'error', 'That item does not exist.');
      return;
    }
    if (!canDecide(sessionOf(res).user, item.rec.kind)) {
      await ui.back(res, `/inbox/items/${id}`, 'error', 'You are not on the approver list for this.');
      return;
    }
    const saved = await setDismissReason(deps.pool, id, reason, ui.actorOf(res));
    if (saved) await deps.queue.enqueue('recommendation.sync', { recommendationId: item.rec.id });
    await ui.back(res, `/inbox/items/${id}`, saved ? 'ok' : 'error', saved ? 'Noted.' : 'Only a dismissed item takes a reason.');
  });

  router.post('/inbox/tasks/:id/done', ui.approver, async (req, res) => {
    const done = (req.body as Record<string, unknown>).done !== '0';
    const changed = await setLooseTaskDone(deps.pool, String(req.params.id), done, ui.actorOf(res));
    await ui.back(res, '/inbox#tasks', changed ? 'ok' : 'error', changed ? (done ? 'Marked done.' : 'Reopened.') : 'Nothing changed.');
  });

  // Settings -------------------------------------------------------------------------------------

  router.post('/settings/inbox', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const actor = ui.actorOf(res);
    try {
      const changes: [SettingKey, unknown][] = [];
      for (const key of ['inbox.enabled', 'ai.inbox.enabled', 'inbox.digest_only', 'inbox.agent_enabled'] as const) changes.push([key, body[key] === '1']);
      for (const key of ['inbox.quiet_hours', 'inbox.email_address'] as const) {
        if (typeof body[key] === 'string') changes.push([key, text(body[key])]);
      }
      for (const key of ['inbox.quiet_tz', 'inbox.email_senders', 'ai.inbox.model_triage', 'ai.inbox.model_recommend'] as const) {
        const raw = text(body[key]);
        if (raw) changes.push([key, raw]);
      }
      for (const key of ['inbox.settle_seconds', 'inbox.unanalysed_after_minutes', 'inbox.retention_days', 'ai.inbox.daily_budget_usd', 'ai.inbox.monthly_budget_usd'] as const) {
        const raw = text(body[key]);
        if (raw) changes.push([key, Number(raw)]);
      }
      for (const [key, value] of changes) {
        const parsed = settingDefs[key].schema.safeParse(value);
        if (!parsed.success) throw new SettingValidationError(`${settingDefs[key].label}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
      }
      for (const [key, value] of changes) await setSetting(deps.pool, key, value, actor);
      // Switching the reader or the model back on lets what waited go through at once.
      await resumeHeldInboxPosts(deps);
      await ui.back(res, '/settings#inbox', 'ok', 'Saved.');
    } catch (err) {
      if (!(err instanceof SettingValidationError)) throw err;
      await ui.back(res, '/settings#inbox', 'error', `Not saved. ${err.message}`);
    }
  });
}
