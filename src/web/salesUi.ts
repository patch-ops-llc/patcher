import type { Router } from 'express';
import { spentSince } from '../ai/run.js';
import { getCall } from '../calls/store.js';
import type { Call } from '../calls/types.js';
import { prepareFiles } from '../dealroom/files.js';
import { listIntegrations } from '../integrations/status.js';
import type { SalesResult } from '../sales/actions.js';
import { MAX_PROPOSAL_CHARS, editProposal, notADeal, refreshDealRoomOffers, regenerate, reofferDealRoom, setDealRoomSlug, setPenguin, setSalesCall, skipDealRoom } from '../sales/actions.js';
import { currentFollowUp, roomSettings } from '../sales/delivery.js';
import { parseEmails } from '../sales/penguin.js';
import {
  CatalogInputError,
  followUpFor,
  getDeal,
  getProposal,
  getSalesCall,
  listCatalog,
  listDealCalls,
  listDeals,
  listOpenSalesCalls,
  listProposals,
  listUpdates,
  offerFor,
  proposalForCall,
  proposalPdf,
  removeCatalogItem,
  saveCatalogItem,
} from '../sales/store.js';
import { getRoute } from '../settings/routes.js';
import type { AllSettings, SettingKey } from '../settings/settings.js';
import { SettingValidationError, getAllSettings, getSetting, setSetting, settingDefs } from '../settings/settings.js';
import type { UiHelpers } from './auditUi.js';
import type { WebDeps } from './deps.js';
import type { SafeHtml } from './html.js';
import { callSalesCard, catalogPage, dealPage, proposalPage, salesPage, salesSettingsCard } from './salesViews.js';
import type { PageContext } from './views.js';
import { errorPage } from './views.js';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** An edited proposal is the one long form here. Its text is at most 60,000 characters; encoding can triple that. */
export const MAX_PROPOSAL_FORM = '400kb';

/** The Sales card on the Settings screen. */
export async function salesSettings(deps: WebDeps, ctx: PageContext, settings: AllSettings): Promise<SafeHtml> {
  const [integrations, spentDay, spentMonth] = await Promise.all([listIntegrations(deps.pool), spentSince(deps.pool, 'sales', 24), spentSince(deps.pool, 'sales', 24 * 30)]);
  return salesSettingsCard(ctx, {
    settings,
    dealRoom: integrations.find((i) => i.name === 'dealroom'),
    dealRoomApi: integrations.find((i) => i.name === 'dealroom_api'),
    ai: { configured: integrations.find((i) => i.name === 'anthropic')?.configured ?? null, spentDay, spentMonth },
  });
}

/** The Sales card on a call's page. */
export async function callSales(deps: WebDeps, ctx: PageContext, call: Call): Promise<SafeHtml> {
  const sales = await getSalesCall(deps.pool, call.id);
  const proposal = sales ? await proposalForCall(deps.pool, call.id) : null;
  const deal = sales?.dealId ? await getDeal(deps.pool, sales.dealId) : null;
  return callSalesCard(ctx, { call, sales, proposal, deal });
}

