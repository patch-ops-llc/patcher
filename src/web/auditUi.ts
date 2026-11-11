import type { Request, RequestHandler, Response, Router } from 'express';
import { fixAvailability, listAgentRuns, proposeFix } from '../fix/agentFix.js';
import { isConfigured, listIntegrations } from '../integrations/status.js';
import { lastInventorySync, listRailwayProjects } from '../railway/inventory.js';
import { RecommendationInputError, getRecommendation } from '../recommendations/service.js';
import type { LinkKind } from '../registry/registry.js';
import {
  LINK_KINDS,
  RegistryError,
  addCheck,
  addLink,
  createProject,
  deleteProject,
  getProject,
  importRailwayProjects,
  listProjects,
  removeCheck,
  removeLink,
  updateProject,
} from '../registry/registry.js';
import type { User } from '../settings/users.js';
import { getAuditRun, listAuditRuns } from '../weekly/delivery.js';
import type { FindingState } from '../weekly/findings.js';
import { FINDING_STATES, FindingStateError, getFinding, listFindings, setFindingState } from '../weekly/findings.js';
import { requestAudit } from '../weekly/request.js';
import { auditRunPage, auditsPage, findingPage, projectPage, projectsPage } from './auditViews.js';
import type { WebDeps } from './deps.js';
import type { PageContext } from './views.js';
import { errorPage } from './views.js';

