import type { Router } from 'express';
import { spentSince } from '../ai/run.js';
import { recordAudit } from '../audit/auditLog.js';
import { reanalyzeCall, setCallProject } from '../calls/analyze.js';
import { ConnectionError, addConnection, listConnections, requestRemoval, retryConnection } from '../calls/connections.js';
import { externalDomains, parseDomains } from '../calls/hints.js';
import { ingestTranscript, normalizeUpload } from '../calls/ingest.js';
import type { CallFilter } from '../calls/store.js';
import {
  carriedRecommendations,
  countCalls,
  getCall,
  listCalls,
  listMatches,
  listSuggestions,
  listTranscripts,
  preferredTranscript,
  setTaskDone,
} from '../calls/store.js';
import { listAgentRuns } from '../fix/agentFix.js';
import { listIntegrations } from '../integrations/status.js';
import { RegistryError, getProject, listProjects, updateProject } from '../registry/registry.js';
import type { AllSettings } from '../settings/settings.js';
import { SettingValidationError, getAllSettings, setSetting } from '../settings/settings.js';
import { hasRole } from '../settings/users.js';
import type { UiHelpers } from './auditUi.js';
import { callPage, callsPage, callsSettingsCard, uploadPage } from './callsViews.js';
import type { WebDeps } from './deps.js';
import type { SafeHtml } from './html.js';
import type { PageContext } from './views.js';
import { errorPage } from './views.js';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const many = (value: unknown): string[] => (Array.isArray(value) ? value.map(text) : [text(value)]).filter(Boolean);
const FILTERS: CallFilter[] = ['all', 'needs_answer', 'unmatched', 'waiting'];

/** The most a pasted transcript may be. A three-hour call is well under it. */
export const MAX_UPLOAD = '2mb';
const MAX_UPLOAD_CHARS = 1_500_000;

/** The Calls card on the Settings screen. */
export async function callsSettings(deps: WebDeps, ctx: PageContext, settings: AllSettings): Promise<SafeHtml> {
  const [connections, integrations, spentDay, spentMonth] = await Promise.all([
    listConnections(deps.pool),
    listIntegrations(deps.pool),
    spentSince(deps.pool, 'calls', 24),
    spentSince(deps.pool, 'calls', 24 * 30),
  ]);
  return callsSettingsCard(ctx, {
    connections,
    settings,
    canSeal: deps.seal !== null,
    ai: { configured: integrations.find((i) => i.name === 'anthropic')?.configured ?? null, spentDay, spentMonth },
  });
}

