import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestTranscript } from '../src/calls/ingest.js';
import { createRepoAdapter } from '../src/dealroom/adapter.js';
import { createDealRoomRepo } from '../src/dealroom/github.js';
import { recordConfigured } from '../src/integrations/status.js';
import { syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { listApprovals } from '../src/recommendations/service.js';
import { DEALROOM_PR_ACTION, FINALIZE_ACTION } from '../src/sales/catalog.js';
import { postSales } from '../src/sales/delivery.js';
import { classifyCall, draftProposal } from '../src/sales/pipeline.js';
import { getDeal, getSalesCall, listCatalog, listProposals, listUpdates, offerFor, proposalForCall } from '../src/sales/store.js';
import type { Deal, Proposal } from '../src/sales/types.js';
import { DEFAULT_PROPOSAL_TEMPLATE, getAllSettings, setSetting } from '../src/settings/settings.js';
import { createApp } from '../src/web/app.js';
import { transcript } from './fixtures/calls.js';
import { FakeModel } from './fixtures/model.js';
import { APP_KEY, DEALROOM_REPO, FakeGitHub, PENGUIN, briefAnswer, classifyAnswer, cleanCheck, draftAnswer, prospect, salesCall, seedCatalog } from './fixtures/sales.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, VIEWER, addUser, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The control UI for sales: the list, a deal, a proposal with approve, edit and dismiss,
 * the template and rate card, and the settings. The model, Slack and GitHub are stand-ins.
 */
const pool = testPool();
const PENGUIN_HOST = { hostEmail: PENGUIN, attendees: [{ name: 'Morgan Host', email: PENGUIN, external: false }, prospect.jo, prospect.lee] };

let h: Harness;
let model: FakeModel;
let github: FakeGitHub;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;

async function setup(options: { dealRoom?: boolean } = {}) {
  model = new FakeModel();
  github = new FakeGitHub();
  const dealRoom = options.dealRoom === false ? null : createRepoAdapter(createDealRoomRepo({ appId: '4242', privateKey: APP_KEY, installationId: '777', fetch: github.fetch }));
  const integrations = testIntegrations({ model, dealRoom });
  await recordConfigured(pool, integrations.status);
  h = harness(pool, { integrations });
  deps = webDeps(h);
  app = createApp(deps);
}

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'sales', 'C0SALES');
  await setSetting(pool, 'calls.internal_domains', 'agency.example', OWNER);
  await setSetting(pool, 'sales.penguin_emails', PENGUIN, OWNER);
  await setSetting(pool, 'sales.dealroom_repo', DEALROOM_REPO, OWNER);
  await seedCatalog(pool, OWNER);
  await setup();
});
afterAll(() => pool.end());

const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)![1]!;

async function signIn(userId: string) {
  deps.oidc.identity = { teamId: HUB, userId, name: null, email: null };
  const agent = request.agent(app);
  await agent.get('/auth/slack');
  await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState }).expect(302);
  const csrf = csrfOf((await agent.get('/settings').expect(200)).text);
  const post = (path: string, fields: Record<string, string | string[]> = {}) => agent.post(path).type('form').send({ _csrf: csrf, ...fields });
  /** Posts, follows the redirect and returns the page, which shows the outcome message. */
  const submit = async (path: string, fields: Record<string, string | string[]> = {}) => {
    const res = await post(path, fields).expect(303);
    const location = res.headers.location!;
    return { location, page: (await agent.get(location.split('#')[0]!)).text };
  };
  return { agent, post, submit };
}

/** Runs what was enqueued, the way the worker would. */
async function work(): Promise<void> {
  for (let round = 0; round < 12 && h.queue.jobs.length; round += 1) {
    const jobs = h.queue.jobs.splice(0);
    for (const job of jobs) {
      const data = job.data as Record<string, string>;
      if (job.name === 'sales.classify') await classifyCall(h.worker, data.callId!);
      else if (job.name === 'sales.draft') await draftProposal(h.worker, data.callId!);
      else if (job.name === 'sales.post') await postSales(h.worker, data.callId!);
      else if (job.name === 'action.execute') await executeAction(h.worker, data.actionId!);
      else if (job.name === 'recommendation.sync') await syncMessage(h.worker, data.recommendationId!);
    }
  }
}

