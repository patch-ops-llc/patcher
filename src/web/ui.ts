import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import { PROMPTS } from '../ai/prompts.js';
import { callTotals, spentSince } from '../ai/run.js';
import { listAudit, recordAudit } from '../audit/auditLog.js';
import { listIntegrations } from '../integrations/status.js';
import { queueStats } from '../queue/queue.js';
import {
  RecommendationInputError,
  countByStatus,
  createRecommendation,
  decide,
  editRecommendation,
  getRecommendation,
  listActions,
  listApprovals,
  listRecommendations,
  retryRecommendation,
} from '../recommendations/service.js';
import type { DecisionResult } from '../recommendations/service.js';
import { ScheduleValidationError, listSchedules, updateSchedule } from '../scheduler/schedules.js';
import { setPaused } from '../settings/pause.js';
import { REPORT_TYPES, RouteValidationError, isReportType, listChannels, listRoutes, setRoute } from '../settings/routes.js';
import { SettingValidationError, getAllSettings, setSetting } from '../settings/settings.js';
import type { Role, User } from '../settings/users.js';
import { ROLES, UserChangeError, canDecide, hasRole, listUsers, removeUser, saveUser } from '../settings/users.js';
import { OidcError } from '../slack/oidc.js';
import { resumeHeldCallPosts } from '../calls/delivery.js';
import { resumeHeldInboxPosts } from '../inbox/delivery.js';
import { resumeHeldSalesPosts } from '../sales/delivery.js';
import { resumeHeldReports } from '../weekly/delivery.js';
import { auditRoutes } from './auditUi.js';
import { MAX_UPLOAD, callRoutes, callsSettings } from './callsUi.js';
import { inboxRoutes, inboxSettings } from './inboxUi.js';
import { MAX_PROPOSAL_FORM, salesRoutes, salesSettings } from './salesUi.js';
import { authorizeLogin } from './auth.js';
import type { WebDeps } from './deps.js';
import type { Session } from './session.js';
import {
  beginLogin,
  createSession,
  csrfMatches,
  destroySession,
  finishLogin,
  loadSession,
  setFlash,
  statesMatch,
  takeFlash,
} from './session.js';
import type { PageContext, RunRow } from './views.js';
import { activityPage, approvalDetailPage, approvalsPage, errorPage, homePage, loginPage, settingsPage } from './views.js';

const LOGIN_ERRORS: Record<string, string> = {
  wrong_workspace: 'Sign in with your PatchOps Slack account. That account belongs to another workspace.',
  not_on_allowlist: 'Your Slack account is not on the Patcher access list. Ask an owner to add you.',
  failed: 'Sign-in did not complete. Try again.',
};