/** The Sales screens and the sales settings (design sections 6 and 9). */
export function salesRoutes(router: Router, deps: WebDeps, ui: UiHelpers): void {
  const answer = async (res: Parameters<UiHelpers['back']>[0], to: string, result: SalesResult) => ui.back(res, to, result.ok ? 'ok' : 'error', result.message);

  router.get('/sales', async (req, res) => {
    const [ctx, deals, open, settings, users, route] = await Promise.all([
      ui.context(req, res),
      listDeals(deps.pool),
      listOpenSalesCalls(deps.pool),
      getAllSettings(deps.pool),
      ui.userMap(),
      getRoute(deps.pool, 'sales'),
    ]);
    res.send(salesPage(ctx, { deals, open, settings, users, hasRoute: route !== null, penguinEmails: parseEmails(settings['sales.penguin_emails']) }));
  });

  // Deals ----------------------------------------------------------------------------------

  router.get('/sales/deals/:id', async (req, res) => {
    const deal = await getDeal(deps.pool, String(req.params.id));
    if (!deal) {
      res.status(404).send(errorPage(404, 'That deal does not exist.'));
      return;
    }
    const [ctx, proposals, updates, calls, users, repo, integrations, room] = await Promise.all([
      ui.context(req, res),
      listProposals(deps.pool, deal.id),
      listUpdates(deps.pool, deal.id),
      listDealCalls(deps.pool, deal.id),
      ui.userMap(),
      getSetting(deps.pool, 'sales.dealroom_repo'),
      listIntegrations(deps.pool),
      roomSettings(deps.pool),
    ]);
    res.send(
      dealPage(ctx, {
        deal,
        proposals,
        updates,
        calls,
        users,
        repo,
        room,
        dealRoom: integrations.find((i) => i.name === (room.route === 'api' ? 'dealroom_api' : 'dealroom')),
      }),
    );
  });

  router.post('/sales/deals/:id/penguin', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const choice = text((req.body as Record<string, unknown>).penguin);
    if (choice !== 'yes' && choice !== 'no') {
      await ui.back(res, `/sales/deals/${id}`, 'error', 'Choose Penguin or not Penguin.');
      return;
    }
    await answer(res, `/sales/deals/${id}`, await setPenguin(deps, { dealId: id, penguin: choice === 'yes', actor: ui.actorOf(res), via: 'ui' }));
  });

  router.post('/sales/deals/:id/slug', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const slug = text((req.body as Record<string, unknown>).slug);
    await answer(res, `/sales/deals/${id}#dealroom`, await setDealRoomSlug(deps, { dealId: id, slug, actor: ui.actorOf(res), via: 'ui' }));
  });

  router.post('/sales/deals/:id/skip', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    await answer(res, `/sales/deals/${id}#dealroom`, await skipDealRoom(deps, { dealId: id, actor: ui.actorOf(res), via: 'ui' }));
  });

  // Proposals ------------------------------------------------------------------------------

  router.get('/sales/proposals/:id', async (req, res) => {
    const proposal = await getProposal(deps.pool, String(req.params.id));
    const deal = proposal ? await getDeal(deps.pool, proposal.dealId) : null;
    if (!proposal || !deal) {
      res.status(404).send(errorPage(404, 'That proposal does not exist.'));
      return;
    }
    const [ctx, call, sales, offer, updates, versions, users, currency, room] = await Promise.all([
      ui.context(req, res),
      proposal.callId ? getCall(deps.pool, proposal.callId) : Promise.resolve(null),
      proposal.callId ? getSalesCall(deps.pool, proposal.callId) : Promise.resolve(null),
      offerFor(deps.pool, proposal.id),
      listUpdates(deps.pool, deal.id),
      listProposals(deps.pool, deal.id),
      ui.userMap(),
      getSetting(deps.pool, 'sales.currency'),
      roomSettings(deps.pool),
    ]);
    const viaApi = room.route === 'api';
    const toRoom = deal.isPenguin === true && !deal.dealRoomSkipped && proposal.status === 'draft' && (viaApi || Boolean(deal.dealRoomSlug));
    const describe = (rec: { action: Parameters<typeof deps.catalog.describe>[0] } | null): string | null => {
      if (!rec) return null;
      try {
        return deps.catalog.describe(rec.action);
      } catch {
        return null;
      }
    };
    const offerDescription = describe(offer);
    const own = updates.filter((u) => u.proposalId === proposal.id);
    const update = own[0] ?? null;
    // The approval that follows the deal room update, when it is the one the room calls for now.
    const followUp = update ? currentFollowUp({ deal, proposal, update, room, followUp: await followUpFor(deps.pool, update.id) }) : null;
    res.send(
      proposalPage(ctx, {
        proposal,
        deal,
        call,
        sales,
        offer,
        offerDescription,
        updates: own,
        versions,
        files: toRoom ? prepareFiles({ ...(viaApi ? {} : { slug: deal.dealRoomSlug! }), title: proposal.title, contentMd: proposal.contentMd }) : null,
        room,
        followUp,
        followUpDescription: describe(followUp),
        users,
        currency,
      }),
    );
  });

  router.get('/sales/proposals/:id/pdf', async (req, res) => {
    const found = await proposalPdf(deps.pool, String(req.params.id));
    if (!found) {
      res.status(404).send(errorPage(404, 'That proposal has no PDF.'));
      return;
    }
    const filename = `${found.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'proposal'}-v${found.version}.pdf`;
    res
      .status(200)
      .set({
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${filename}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      })
      .send(found.pdf);
  });

  router.post('/sales/proposals/:id/edit', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const contentMd = typeof body.content_md === 'string' ? body.content_md.replace(/\r\n?/g, '\n') : '';
    if (contentMd.length > MAX_PROPOSAL_CHARS) {
      await ui.back(res, `/sales/proposals/${id}`, 'error', 'That is too long for a proposal.');
      return;
    }
    const result = await editProposal(deps, { proposalId: id, contentMd, actor: ui.actorOf(res), via: 'ui' });
    await ui.back(res, `/sales/proposals/${result.ok && result.proposal ? result.proposal.id : id}`, result.ok ? 'ok' : 'error', result.message);
  });

  // The calls behind them ------------------------------------------------------------------

  const afterCall = async (callId: string): Promise<string> => {
    const proposal = await proposalForCall(deps.pool, callId);
    return proposal ? `/sales/proposals/${proposal.id}` : `/calls/${callId}#sales`;
  };

  router.post('/sales/calls/:id/type', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const choice = text((req.body as Record<string, unknown>).sales);
    if (choice !== 'yes' && choice !== 'no') {
      await ui.back(res, `/calls/${id}#sales`, 'error', 'Choose whether it was a sales call.');
      return;
    }
    await answer(res, `/calls/${id}#sales`, await setSalesCall(deps, { callId: id, sales: choice === 'yes', actor: ui.actorOf(res), via: 'ui' }));
  });

  router.post('/sales/calls/:id/regenerate', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const result = await regenerate(deps, { callId: id, actor: ui.actorOf(res), via: 'ui', ...(typeof body.note === 'string' ? { note: body.note } : {}) });
    await answer(res, await afterCall(id), result);
  });

  router.post('/sales/calls/:id/not-deal', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    await answer(res, await afterCall(id), await notADeal(deps, { callId: id, actor: ui.actorOf(res), via: 'ui' }));
  });

  router.post('/sales/calls/:id/reoffer', ui.approver, async (req, res) => {
    const id = String(req.params.id);
    await answer(res, await afterCall(id), await reofferDealRoom(deps, { callId: id, actor: ui.actorOf(res), via: 'ui' }));
  });

  router.post('/sales/calls/:id/post', ui.approver, async (req, res) => {
    const sales = await getSalesCall(deps.pool, String(req.params.id));
    if (!sales) {
      await ui.back(res, '/sales', 'error', 'That call is not in the sales pipeline.');
      return;
    }
    await deps.queue.enqueue('sales.post', { callId: sales.callId });
    await ui.back(res, '/sales', 'ok', 'Posting to Slack. Reload in a moment.');
  });

  // Template and rate card -----------------------------------------------------------------

  router.get('/sales/catalog', async (req, res) => {
    const [ctx, catalog, settings] = await Promise.all([ui.context(req, res), listCatalog(deps.pool), getAllSettings(deps.pool)]);
    res.send(catalogPage(ctx, { catalog, template: settings['sales.proposal_template'], currency: settings['sales.currency'] }));
  });

  router.post('/sales/catalog', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const saved = await saveCatalogItem(
        deps.pool,
        { key: text(body.key).toLowerCase(), name: text(body.name), description: text(body.description), unit: text(body.unit) || 'fixed', price: text(body.price), active: body.active === '1' },
        ui.actorOf(res),
      );
      await ui.back(res, '/sales/catalog', 'ok', `Saved ${saved.name}. New drafts use it; proposals already drafted keep their prices.`);
    } catch (err) {
      if (!(err instanceof CatalogInputError)) throw err;
      await ui.back(res, '/sales/catalog', 'error', `Not saved. ${err.message}`);
    }
  });

  router.post('/sales/catalog/:id/remove', ui.owner, async (req, res) => {
    const removed = await removeCatalogItem(deps.pool, String(req.params.id), ui.actorOf(res));
    await ui.back(res, '/sales/catalog', removed ? 'ok' : 'error', removed ? 'Removed.' : 'That service is not in the catalog.');
  });

  router.post('/sales/template', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      await setSetting(deps.pool, 'sales.proposal_template', typeof body.template === 'string' ? body.template.replace(/\r\n?/g, '\n') : '', ui.actorOf(res));
      await ui.back(res, '/sales/catalog#template', 'ok', 'Saved. New drafts use it.');
    } catch (err) {
      if (!(err instanceof SettingValidationError)) throw err;
      await ui.back(res, '/sales/catalog#template', 'error', `Not saved. ${err.message}`);
    }
  });

  // Settings -------------------------------------------------------------------------------

  router.post('/settings/sales', ui.owner, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const actor = ui.actorOf(res);
    try {
      const auto = Number(text(body['ai.sales.auto_confidence']) || NaN);
      const ask = Number(text(body['ai.sales.ask_confidence']) || NaN);
      if (Number.isFinite(auto) && Number.isFinite(ask) && ask > auto) {
        throw new SettingValidationError('The confidence for asking cannot be above the confidence for drafting without asking.');
      }
      const changes: [SettingKey, unknown][] = [
        ['sales.enabled', body['sales.enabled'] === '1'],
        ['ai.sales.enabled', body['ai.sales.enabled'] === '1'],
        // An unticked box sends nothing, so the publish setting is off unless the form says on.
        ['sales.dealroom_publish', body['sales.dealroom_publish'] === '1'],
      ];
      const before = await roomSettings(deps.pool);
      const route = text(body['sales.dealroom_route']) || before.route;
      const address = typeof body['sales.dealroom_url'] === 'string' ? text(body['sales.dealroom_url']) : before.origin;
      if (route === 'api' && !address) throw new SettingValidationError('The service API needs the address of the deal room.');
      changes.push(['sales.dealroom_route', route], ['sales.dealroom_url', address]);
      for (const key of ['sales.penguin_emails', 'sales.title_patterns'] as const) {
        if (typeof body[key] === 'string') changes.push([key, text(body[key])]);
      }
      for (const key of ['sales.dealroom_repo', 'sales.currency', 'ai.sales.model_classify', 'ai.sales.model_brief', 'ai.sales.model_draft', 'ai.sales.model_check'] as const) {
        const raw = text(body[key]);
        if (raw) changes.push([key, raw]);
      }
      for (const key of ['ai.sales.auto_confidence', 'ai.sales.ask_confidence', 'ai.sales.daily_budget_usd', 'ai.sales.monthly_budget_usd'] as const) {
        const raw = text(body[key]);
        if (raw) changes.push([key, Number(raw)]);
      }
      // All or nothing: one bad value saves none of the form, so "Not saved" is true of all of it.
      for (const [key, value] of changes) {
        const parsed = settingDefs[key].schema.safeParse(value);
        if (!parsed.success) throw new SettingValidationError(`${settingDefs[key].label}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
      }
      for (const [key, value] of changes) await setSetting(deps.pool, key, value, actor);
      const after = await roomSettings(deps.pool);
      if (after.route !== before.route || after.origin !== before.origin || after.publish !== before.publish) {
        // What was waiting was offered under the old setting. It is closed and offered again under the new one.
        await refreshDealRoomOffers(deps, actor, 'Closed: the deal room settings changed.');
      }
      await ui.back(res, '/settings#sales', 'ok', 'Saved.');
    } catch (err) {
      if (!(err instanceof SettingValidationError)) throw err;
      await ui.back(res, '/settings#sales', 'error', `Not saved. ${err.message}`);
    }
  });
}