async function received(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await ingestTranscript(h, transcript(salesCall(overrides)), null);
  h.queue.clear();
  return (result as { callId: string }).callId;
}

async function drafted(overrides: Record<string, unknown> = {}): Promise<{ callId: string; proposal: Proposal; deal: Deal }> {
  const callId = await received(overrides);
  model.on('record_call_type', classifyAnswer()).on('record_deal_brief', briefAnswer()).on('record_proposal', draftAnswer()).on('record_grounding_check', cleanCheck());
  await classifyCall(h.worker, callId);
  await work();
  const proposal = (await proposalForCall(pool, callId))!;
  return { callId, proposal, deal: (await getDeal(pool, proposal.dealId))! };
}

describe('the Sales screen', () => {
  it('is in the navigation and says what is missing before anything has happened', async () => {
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'sales'`);
    await setSetting(pool, 'sales.penguin_emails', '', OWNER);
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get('/sales').expect(200)).text;
    expect(page).toContain('<a href="/sales"');
    expect(page).toContain('No channel is set for Sales reports');
    expect(page).toContain('Nothing is waiting.');
    expect(page).toContain('No deal yet.');
    expect(page).toContain('None saved, so the rule marks nothing');
    await request(app).get('/sales').expect(302);
  });

  it('lists the deals with their Penguin mark, proposal and deal room state', async () => {
    const { deal, proposal } = await drafted(PENGUIN_HOST);
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get('/sales').expect(200)).text;
    expect(page).toContain(`<a href="/sales/deals/${deal.id}">Larkfield Outfitters</a>`);
    expect(page).toContain('larkfield.example');
    expect(page).toContain('Penguin deal');
    expect(page).toContain('a Penguin address hosted or recorded the call');
    expect(page).toContain(`<a href="/sales/proposals/${proposal.id}">v1</a>`);
    expect(page).toContain('no slug yet');
    expect(page).toContain(`<code>${PENGUIN}</code>`);
  });

  it('shows a call that is waiting for an answer, with the buttons for an approver only', async () => {
    const callId = await received();
    model.on('record_call_type', classifyAnswer('sales_discovery', 0.6));
    await classifyCall(h.worker, callId);
    await work();

    const viewer = await signIn(VIEWER);
    const seen = (await viewer.agent.get('/sales').expect(200)).text;
    expect(seen).toContain('Asked: sales call?');
    expect(seen).toContain('This looks like a sales call (0.60).');
    expect(seen).not.toContain('Yes, draft proposal');
    await viewer.post(`/sales/calls/${callId}/type`, { sales: 'yes' }).expect(403);

    const approver = await signIn(APPROVER);
    expect((await approver.agent.get('/sales')).text).toContain('Yes, draft proposal');
    const { page } = await approver.submit(`/sales/calls/${callId}/type`, { sales: 'yes' });
    expect(page).toContain('Drafting the proposal.');
    expect(await getSalesCall(pool, callId)).toMatchObject({ state: 'drafting', decidedBy: APPROVER });
    expect(h.queue.of('sales.draft')).toEqual([{ callId }]);
  });
});

describe('a call\'s page', () => {
  it('shows the type the model read and lets an approver mark a call the model missed', async () => {
    const callId = await received();
    model.on('record_call_type', classifyAnswer('client_delivery', 0.84));
    await classifyCall(h.worker, callId);

    const { agent, submit } = await signIn(APPROVER);
    const page = (await agent.get(`/calls/${callId}`).expect(200)).text;
    expect(page).toContain('Call type and sales');
    expect(page).toContain('Client delivery (0.84)');
    expect(page).toContain('Treat as a sales call');
    expect((await agent.get('/calls').expect(200)).text).toContain('Client delivery (0.84)');

    const marked = await submit(`/sales/calls/${callId}/type`, { sales: 'yes' });
    expect(marked.page).toContain('Sales: discovery (set by a person)');
    expect(marked.page).toContain('Drafting');
    expect(await auditActions(pool)).toContain('call.type.set');

    model.on('record_deal_brief', briefAnswer()).on('record_proposal', draftAnswer()).on('record_grounding_check', cleanCheck());
    await work();
    const after = (await agent.get(`/calls/${callId}`)).text;
    const proposal = (await proposalForCall(pool, callId))!;
    expect(after).toContain(`<a href="/sales/proposals/${proposal.id}">Proposal v1</a>`);
    // The addresses the rule read are shown per recording.
    expect(after).toContain('Addresses it carried');
  });
});

describe('a proposal', () => {
  it('shows the text, what to check, the brief with its quotes, the rate card lines, and the PDF behind sign-in', async () => {
    const { proposal, deal } = await drafted();
    const { agent } = await signIn(VIEWER);
    const page = (await agent.get(`/sales/proposals/${proposal.id}`).expect(200)).text;
    expect(page).toContain('Order-to-billing sync for Larkfield Outfitters');
    expect(page).toContain('<strong>Gaps:</strong> start date, budget, price for Support plan.');
    expect(page).toContain('&quot;Pricing&quot; section was left out');
    expect(page).toContain('Our orders live in a spreadsheet and get typed into the billing system by hand.');
    expect(page).toContain('(at 00:01:10)');
    expect(page).toContain('$12,000');
    expect(page).toContain('Not a Penguin deal');
    expect(page).toContain(`href="/sales/deals/${deal.id}"`);
    // A viewer reads; the forms are for approvers.
    expect(page).toContain('Waiting for an approver.');
    expect(page).not.toContain('Save as a new version');
    // What the model wrote is shown as text, never as markup.
    expect(page).not.toContain('<script>alert');

    const pdf = await agent.get(`/sales/proposals/${proposal.id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('inline; filename="Order-to-billing-sync-for-Larkfield-Outfitters-v1.pdf"');
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    await request(app).get(`/sales/proposals/${proposal.id}/pdf`).expect(302);
    await agent.get('/sales/proposals/not-an-id').expect(404);
    await agent.get('/sales/proposals/00000000-0000-4000-8000-000000000000/pdf').expect(404);
  });

  it('is approved from the UI by an approver, which makes it final', async () => {
    const { proposal, callId } = await drafted();
    const offer = (await offerFor(pool, proposal.id))!;
    const viewer = await signIn(VIEWER);
    await viewer.post(`/approvals/${offer.id}/approve`, { hash: offer.actionHash }).expect(403);

    const { agent, post } = await signIn(APPROVER);
    const page = (await agent.get(`/sales/proposals/${proposal.id}`).expect(200)).text;
    expect(page).toContain('Mark proposal v1 for Larkfield Outfitters as final');
    expect(page).toContain(`action="/approvals/${offer.id}/approve"`);
    await post(`/approvals/${offer.id}/approve`, { hash: offer.actionHash }).expect(303);
    await work();

    expect(await proposalForCall(pool, callId)).toMatchObject({ status: 'final', finalizedBy: APPROVER });
    expect((await listApprovals(pool, offer.id)).map((a) => `${a.decision}/${a.via}`)).toEqual(['approved/ui']);
    const after = (await agent.get(`/sales/proposals/${proposal.id}`)).text;
    expect(after).toContain('Final, approved by');
    expect(after).toContain('Patcher sends nothing to the prospect');
  });

  it('saves an edit as a new version with the same rules as a draft, and the old approval no longer applies', async () => {
    const { proposal, deal } = await drafted();
    const before = (await offerFor(pool, proposal.id))!;
    const viewer = await signIn(VIEWER);
    await viewer.post(`/sales/proposals/${proposal.id}/edit`, { content_md: '# T\n\n## One\n\nText.' }).expect(403);

    const { agent, post, submit } = await signIn(APPROVER);
    expect((await agent.get(`/sales/proposals/${proposal.id}`)).text).toContain('Save as a new version');
    const edited = `${proposal.contentMd.replace('## Summary', '## Summary\n\nAdded by a person. ![pixel](https://tracker.example/p.png)')}`;
    const saved = await submit(`/sales/proposals/${proposal.id}/edit`, { content_md: edited.replace(/\n/g, '\r\n') });
    const versions = await listProposals(pool, deal.id);
    expect(versions.map((p) => `v${p.version} ${p.status} ${p.createdBy}`)).toEqual([`v2 draft ${APPROVER}`, 'v1 superseded system']);
    expect(saved.location).toBe(`/sales/proposals/${versions[0]!.id}`);
    expect(saved.page).toContain('Saved as v2. Removed from the edit:');
    expect(versions[0]!.contentMd).toContain('Added by a person.');
    expect(versions[0]!.contentMd).not.toMatch(/!\[|\r/);
    expect((await offerFor(pool, proposal.id))!.status).toBe('expired');

    // The approval of the version that was replaced is refused.
    await post(`/approvals/${before.id}/approve`, { hash: before.actionHash });
    await work();
    expect((await listProposals(pool, deal.id)).map((p) => p.status)).toEqual(['draft', 'superseded']);
    expect((await agent.get(`/sales/proposals/${proposal.id}`)).text).toContain('A newer version replaced this one.');

    // What cannot be saved.
    expect((await submit(`/sales/proposals/${versions[0]!.id}/edit`, { content_md: 'Only words, no section.' })).page).toContain('A proposal needs at least one section');
    expect((await submit(`/sales/proposals/${versions[0]!.id}/edit`, { content_md: versions[0]!.contentMd })).page).toContain('Nothing changed.');
    expect((await submit(`/sales/proposals/${proposal.id}/edit`, { content_md: '# T\n\n## One\n\nText.' })).page).toContain('This is not the current version.');
    expect((await submit(`/sales/proposals/${versions[0]!.id}/edit`, { content_md: `# T\n\n## One\n\n${'word '.repeat(13_000)}` })).page).toContain('That is too long for a proposal.');
    expect(await listProposals(pool, deal.id)).toHaveLength(2);
    expect(await auditActions(pool)).toContain('proposal.edit');
  });

  it('is dismissed with "Not a deal", and drafted again with a note', async () => {
    const { proposal, callId, deal } = await drafted();
    const { submit, agent } = await signIn(APPROVER);

    const again = await submit(`/sales/calls/${callId}/regenerate`, { note: 'Lead with the dashboard.' });
    expect(again.page).toContain('Drafting again.');
    await work();
    const v2 = (await listProposals(pool, deal.id))[0]!;
    expect(v2).toMatchObject({ version: 2, status: 'draft', note: 'Lead with the dashboard.' });
    expect(model.sent('record_proposal')[1]!.user).toContain('Lead with the dashboard.');
    expect((await agent.get(`/sales/deals/${deal.id}`)).text).toContain('asked: Lead with the dashboard.');

    const offer = (await offerFor(pool, v2.id))!;
    const gone = await submit(`/sales/calls/${callId}/not-deal`);
    expect(gone.page).toContain('Marked. Nothing more is drafted from this call.');
    expect((await offerFor(pool, v2.id))!).toMatchObject({ id: offer.id, status: 'dismissed', decidedBy: APPROVER });
    expect((await listProposals(pool, deal.id)).map((p) => p.status)).toEqual(['dismissed', 'superseded']);
    expect((await agent.get(`/sales/proposals/${v2.id}`)).text).toContain('The call was marked as not a deal.');
    expect(proposal.version).toBe(1);
  });
});

describe('a deal', () => {
  it('lets an approver flag it as a Penguin deal, save the room\'s slug, and approve the pull request from the UI', async () => {
    const { deal, callId } = await drafted();
    const viewer = await signIn(VIEWER);
    await viewer.post(`/sales/deals/${deal.id}/penguin`, { penguin: 'yes' }).expect(403);
    await viewer.post(`/sales/deals/${deal.id}/slug`, { slug: 'larkfield' }).expect(403);
    expect((await viewer.agent.get(`/sales/deals/${deal.id}`).expect(200)).text).not.toContain('Mark as Penguin');

    const { agent, submit, post } = await signIn(APPROVER);
    const page = (await agent.get(`/sales/deals/${deal.id}`).expect(200)).text;
    expect(page).toContain('Not a Penguin deal');
    expect(page).toContain('no Penguin address was on the call');
    expect(page).toContain('Only a Penguin deal gets deal room content.');
    expect(page).toContain('Jo Prospect');

    const flagged = await submit(`/sales/deals/${deal.id}/penguin`, { penguin: 'yes' });
    expect(flagged.page).toContain('Marked as a Penguin deal.');
    expect(flagged.page).toContain('set by');
    expect(flagged.page).toContain('no slug yet');
    await work();
    // Without a slug there is nothing to approve yet.
    const proposal = (await proposalForCall(pool, callId))!;
    expect(await offerFor(pool, proposal.id)).toMatchObject({ status: 'expired' });
    expect((await agent.get(`/sales/proposals/${proposal.id}`)).text).toContain('The approval request expired or was closed.');

    expect((await submit(`/sales/deals/${deal.id}/slug`, { slug: 'Not A Slug!' })).page).toContain('A slug is lower-case letters, digits and dashes');
    const saved = await submit(`/sales/deals/${deal.id}/slug`, { slug: 'larkfield' });
    expect(saved.page).toContain('Approving the proposal now opens a pull request for content/larkfield/.');
    await work();

    const offer = (await offerFor(pool, proposal.id))!;
    expect(offer.action.type).toBe(DEALROOM_PR_ACTION);
    const review = (await agent.get(`/sales/proposals/${proposal.id}`)).text;
    expect(review).toContain(`Open a pull request on ${DEALROOM_REPO} that adds or changes 7 files under content/larkfield/`);
    expect(review).toContain('Patcher does not merge it');
    expect(review).toContain('<code>proposal/01-summary.md</code>');
    expect(review).toContain('Deal room files');

    await post(`/approvals/${offer.id}/approve`, { hash: offer.actionHash }).expect(303);
    await work();
    expect(github.pulls).toHaveLength(1);
    expect(github.branches.get('main')).toBe('sha-main-1');
    const dealPage = (await agent.get(`/sales/deals/${deal.id}`)).text;
    expect(dealPage).toContain(`href="https://github.com/${DEALROOM_REPO}/pull/101"`);
    expect(dealPage).toContain('Pull request open');
    expect(dealPage).toContain('Still to do by hand');
    expect((await agent.get('/sales')).text).toContain('Pull request open');
    expect((await listUpdates(pool, deal.id))[0]!.status).toBe('pr_open');
  });

  it('lets an approver take the mark off a deal the rule caught, or skip its deal room', async () => {
    const { deal, callId } = await drafted(PENGUIN_HOST);
    const { submit } = await signIn(APPROVER);
    const skipped = await submit(`/sales/deals/${deal.id}/skip`);
    expect(skipped.page).toContain('Skipped. The proposal can be approved without a deal room.');
    expect(skipped.page).toContain('skipped for this deal');
    await work();
    const proposal = (await proposalForCall(pool, callId))!;
    expect((await offerFor(pool, proposal.id))!.action.type).toBe(FINALIZE_ACTION);

    const off = await submit(`/sales/deals/${deal.id}/penguin`, { penguin: 'no' });
    expect(off.page).toContain('Marked as not a Penguin deal.');
    expect(await getDeal(pool, deal.id)).toMatchObject({ isPenguin: false, penguinReason: 'flagged', penguinSetBy: APPROVER, dealRoomSkipped: false });
    expect((await submit(`/sales/deals/${deal.id}/penguin`, { penguin: 'no' })).page).toContain('Already marked as not a Penguin deal.');
    expect((await submit(`/sales/deals/${deal.id}/penguin`, { penguin: 'maybe' })).page).toContain('Choose Penguin or not Penguin.');
  });

  it('says on the deal when the deal room app is not configured on the worker', async () => {
    await setup({ dealRoom: false });
    const { deal } = await drafted(PENGUIN_HOST);
    const { agent } = await signIn(APPROVER);
    const page = (await agent.get(`/sales/deals/${deal.id}`)).text;
    expect(page).toContain('The deal room GitHub App is not configured on the worker (DEALROOM_GITHUB_APP_ID, DEALROOM_GITHUB_APP_PRIVATE_KEY, DEALROOM_GITHUB_APP_INSTALLATION_ID)');
    await agent.get('/sales/deals/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('respects an approver list that leaves proposals out', async () => {
    await addUser(pool, 'U0CALLSONLY', 'approver', ['call_change']);
    const { deal, callId, proposal } = await drafted();
    const limited = await signIn('U0CALLSONLY');
    expect((await limited.submit(`/sales/deals/${deal.id}/penguin`, { penguin: 'yes' })).page).toContain('You are not on the approver list for this.');
    expect((await limited.submit(`/sales/calls/${callId}/not-deal`)).page).toContain('You are not on the approver list for this.');
    expect((await limited.submit(`/sales/proposals/${proposal.id}/edit`, { content_md: '# T\n\n## One\n\nText.' })).page).toContain('You are not on the approver list for this.');
    expect((await getDeal(pool, deal.id))!.isPenguin).toBe(false);
  });
});

describe('template and rate card', () => {
  it('shows the rate card to everyone and lets only the owner change it', async () => {
    const approver = await signIn(APPROVER);
    const seen = (await approver.agent.get('/sales/catalog').expect(200)).text;
    expect(seen).toContain('System integration');
    expect(seen).toContain('value="12000.00"');
    expect(seen).not.toContain('Add a service');
    await approver.post('/sales/catalog', { key: 'audit', name: 'Audit', unit: 'fixed', price: '3500', active: '1' }).expect(403);
    await approver.post('/sales/template', { template: '## One\nSomething.' }).expect(403);

    const { submit } = await signIn(OWNER);
    const added = await submit('/sales/catalog', { key: 'Audit', name: 'Process audit', description: 'A fixed review.', unit: '', price: '3,500.50', active: '1' });
    expect(added.page).toContain('Saved Process audit.');
    const catalog = await listCatalog(pool);
    expect(catalog.find((c) => c.key === 'audit')).toMatchObject({ unit: 'fixed', unitPriceCents: 350_050, active: true });

    expect((await submit('/sales/catalog', { key: 'audit', name: 'Process audit', unit: 'fixed', price: 'cheap', active: '1' })).page).toContain('Not saved. Write the price as a number');
    expect((await submit('/sales/catalog', { key: 'x', name: 'Too short', unit: 'fixed', price: '' })).page).toContain('Not saved. The reference is 2 to 40');
    // Unchecking "Offered" keeps the service and leaves it out of new drafts.
    await submit('/sales/catalog', { key: 'audit', name: 'Process audit', unit: 'fixed', price: '' });
    expect((await listCatalog(pool, { activeOnly: true })).map((c) => c.key)).not.toContain('audit');
    expect((await listCatalog(pool)).find((c) => c.key === 'audit')).toMatchObject({ unitPriceCents: null, active: false });

    const removed = await submit(`/sales/catalog/${catalog.find((c) => c.key === 'audit')!.id}/remove`);
    expect(removed.page).toContain('Removed.');
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['sales.catalog.add', 'sales.catalog.update', 'sales.catalog.remove']));
  });

  it('saves the proposal template, which the next draft is given', async () => {
    const { submit, agent } = await signIn(OWNER);
    expect((await agent.get('/sales/catalog')).text).toContain(DEFAULT_PROPOSAL_TEMPLATE.split('\n')[0]!);
    expect((await submit('/sales/template', { template: 'short' })).page).toContain('Not saved.');
    const saved = await submit('/sales/template', { template: '## Why now\r\nThe trigger for the work.\r\n\r\n## What we do\r\nThe work.' });
    expect(saved.page).toContain('Saved. New drafts use it.');
    expect((await getAllSettings(pool))['sales.proposal_template']).toBe('## Why now\nThe trigger for the work.\n\n## What we do\nThe work.');

    await drafted();
    expect(model.sent('record_proposal')[0]!.user).toContain('## Why now\nThe trigger for the work.');
  });
});

describe('sales settings', () => {
  const form = (overrides: Record<string, string> = {}) => ({
    'sales.enabled': '1',
    'ai.sales.enabled': '1',
    'sales.penguin_emails': 'Morgan@Penguin.example, alias@penguin.example',
    'sales.title_patterns': 'Intro, Pitch',
    'ai.sales.auto_confidence': '0.85',
    'ai.sales.ask_confidence': '0.55',
    'ai.sales.daily_budget_usd': '5',
    'ai.sales.monthly_budget_usd': '60',
    'sales.currency': 'eur',
    'sales.dealroom_repo': DEALROOM_REPO,
    ...overrides,
  });

  it('shows the card with the state of the deal room app, and saves what the owner sets', async () => {
    await setup({ dealRoom: false });
    const { agent, submit } = await signIn(OWNER);
    const page = (await agent.get('/settings').expect(200)).text;
    expect(page).toContain('id="sales"');
    expect(page).toContain('Your Penguin email addresses');
    expect(page).toContain('Missing on the worker: DEALROOM_GITHUB_APP_ID, DEALROOM_GITHUB_APP_PRIVATE_KEY, DEALROOM_GITHUB_APP_INSTALLATION_ID');
    expect(page).toContain('It never merges');

    const saved = await submit('/settings/sales', form());
    expect(saved.page).toContain('Saved.');
    expect(await getAllSettings(pool)).toMatchObject({
      'sales.enabled': true,
      'sales.penguin_emails': 'morgan@penguin.example, alias@penguin.example',
      'sales.title_patterns': 'intro, pitch',
      'ai.sales.auto_confidence': 0.85,
      'ai.sales.ask_confidence': 0.55,
      'ai.sales.daily_budget_usd': 5,
      'sales.currency': 'EUR',
    });
    expect(await auditActions(pool)).toContain('setting.update');

    // An unchecked box is off.
    const { 'sales.enabled': _on, ...withoutSwitch } = form();
    await submit('/settings/sales', withoutSwitch);
    expect((await getAllSettings(pool))['sales.enabled']).toBe(false);
    expect((await agent.get('/sales')).text).toContain('Sales calls are switched off');
  });

  it('saves nothing of a form with one bad value', async () => {
    const { submit } = await signIn(OWNER);
    const before = await getAllSettings(pool);
    expect((await submit('/settings/sales', form({ 'sales.penguin_emails': 'not an address' }))).page).toContain('Not saved.');
    expect((await submit('/settings/sales', form({ 'ai.sales.ask_confidence': '0.9' }))).page).toContain('cannot be above the confidence for drafting');
    expect((await submit('/settings/sales', form({ 'sales.dealroom_repo': 'https://github.com/x/y' }))).page).toContain('Write the repository as owner/name.');
    expect(await getAllSettings(pool)).toEqual(before);
  });

  it('is for the owner', async () => {
    const approver = await signIn(APPROVER);
    await approver.post('/settings/sales', form()).expect(403);
    expect((await approver.agent.get('/settings')).text).toContain('Your Penguin email addresses');
  });

  it('shows on /health whether the deal room app is configured, without any value', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(JSON.stringify(res.body)).toContain('dealroom');
    expect(JSON.stringify(res.body)).not.toContain('BEGIN');
  });
});