/** What these screens share with the rest of the control UI. */
export interface UiHelpers {
  context(req: Request, res: Response): Promise<PageContext>;
  back(res: Response, to: string, kind: 'ok' | 'error', message: string): Promise<void>;
  actorOf(res: Response): string;
  userMap(): Promise<Map<string, User>>;
  owner: RequestHandler;
  approver: RequestHandler;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const commaList = (value: unknown): string[] =>
  text(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const many = (value: unknown): string[] => (Array.isArray(value) ? value.map(text) : [text(value)]).filter(Boolean);

/** The Audits and Projects screens (design section 12). */
export function auditRoutes(router: Router, deps: WebDeps, ui: UiHelpers): void {
  // Audits ---------------------------------------------------------------------------------

  router.get('/audits', async (req, res) => {
    const requested = text(req.query.state);
    const state: FindingState = (FINDING_STATES as readonly string[]).includes(requested) ? (requested as FindingState) : 'open';
    const [ctx, runs, findings, counts, integrations] = await Promise.all([
      ui.context(req, res),
      listAuditRuns(deps.pool),
      listFindings(deps.pool, [state]),
      deps.pool.query<{ state: FindingState; n: string }>('SELECT state, count(*) AS n FROM audit_findings GROUP BY state'),
      listIntegrations(deps.pool),
    ]);
    const stateCounts = { open: 0, resolved: 0, muted: 0, accepted: 0 };
    for (const row of counts.rows) stateCounts[row.state] = Number(row.n);
    res.send(auditsPage(ctx, { runs, findings, state, stateCounts, integrations }));
  });

  router.post('/audits/run', ui.approver, async (_req, res) => {
    const result = await requestAudit(deps, ui.actorOf(res));
    if (result.started) await ui.back(res, '/audits', 'ok', 'Audit started. It takes a few minutes; the report appears here and in Slack.');
    else await ui.back(res, '/audits', 'error', result.reason);
  });

  router.get('/audits/findings/:id', async (req, res) => {
    const finding = await getFinding(deps.pool, String(req.params.id));
    if (!finding) {
      res.status(404).send(errorPage(404, 'That finding does not exist.'));
      return;
    }
    const [ctx, fixes, recommendation, users] = await Promise.all([
      ui.context(req, res),
      fixAvailability(deps.pool, [finding], await isConfigured(deps.pool, 'cursor')),
      finding.recommendationId ? getRecommendation(deps.pool, finding.recommendationId) : Promise.resolve(null),
      ui.userMap(),
    ]);
    const agents = recommendation ? await listAgentRuns(deps.pool, [recommendation.id]) : [];
    const stateBy = finding.stateBy ?? '';
    res.send(
      findingPage(ctx, {
        finding,
        fix: fixes.get(finding.id) ?? { status: 'none' },
        recommendation,
        agents,
        stateByName: users.get(stateBy)?.displayName ?? stateBy,
      }),
    );
  });

  router.post('/audits/findings/:id/state', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const state = text(body.state);
    try {
      if (state !== 'open' && state !== 'muted' && state !== 'accepted') throw new FindingStateError('Unknown state.');
      await setFindingState(deps.pool, id, state, ui.actorOf(res), text(body.note));
      await ui.back(res, `/audits/findings/${id}`, 'ok', state === 'open' ? 'Reopened.' : state === 'muted' ? 'Muted.' : 'Accepted.');
    } catch (err) {
      if (!(err instanceof FindingStateError)) throw err;
      await ui.back(res, '/audits', 'error', err.message);
    }
  });

  router.post('/audits/findings/:id/fix', ui.approver, async (req, res) => {
    const finding = await getFinding(deps.pool, String(req.params.id));
    if (!finding) {
      await ui.back(res, '/audits', 'error', 'That finding does not exist.');
      return;
    }
    const to = `/audits/findings/${finding.id}`;
    const fix = (await fixAvailability(deps.pool, [finding], await isConfigured(deps.pool, 'cursor'))).get(finding.id);
    if (finding.state !== 'open' || fix?.status !== 'available') {
      await ui.back(res, to, 'error', `A fix cannot be proposed${fix?.reason ? `: ${fix.reason}` : ' for this finding right now'}.`);
      return;
    }
    try {
      // The key carries the last audit that saw the finding: one proposal per finding per audit.
      const { recommendation } = await proposeFix(deps, finding, {
        createdBy: ui.actorOf(res),
        dedupeKey: `finding:${finding.id}:${finding.lastRun ?? 'none'}`,
      });
      await ui.back(res, `/approvals/${recommendation.id}`, 'ok', 'Fix drafted. It is posted to Slack for approval within a few seconds.');
    } catch (err) {
      if (!(err instanceof RecommendationInputError)) throw err;
      await ui.back(res, to, 'error', err.message);
    }
  });

  router.get('/audits/:id', async (req, res) => {
    const run = await getAuditRun(deps.pool, String(req.params.id));
    if (!run) {
      res.status(404).send(errorPage(404, 'That audit does not exist.'));
      return;
    }
    res.send(auditRunPage(await ui.context(req, res), { run }));
  });

  router.post('/audits/:id/post', ui.approver, async (req, res) => {
    const run = await getAuditRun(deps.pool, String(req.params.id));
    if (!run || run.status !== 'done' || run.postedAt) {
      await ui.back(res, '/audits', 'error', 'That audit is not waiting to be posted.');
      return;
    }
    await deps.queue.enqueue('audit.report.post', { runId: run.id });
    await ui.back(res, `/audits/${run.id}`, 'ok', 'Posting to Slack. Reload in a moment.');
  });

  // Projects -------------------------------------------------------------------------------

  router.get('/projects', async (req, res) => {
    const [ctx, projects, railway, integrations, inventoryAt] = await Promise.all([
      ui.context(req, res),
      listProjects(deps.pool),
      listRailwayProjects(deps.pool),
      listIntegrations(deps.pool),
      lastInventorySync(deps.pool),
    ]);
    const linked = new Set(projects.flatMap((p) => p.links.filter((l) => l.kind === 'railway_project').map((l) => l.externalId)));
    res.send(projectsPage(ctx, { projects, unlinked: railway.filter((p) => !linked.has(p.id)), integrations, inventoryAt }));
  });

  /** Runs a registry change and turns a refusal into a message instead of an error page. */
  const change = async (res: Response, to: string, ok: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await ui.back(res, to, 'ok', ok);
    } catch (err) {
      if (!(err instanceof RegistryError)) throw err;
      await ui.back(res, to, 'error', `Not saved. ${err.message}`);
    }
  };