/** The Calls screens, and the call settings (design sections 5 and 12). */
export function callRoutes(router: Router, deps: WebDeps, ui: UiHelpers): void {
  router.get('/calls', async (req, res) => {
    const requested = text(req.query.show) as CallFilter;
    const filter = FILTERS.includes(requested) ? requested : 'all';
    const [ctx, calls, counts, connections, settings] = await Promise.all([
      ui.context(req, res),
      listCalls(deps.pool, filter, 200),
      countCalls(deps.pool),
      listConnections(deps.pool),
      getAllSettings(deps.pool),
    ]);
    res.send(
      callsPage(ctx, {
        calls,
        filter,
        counts,
        connected: connections.filter((c) => c.status === 'connected').length,
        enabled: settings['calls.enabled'],
      }),
    );
  });

  router.get('/calls/upload', ui.approver, async (req, res) => {
    res.send(uploadPage(await ui.context(req, res)));
  });

  router.post('/calls/upload', ui.approver, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const raw = typeof body.text === 'string' ? body.text : '';
    const startedText = text(body.started_at);
    const started = startedText ? new Date(startedText) : null;
    if (raw.length > MAX_UPLOAD_CHARS) {
      await ui.back(res, '/calls/upload', 'error', 'That transcript is too long to add here.');
      return;
    }
    if (started && Number.isNaN(started.getTime())) {
      await ui.back(res, '/calls/upload', 'error', 'That start time is not a date.');
      return;
    }
    const result = await ingestTranscript(deps, normalizeUpload({ title: text(body.title).slice(0, 200), startedAt: started, text: raw }), null);
    if (result.outcome === 'empty') {
      await ui.back(res, '/calls/upload', 'error', 'There is too little text in that to be a transcript.');
      return;
    }
    await recordAudit(deps.pool, { actor: ui.actorOf(res), action: 'call.upload', target: result.callId, after: { outcome: result.outcome } });
    const said =
      result.outcome === 'new_call'
        ? 'Added. It is matched to a project within a few minutes.'
        : result.outcome === 'grouped'
          ? 'Added to a call that is already here: this is a second recording of it.'
          : 'That transcript was already here.';
    await ui.back(res, `/calls/${result.callId}`, 'ok', said);
  });

  router.get('/calls/:id', async (req, res) => {
    const call = await getCall(deps.pool, String(req.params.id));
    if (!call) {
      res.status(404).send(errorPage(404, 'That call does not exist.'));
      return;
    }
    const [ctx, transcripts, matches, suggestions, recommendations, projects, users, settings, preferred] = await Promise.all([
      ui.context(req, res),
      listTranscripts(deps.pool, call.id),
      listMatches(deps.pool, call.id),
      listSuggestions(deps.pool, call.id),
      carriedRecommendations(deps.pool, call.id),
      listProjects(deps.pool),
      ui.userMap(),
      getAllSettings(deps.pool),
      preferredTranscript(deps.pool, call.id),
    ]);
    res.send(
      callPage(ctx, {
        call,
        transcripts,
        matches,
        suggestions,
        recommendations,
        agents: await listAgentRuns(deps.pool, recommendations.map((r) => r.id)),
        projects: projects.filter((p) => p.status === 'active'),
        domains: externalDomains(call, parseDomains(settings['calls.internal_domains'])),
        users,
        text: preferred?.text ?? null,
      }),
    );
  });

  router.post('/calls/:id/project', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const chosen = text(body.project_id);
    const to = `/calls/${id}`;
    if (!chosen) {
      await ui.back(res, to, 'error', 'Choose a project, or "None of these".');
      return;
    }
    const actor = ui.actorOf(res);
    const projectId = chosen === 'none' ? null : chosen;
    const result = await setCallProject(deps, { callId: id, projectId, actor, via: 'ui' });
    if (!result.ok) {
      await ui.back(res, result.reason === 'not_found' ? '/calls' : to, 'error', result.message);
      return;
    }

    // A correction can teach the registry, so the next call from the same people matches by itself.
    let taught = '';
    const session = res.locals.session as PageContext['session'];
    if (projectId && hasRole(session.user, 'owner')) {
      const [project, internal] = await Promise.all([getProject(deps.pool, projectId), getAllSettings(deps.pool)]);
      const onCall = new Set(externalDomains(result.call, parseDomains(internal['calls.internal_domains'])));
      const domains = many(body.save_domain)
        .map((d) => d.toLowerCase())
        .filter((d) => onCall.has(d));
      const alias = text(body.save_alias).slice(0, 100);
      if (project && (domains.length || alias)) {
        try {
          await updateProject(
            deps.pool,
            project.id,
            {
              name: project.name,
              client: project.client,
              status: project.status,
              description: project.description,
              aliases: [...new Set([...project.aliases, ...(alias ? [alias] : [])])],
              domains: [...new Set([...project.domains, ...domains])],
            },
            actor,
          );
          taught = ' The project was updated, so similar calls match by themselves.';
        } catch (err) {
          if (!(err instanceof RegistryError)) throw err;
          taught = ` The project itself was not updated: ${err.message}`;
        }
      }
    }
    await ui.back(
      res,
      to,
      'ok',
      result.projectName ? `Moved to ${result.projectName}. Suggestions are being drafted.${taught}` : 'Marked as belonging to no listed project.',
    );
  });

  router.post('/calls/:id/analyze', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const started = await reanalyzeCall(deps, id, ui.actorOf(res));
    if (started) await ui.back(res, `/calls/${id}`, 'ok', 'Analysing again. Reload in a minute or two.');
    else await ui.back(res, '/calls', 'error', 'That call cannot be analysed again.');
  });

  router.post('/calls/:id/post', ui.approver, async (req, res) => {
    const call = await getCall(deps.pool, String(req.params.id));
    if (!call || call.status === 'deleted') {
      await ui.back(res, '/calls', 'error', 'That call does not exist.');
      return;
    }
    await deps.queue.enqueue('calls.post', { callId: call.id });
    await ui.back(res, `/calls/${call.id}`, 'ok', 'Posting to Slack. Reload in a moment.');
  });

  // Settings -------------------------------------------------------------------------------

  router.post('/settings/calls/connections', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const [source = '', scope = 'personal'] = text(body.source).split(':');
    // Not trimmed with the rest: the key is taken as typed, less the white space a paste brings.
    const key = typeof body.key === 'string' ? body.key.replace(/\s+/g, '') : '';
    if (!deps.seal) {
      await ui.back(res, '/settings#calls', 'error', 'A key cannot be stored yet: TOKEN_PUBLIC_KEY is not set on the web service.');
      return;
    }
    if (key.length < 8 || key.length > 2000) {
      await ui.back(res, '/settings#calls', 'error', 'That does not look like a token or an API key.');
      return;
    }
    try {
      await addConnection(
        deps,
        { source, owner: text(body.owner), scope, sealedKey: deps.seal(key), importDays: Number(text(body.import_days) || 0) },
        ui.actorOf(res),
      );
      await ui.back(res, '/settings#calls', 'ok', 'Saved. The key is being checked and its webhook registered; reload in a few seconds.');
    } catch (err) {
      if (!(err instanceof ConnectionError)) throw err;
      await ui.back(res, '/settings#calls', 'error', `Not connected. ${err.message}`);
    }
  });

  router.post('/settings/calls/connections/:id/retry', ui.owner, async (req, res) => {
    try {
      await retryConnection(deps, String(req.params.id), ui.actorOf(res));
      await ui.back(res, '/settings#calls', 'ok', 'Checking the key again. Reload in a few seconds.');
    } catch (err) {
      if (!(err instanceof ConnectionError)) throw err;
      await ui.back(res, '/settings#calls', 'error', err.message);
    }
  });

  router.post('/settings/calls/connections/:id/remove', ui.owner, async (req, res) => {
    try {
      await requestRemoval(deps, String(req.params.id), ui.actorOf(res));
      await ui.back(res, '/settings#calls', 'ok', 'Removing. Its webhook is deleted at the source and its key erased; calls already collected stay.');
    } catch (err) {
      if (!(err instanceof ConnectionError)) throw err;
      await ui.back(res, '/settings#calls', 'error', err.message);
    }
  });

  router.post('/settings/calls', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const actor = ui.actorOf(res);
    try {
      const auto = Number(text(body['ai.calls.auto_match_confidence']) || NaN);
      const ask = Number(text(body['ai.calls.ask_confidence']) || NaN);
      if (Number.isFinite(auto) && Number.isFinite(ask) && ask > auto) {
        throw new SettingValidationError('The confidence for asking cannot be above the confidence for matching without asking.');
      }
      await setSetting(deps.pool, 'calls.enabled', body['calls.enabled'] === '1', actor);
      await setSetting(deps.pool, 'ai.calls.enabled', body['ai.calls.enabled'] === '1', actor);
      for (const key of ['ai.calls.model_match', 'ai.calls.model_suggest', 'ai.calls.model_brief'] as const) {
        const raw = text(body[key]);
        if (raw) await setSetting(deps.pool, key, raw, actor);
      }
      for (const key of [
        'calls.settle_minutes',
        'calls.retention_days',
        'ai.calls.auto_match_confidence',
        'ai.calls.ask_confidence',
        'ai.calls.max_suggestions',
        'ai.calls.daily_budget_usd',
        'ai.calls.monthly_budget_usd',
        'ai.calls.transcript_token_cap',
      ] as const) {
        const raw = text(body[key]);
        if (raw) await setSetting(deps.pool, key, Number(raw), actor);
      }
      const copy = text(body['calls.preferred_copy']);
      if (copy) await setSetting(deps.pool, 'calls.preferred_copy', copy as AllSettings['calls.preferred_copy'], actor);
      if (typeof body['calls.internal_domains'] === 'string') await setSetting(deps.pool, 'calls.internal_domains', text(body['calls.internal_domains']), actor);
      await ui.back(res, '/settings#calls', 'ok', 'Saved.');
    } catch (err) {
      if (!(err instanceof SettingValidationError)) throw err;
      await ui.back(res, '/settings#calls', 'error', `Not saved. ${err.message}`);
    }
  });

  // What approved tasks and follow-ups left on a project -------------------------------------

  for (const [verb, done] of [['done', true], ['reopen', false]] as const) {
    router.post(`/projects/:id/tasks/:taskId/${verb}`, ui.approver, async (req, res) => {
      const projectId = String(req.params.id);
      const changed = await setTaskDone(deps.pool, projectId, String(req.params.taskId), done, ui.actorOf(res));
      await ui.back(res, `/projects/${projectId}#tasks`, changed ? 'ok' : 'error', changed ? (done ? 'Marked done.' : 'Reopened.') : 'Nothing changed.');
    });
  }
}