/** Why a decision was refused, in words for the UI (the Slack wording uses Slack mentions). */
const REFUSALS: Record<Extract<DecisionResult, { ok: false }>['reason'], string> = {
  not_found: 'That recommendation no longer exists.',
  forbidden: 'You are not on the approver list for this.',
  not_pending: 'This has already been decided, or is not waiting for a decision.',
  stale: 'This was edited after you opened it. Check the current version below.',
  paused: 'Patcher is paused, so nothing can be approved. Resume it first.',
  invalid: 'The edit was not saved.',
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function uiRouter(deps: WebDeps): Router {
  const router = express.Router();
  const redirectUri = `${deps.appBaseUrl}/auth/slack/callback`;
  const slackReady = () => Boolean(deps.features.slackRequests?.configured && deps.features.slackModals?.configured);

  // A pasted transcript is the one form that is long. Its parser runs first; the general one then finds the body read.
  router.post('/calls/upload', express.urlencoded({ extended: false, limit: MAX_UPLOAD }));
  router.post('/sales/proposals/:id/edit', express.urlencoded({ extended: false, limit: MAX_PROPOSAL_FORM }));
  router.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Sign-in --------------------------------------------------------------------------------

  router.get('/login', (req, res) => {
    const error = LOGIN_ERRORS[text(req.query.error)];
    res.status(200).send(loginPage({ configured: deps.oidc !== null, error }));
  });

  router.get('/auth/slack', (_req, res) => {
    if (!deps.oidc) {
      res.redirect('/login');
      return;
    }
    const { state, nonce } = beginLogin(res, deps.cookies);
    res.redirect(deps.oidc.authorizeUrl({ state, nonce, redirectUri }));
  });

  router.get('/auth/slack/callback', async (req, res) => {
    const login = finishLogin(req, res, deps.cookies);
    const code = text(req.query.code);
    if (!deps.oidc || !deps.hubTeamId || !login || !code || !statesMatch(login.state, req.query.state)) {
      res.redirect('/login?error=failed');
      return;
    }
    let identity;
    try {
      identity = await deps.oidc.exchange({ code, nonce: login.nonce, redirectUri });
    } catch (err) {
      if (!(err instanceof OidcError)) throw err;
      deps.log.warn('sign-in failed', { err });
      res.redirect('/login?error=failed');
      return;
    }
    const decision = await authorizeLogin(deps.pool, identity, {
      hubTeamId: deps.hubTeamId,
      bootstrapOwner: deps.bootstrapOwner,
    });
    if (!decision.ok) {
      deps.log.warn('sign-in denied', { reason: decision.reason, slackUserId: identity.userId });
      res.redirect(`/login?error=${decision.reason}`);
      return;
    }
    await createSession(deps.pool, res, deps.cookies, decision.user.slackUserId);
    res.redirect('/');
  });

  // Everything below needs a session ----------------------------------------------------------

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const session = await loadSession(deps.pool, req, deps.cookies);
    if (!session) {
      if (req.method === 'GET') res.redirect('/login');
      else res.status(401).send(errorPage(401, 'Your session has ended. Sign in again.'));
      return;
    }
    // Every state-changing request must carry the session's CSRF token.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const body = req.body as Record<string, unknown> | undefined;
      if (!csrfMatches(session, body?._csrf)) {
        res.status(403).send(errorPage(403, 'That form has expired. Go back, reload the page and try again.'));
        return;
      }
    }
    res.locals.session = session;
    next();
  });

  const sessionOf = (res: Response) => res.locals.session as Session;
  const actorOf = (res: Response) => sessionOf(res).user.slackUserId;

  const requireRole = (role: Role) => (_req: Request, res: Response, next: NextFunction) => {
    if (!hasRole(sessionOf(res).user, role)) {
      res.status(403).send(errorPage(403, `This needs the ${role} role.`));
      return;
    }
    next();
  };
  const owner = requireRole('owner');
  const approver = requireRole('approver');

  const context = async (req: Request, res: Response): Promise<PageContext> => {
    const session = sessionOf(res);
    const settings = await getAllSettings(deps.pool);
    return {
      session,
      flash: await takeFlash(deps.pool, session),
      paused: settings.paused,
      dryRun: settings.dry_run || deps.dryRunEnv,
      path: req.path,
    };
  };

  const back = async (res: Response, to: string, kind: 'ok' | 'error', message: string) => {
    await setFlash(deps.pool, sessionOf(res), { kind, text: message });
    res.redirect(303, to);
  };

  const userMap = async (): Promise<Map<string, User>> =>
    new Map((await listUsers(deps.pool)).map((u) => [u.slackUserId, u]));

  const labelFor = (kind: string) => deps.catalog.label(kind);

  router.post('/logout', async (_req, res) => {
    await destroySession(deps.pool, res, deps.cookies, sessionOf(res));
    res.redirect(303, '/login');
  });

  // Home -----------------------------------------------------------------------------------

  router.get('/', async (req, res) => {
    const [ctx, counts, pending, schedules, failures, queue] = await Promise.all([
      context(req, res),
      countByStatus(deps.pool),
      listRecommendations(deps.pool, ['posted'], 10),
      listSchedules(deps.pool),
      deps.pool.query<RunRow>(
        `SELECT pipeline, trigger, started_at, finished_at, ok, summary FROM runs WHERE ok = false ORDER BY id DESC LIMIT 10`,
      ),
      queueStats(deps.pool),
    ]);
    res.send(homePage(ctx, { counts, pending, schedules, failures: failures.rows, queue, labelFor, slackReady: slackReady() }));
  });

  router.post('/pause', approver, async (_req, res) => {
    await setPaused(deps, true, actorOf(res));
    await back(res, '/', 'ok', 'Paused.');
  });

  router.post('/resume', owner, async (_req, res) => {
    await setPaused(deps, false, actorOf(res));
    await back(res, '/', 'ok', 'Resumed.');
  });

  // Approvals ------------------------------------------------------------------------------

  router.get('/approvals', async (req, res) => {
    const [ctx, pending, waiting, recent, users] = await Promise.all([
      context(req, res),
      listRecommendations(deps.pool, ['posted'], 200),
      listRecommendations(deps.pool, ['drafted'], 100),
      listRecommendations(deps.pool, ['approved', 'executing', 'done', 'failed', 'dismissed', 'expired'], 30),
      userMap(),
    ]);
    res.send(approvalsPage(ctx, { pending, waiting, recent, labelFor, users }));
  });

  router.get('/approvals/:id', async (req, res) => {
    const rec = await getRecommendation(deps.pool, String(req.params.id));
    if (!rec) {
      res.status(404).send(errorPage(404, 'That recommendation does not exist.'));
      return;
    }
    const [ctx, approvals, actions, users] = await Promise.all([
      context(req, res),
      listApprovals(deps.pool, rec.id),
      listActions(deps.pool, rec.id),
      userMap(),
    ]);
    res.send(
      approvalDetailPage(ctx, {
        rec,
        label: labelFor(rec.kind),
        actionDescription: deps.catalog.describe(rec.action),
        approvals,
        actions,
        users,
        canDecide: canDecide(sessionOf(res).user, rec.kind),
      }),
    );
  });

  const decisionInput = (req: Request, res: Response) => ({
    id: String(req.params.id),
    hash: text((req.body as Record<string, unknown>).hash),
    actor: actorOf(res),
    via: 'ui' as const,
  });

  const finishDecision = async (req: Request, res: Response, result: DecisionResult, okText: string) => {
    const to = result.ok || result.recommendation ? `/approvals/${String(req.params.id)}` : '/approvals';
    if (result.ok) await back(res, to, 'ok', okText);
    else await back(res, to, 'error', result.reason === 'invalid' ? `${REFUSALS.invalid} ${result.message}` : REFUSALS[result.reason]);
  };

  router.post('/approvals/:id/approve', approver, async (req, res) => {
    const result = await decide(deps, { ...decisionInput(req, res), decision: 'approve' });
    await finishDecision(req, res, result, 'Approved.');
  });

  router.post('/approvals/:id/dismiss', approver, async (req, res) => {
    const result = await decide(deps, { ...decisionInput(req, res), decision: 'dismiss' });
    await finishDecision(req, res, result, 'Dismissed.');
  });

  router.post('/approvals/:id/retry', approver, async (req, res) => {
    const result = await retryRecommendation(deps, decisionInput(req, res));
    await finishDecision(req, res, result, 'Retrying.');
  });

  router.post('/approvals/:id/edit', approver, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    let params: unknown;
    try {
      params = JSON.parse(text(body.params));
    } catch {
      await back(res, `/approvals/${String(req.params.id)}`, 'error', 'The action parameters are not valid JSON. Nothing was saved.');
      return;
    }
    const result = await editRecommendation(deps, {
      ...decisionInput(req, res),
      title: text(body.title),
      body: text(body.body),
      params,
    });
    await finishDecision(req, res, result, result.ok && !result.changed ? 'Nothing changed.' : 'Saved as a new version.');
  });

  router.post('/approvals/:id/post', approver, async (req, res) => {
    const rec = await getRecommendation(deps.pool, String(req.params.id));
    if (rec?.status === 'drafted') {
      await deps.queue.enqueue('recommendation.post', { recommendationId: rec.id });
      await back(res, `/approvals/${rec.id}`, 'ok', 'Posting to Slack. Reload in a moment.');
    } else {
      await back(res, '/approvals', 'error', 'That recommendation is not waiting to be posted.');
    }
  });

  // Settings -------------------------------------------------------------------------------

  router.get('/settings', async (req, res) => {
    const [ctx, routes, channels, schedules, users, settings, integrations, spentDay, spentMonth, calls] = await Promise.all([
      context(req, res),
      listRoutes(deps.pool),
      deps.hubTeamId ? listChannels(deps.pool, deps.hubTeamId) : Promise.resolve([]),
      listSchedules(deps.pool),
      listUsers(deps.pool),
      getAllSettings(deps.pool),
      listIntegrations(deps.pool),
      spentSince(deps.pool, 'audit', 24),
      spentSince(deps.pool, 'audit', 24 * 30),
      callTotals(deps.pool, { days: 30 }),
    ]);
    res.send(
      settingsPage(ctx, {
        routes,
        channels,
        schedules,
        users,
        settings,
        kinds: deps.catalog.kindNames(),
        callsCard: await callsSettings(deps, ctx, settings),
        salesCard: await salesSettings(deps, ctx, settings),
        inboxCard: await inboxSettings(deps, ctx, settings),
        dryRunEnv: deps.dryRunEnv,
        slackReady: slackReady(),
        ai: {
          configured: integrations.find((i) => i.name === 'anthropic')?.configured ?? null,
          prompts: PROMPTS,
          spentDay,
          spentMonth,
          calls,
        },
      }),
    );
  });

  router.post('/settings/routes/:type', owner, async (req, res) => {
    const type = String(req.params.type);
    const body = req.body as Record<string, unknown>;
    if (!isReportType(type)) {
      await back(res, '/settings#routing', 'error', 'Unknown report type.');
      return;
    }
    if (!deps.hubTeamId) {
      await back(res, '/settings#routing', 'error', 'Slack is not configured yet, so there is no workspace to route to.');
      return;
    }
    const channelId = text(body.channel_id).toUpperCase() || text(body.channel) || null;
    try {
      const { changed } = await setRoute(deps.pool, { reportType: type, teamId: deps.hubTeamId, channelId }, actorOf(res));
      if (changed && channelId) {
        // Anything drafted for this report type was waiting for a channel.
        const waiting = await deps.pool.query<{ id: string }>(
          `SELECT id FROM recommendations WHERE status = 'drafted' AND report_type = $1`,
          [type],
        );
        for (const row of waiting.rows) await deps.queue.enqueue('recommendation.post', { recommendationId: row.id });
        if (type === 'audit') await resumeHeldReports(deps);
        if (type === 'calls') await resumeHeldCallPosts(deps);
        if (type === 'sales') await resumeHeldSalesPosts(deps);
        if (type === 'inbox') await resumeHeldInboxPosts(deps);
      }
      await back(res, '/settings#routing', 'ok', changed ? `${REPORT_TYPES[type].label} channel saved.` : 'Nothing changed.');
    } catch (err) {
      if (!(err instanceof RouteValidationError)) throw err;
      await back(res, '/settings#routing', 'error', err.message);
    }
  });

  router.post('/settings/routes/:type/test', owner, async (req, res) => {
    const type = String(req.params.type);
    if (!isReportType(type)) {
      await back(res, '/settings#routing', 'error', 'Unknown report type.');
      return;
    }
    const actor = actorOf(res);
    try {
      const { recommendation } = await createRecommendation(deps, {
        kind: 'test',
        reportType: type,
        sourceType: 'control_ui',
        title: `Routing check for ${REPORT_TYPES[type].label}`,
        body: 'Sent from Patcher settings. Approving records the decision and does nothing else.',
        evidence: [{ quote: `Test sent for the ${REPORT_TYPES[type].label} route.`, source: 'Patcher settings' }],
        action: { type: 'acknowledge', params: { note: 'Routing and approval check' } },
        createdBy: actor,
      });
      await back(res, `/approvals/${recommendation.id}`, 'ok', 'Test recommendation created. It is posted to Slack within a few seconds.');
    } catch (err) {
      if (!(err instanceof RecommendationInputError)) throw err;
      await back(res, '/settings#routing', 'error', err.message);
    }
  });

  router.post('/settings/channels/refresh', owner, async (_req, res) => {
    await deps.queue.enqueue('slack.channels.sync', { requestedBy: actorOf(res) });
    await back(res, '/settings#routing', 'ok', 'Refreshing the channel list. Reload in a few seconds.');
  });

  router.post('/settings/switches', owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const actor = actorOf(res);
    try {
      if (!deps.dryRunEnv) await setSetting(deps.pool, 'dry_run', body.dry_run === '1', actor);
      for (const key of ['approvals.expire_hours', 'approvals.reminder_hours', 'slack.max_posts_per_hour', 'audit.agent_timeout_minutes'] as const) {
        const raw = text(body[key]);
        if (raw) await setSetting(deps.pool, key, Number(raw), actor);
      }
      await back(res, '/settings#switches', 'ok', 'Saved.');
    } catch (err) {
      if (!(err instanceof SettingValidationError)) throw err;
      await back(res, '/settings#switches', 'error', `Not saved. ${err.message}`);
    }
  });

  router.post('/settings/ai', owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const actor = actorOf(res);
    try {
      await setSetting(deps.pool, 'ai.audit.enabled', body['ai.audit.enabled'] === '1', actor);
      for (const key of ['ai.audit.model_service', 'ai.audit.model_rollup', 'ai.audit.model_brief'] as const) {
        const raw = text(body[key]);
        if (raw) await setSetting(deps.pool, key, raw, actor);
      }
      for (const key of ['ai.audit.daily_budget_usd', 'ai.audit.monthly_budget_usd', 'ai.audit.log_token_cap', 'ai.audit.wait_minutes'] as const) {
        const raw = text(body[key]);
        if (raw) await setSetting(deps.pool, key, Number(raw), actor);
      }
      await back(res, '/settings#ai', 'ok', 'Saved.');
    } catch (err) {
      if (!(err instanceof SettingValidationError)) throw err;
      await back(res, '/settings#ai', 'error', `Not saved. ${err.message}`);
    }
  });

  router.post('/settings/schedules/:key', owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const { changed } = await updateSchedule(
        deps.pool,
        { key: String(req.params.key), cronExpr: text(body.cron_expr), tz: text(body.tz), enabled: body.enabled === '1' },
        actorOf(res),
      );
      await back(res, '/settings#schedules', 'ok', changed ? 'Schedule saved.' : 'Nothing changed.');
    } catch (err) {
      if (!(err instanceof ScheduleValidationError)) throw err;
      await back(res, '/settings#schedules', 'error', `Not saved. ${err.message}`);
    }
  });

  router.post('/settings/schedules/:key/run', owner, async (req, res) => {
    const key = String(req.params.key);
    const schedules = await listSchedules(deps.pool);
    if (!schedules.some((s) => s.key === key)) {
      await back(res, '/settings#schedules', 'error', 'Unknown schedule.');
      return;
    }
    await deps.queue.enqueue('schedule.run', { key, trigger: 'manual', scheduledFor: new Date().toISOString() });
    await recordAudit(deps.pool, { actor: actorOf(res), action: 'schedule.run_now', target: key });
    await back(res, '/settings#schedules', 'ok', `Running ${key} now.`);
  });

  router.post('/settings/people', owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const role = text(body.role) as Role;
    const kinds = text(body.kinds)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const known = new Set(deps.catalog.kindNames());
    const unknown = kinds.filter((k) => !known.has(k));
    try {
      if (!ROLES.includes(role)) throw new UserChangeError('Unknown role.');
      if (unknown.length) throw new UserChangeError(`Unknown kind: ${unknown.join(', ')}.`);
      await saveUser(
        deps.pool,
        { slackUserId: text(body.slack_user_id).toUpperCase(), role, approvalKinds: kinds.length ? kinds : null },
        actorOf(res),
      );
      await back(res, '/settings#people', 'ok', 'Saved.');
    } catch (err) {
      if (!(err instanceof UserChangeError)) throw err;
      await back(res, '/settings#people', 'error', `Not saved. ${err.message}`);
    }
  });

  router.post('/settings/people/:id/remove', owner, async (req, res) => {
    try {
      await removeUser(deps.pool, String(req.params.id), actorOf(res));
      await back(res, '/settings#people', 'ok', 'Removed.');
    } catch (err) {
      if (!(err instanceof UserChangeError)) throw err;
      await back(res, '/settings#people', 'error', `Not removed. ${err.message}`);
    }
  });

  // Activity -------------------------------------------------------------------------------

  router.get('/activity', async (req, res) => {
    const before = /^\d+$/.test(text(req.query.before)) ? text(req.query.before) : undefined;
    const PAGE = 100;
    const [ctx, audit, runs, users] = await Promise.all([
      context(req, res),
      listAudit(deps.pool, PAGE, before),
      deps.pool.query<RunRow>(
        `SELECT pipeline, trigger, started_at, finished_at, ok, summary FROM runs ORDER BY id DESC LIMIT 50`,
      ),
      userMap(),
    ]);
    const nextBefore = audit.length === PAGE ? audit[audit.length - 1]!.id : null;
    res.send(activityPage(ctx, { audit, runs: runs.rows, users, nextBefore }));
  });

  const helpers = { context, back, actorOf, userMap, owner, approver };
  auditRoutes(router, deps, helpers);
  callRoutes(router, deps, helpers);
  salesRoutes(router, deps, helpers);
  inboxRoutes(router, deps, helpers);

  return router;
}