  router.post('/projects', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const id = await createProject(deps.pool, { name: text(body.name), client: text(body.client) }, ui.actorOf(res));
      await ui.back(res, `/projects/${id}`, 'ok', 'Project added. Link its Railway project and repositories below.');
    } catch (err) {
      if (!(err instanceof RegistryError)) throw err;
      await ui.back(res, '/projects', 'error', `Not added. ${err.message}`);
    }
  });

  router.post('/projects/import', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const linked = new Set(
      (await listProjects(deps.pool)).flatMap((p) => p.links.filter((l) => l.kind === 'railway_project').map((l) => l.externalId)),
    );
    const available = (await listRailwayProjects(deps.pool)).filter((p) => !linked.has(p.id)).map((p) => p.id);
    const chosen = body.all === '1' ? available : many(body.railway_project).filter((id) => available.includes(id));
    if (!chosen.length) {
      await ui.back(res, '/projects#railway', 'error', 'Nothing was selected.');
      return;
    }
    const { created, skipped } = await importRailwayProjects(deps.pool, chosen, ui.actorOf(res));
    const note = skipped.length ? ` Skipped, because a project with that name exists: ${skipped.join(', ')}.` : '';
    await ui.back(res, '/projects', created ? 'ok' : 'error', `${created} imported.${note}`);
  });

  router.get('/projects/:id', async (req, res) => {
    const project = await getProject(deps.pool, String(req.params.id));
    if (!project) {
      res.status(404).send(errorPage(404, 'That project does not exist.'));
      return;
    }
    const railway = await listRailwayProjects(deps.pool);
    res.send(projectPage(await ui.context(req, res), { project, railwayNames: new Map(railway.map((p) => [p.id, p.name])) }));
  });

  router.post('/projects/:id', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const status = text(body.status);
    await change(res, `/projects/${id}`, 'Saved.', () =>
      updateProject(
        deps.pool,
        id,
        {
          name: text(body.name),
          client: text(body.client),
          status: status === 'paused' || status === 'archived' ? status : 'active',
          description: text(body.description),
          aliases: commaList(body.aliases),
          domains: commaList(body.domains),
        },
        ui.actorOf(res),
      ),
    );
  });

  router.post('/projects/:id/delete', ui.owner, async (req, res) => {
    await change(res, '/projects', 'Project removed.', () => deleteProject(deps.pool, String(req.params.id), ui.actorOf(res)));
  });

  router.post('/projects/:id/links', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const kind = text(body.kind);
    await change(res, `/projects/${id}#links`, 'Linked.', () => {
      if (!(LINK_KINDS as readonly string[]).includes(kind)) throw new RegistryError('Unknown kind of link.');
      return addLink(deps.pool, id, kind as LinkKind, text(body.external_id), ui.actorOf(res));
    });
  });

  router.post('/projects/:id/links/:linkId/remove', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    await change(res, `/projects/${id}#links`, 'Link removed.', () =>
      removeLink(deps.pool, id, String(req.params.linkId), ui.actorOf(res)),
    );
  });

  router.post('/projects/:id/checks', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    await change(res, `/projects/${id}#checks`, 'Check added. It is probed within five minutes.', () => {
      let expectJson: Record<string, unknown> | null = null;
      const raw = text(body.expect_json);
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          expectJson = parsed as Record<string, unknown>;
        } catch {
          throw new RegistryError('The expected JSON must be an object, for example {"ok": true}.');
        }
      }
      return addCheck(
        deps.pool,
        id,
        { name: text(body.name), url: text(body.url), expectStatus: Number(text(body.expect_status) || 200), expectJson },
        ui.actorOf(res),
      );
    });
  });

  router.post('/projects/:id/checks/:checkId/remove', ui.owner, async (req, res) => {
    const id = String(req.params.id);
    await change(res, `/projects/${id}#checks`, 'Check removed.', () =>
      removeCheck(deps.pool, id, String(req.params.checkId), ui.actorOf(res)),
    );
  });
}
