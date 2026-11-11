import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestTranscript } from '../src/calls/ingest.js';
import { createServiceAdapter, externalRefFor } from '../src/dealroom/adapter.js';
import { createDealRoomService } from '../src/dealroom/service.js';
import { recordConfigured } from '../src/integrations/status.js';
import { syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { DEALROOM_API_ACTION, DEALROOM_PUBLISH_ACTION } from '../src/sales/catalog.js';
import { postSales } from '../src/sales/delivery.js';
import { classifyCall, draftProposal } from '../src/sales/pipeline.js';
import { followUpFor, getDeal, listUpdates, offerFor, proposalForCall } from '../src/sales/store.js';
import type { Deal, Proposal } from '../src/sales/types.js';
import { getAllSettings, setSetting } from '../src/settings/settings.js';
import { createApp } from '../src/web/app.js';
import { transcript } from './fixtures/calls.js';
import { FakeDealRoom, ROOM_ORIGIN, ROOM_TOKEN } from './fixtures/dealroom.js';
import { FakeModel } from './fixtures/model.js';
import { DEALROOM_REPO, PENGUIN, briefAnswer, classifyAnswer, cleanCheck, draftAnswer, prospect, salesCall, seedCatalog } from './fixtures/sales.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, VIEWER, addUser, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The control UI for the deal room's service API: the settings that choose it, the state of
 * the bot token, and a deal and a proposal on that route. The deal room is a stand-in built
 * from the API's contract; the model and Slack are stand-ins too.
 */
const pool = testPool();
const PENGUIN_HOST = { hostEmail: PENGUIN, attendees: [{ name: 'Morgan Host', email: PENGUIN, external: false }, prospect.jo, prospect.lee] };
/** May approve proposals, and nothing about the deal room's status. */
const SELLER = 'U0SELLER';

let h: Harness;
let model: FakeModel;
let room: FakeDealRoom;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;

async function setup(options: { api?: boolean } = {}) {
  model = new FakeModel();
  room = new FakeDealRoom();
  const dealRoomApi = options.api === false ? null : createServiceAdapter(createDealRoomService({ token: ROOM_TOKEN, fetch: room.fetch }));
  const integrations = testIntegrations({ model, dealRoomApi });
  await recordConfigured(pool, integrations.status);
  h = harness(pool, { integrations });
  deps = webDeps(h);
  app = createApp(deps);
}

const useApi = async () => {
  await setSetting(pool, 'sales.dealroom_route', 'api', OWNER);
  await setSetting(pool, 'sales.dealroom_url', ROOM_ORIGIN, OWNER);
};

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await addUser(pool, SELLER, 'approver', ['proposal']);
  await routeTo(pool, 'sales', 'C0SALES');
  await setSetting(pool, 'calls.internal_domains', 'agency.example', OWNER);
  await setSetting(pool, 'sales.penguin_emails', PENGUIN, OWNER);
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
  const submit = async (path: string, fields: Record<string, string | string[]> = {}) => {
    const res = await post(path, fields).expect(303);
    const location = res.headers.location!;
    return { location, page: (await agent.get(location.split('#')[0]!)).text };
  };
  return { agent, post, submit };
}

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

async function drafted(): Promise<{ callId: string; proposal: Proposal; deal: Deal }> {
  const result = await ingestTranscript(h, transcript(salesCall(PENGUIN_HOST)), null);
  h.queue.clear();
  const callId = (result as { callId: string }).callId;
  model.on('record_call_type', classifyAnswer()).on('record_deal_brief', briefAnswer()).on('record_proposal', draftAnswer()).on('record_grounding_check', cleanCheck());
  await classifyCall(h.worker, callId);
  await work();
  const proposal = (await proposalForCall(pool, callId))!;
  return { callId, proposal, deal: (await getDeal(pool, proposal.dealId))! };
}

const settingsForm = (overrides: Record<string, string> = {}) => ({
  'sales.enabled': '1',
  'ai.sales.enabled': '1',
  'sales.penguin_emails': PENGUIN,
  'sales.dealroom_repo': DEALROOM_REPO,
  'sales.dealroom_route': 'api',
  'sales.dealroom_url': ROOM_ORIGIN,
  ...overrides,
});

describe('the deal room settings', () => {
  it('show which route is used, the address, the publish switch, and whether the worker has the token, never the token', async () => {
    const { agent } = await signIn(OWNER);
    const page = (await agent.get('/settings').expect(200)).text;
    expect(page).toContain('How an approved Penguin proposal reaches the deal room');
    expect(page).toMatch(/<option value="pull_request" selected>Content pull request: a person merges it in GitHub<\/option>/);
    expect(page).toMatch(/<option value="api" >Service API: written to a draft room after approval<\/option>/);
    expect(page).toMatch(/<input name="sales\.dealroom_url" type="url" value=""/);
    // Publishing starts off.
    expect(page).toMatch(/<input type="checkbox" name="sales\.dealroom_publish" value="1"\s+\/>/);
    expect(page).toContain('off: Patcher never changes a room&#39;s status and never writes to a live room');
    expect(page).toContain('Bot token set on the worker');
    expect(page).toContain('Last answer from the deal room never');
    expect(page).toContain('this web service does not have it');
    expect(page).not.toContain(ROOM_TOKEN);

    await setup({ api: false });
    const without = (await (await signIn(OWNER)).agent.get('/settings')).text;
    expect(without).toContain('No bot token');
    expect(without).toContain('Missing on the worker: DEALROOM_API_TOKEN');
  });

  it('save the route, the address as a plain origin, and the publish switch, for the owner only', async () => {
    const approver = await signIn(APPROVER);
    await approver.post('/settings/sales', settingsForm()).expect(403);
    expect((await getAllSettings(pool))['sales.dealroom_route']).toBe('pull_request');

    const { submit, agent } = await signIn(OWNER);
    const saved = await submit('/settings/sales', settingsForm({ 'sales.dealroom_url': ' https://Dealroom.Example/ ', 'sales.dealroom_publish': '1' }));
    expect(saved.page).toContain('Saved.');
    expect(await getAllSettings(pool)).toMatchObject({ 'sales.dealroom_route': 'api', 'sales.dealroom_url': ROOM_ORIGIN, 'sales.dealroom_publish': true });
    const page = (await agent.get('/settings')).text;
    expect(page).toMatch(/<option value="api" selected>/);
    expect(page).toMatch(/name="sales\.dealroom_publish" value="1" checked/);
    expect(await auditActions(pool)).toContain('setting.update');

    // An unticked box is off.
    await submit('/settings/sales', settingsForm());
    expect((await getAllSettings(pool))['sales.dealroom_publish']).toBe(false);
    // The pull request route stays selectable.
    await submit('/settings/sales', settingsForm({ 'sales.dealroom_route': 'pull_request' }));
    expect(await getAllSettings(pool)).toMatchObject({ 'sales.dealroom_route': 'pull_request', 'sales.dealroom_url': ROOM_ORIGIN });
  });

  it('save nothing of a form with an address that is not a plain https origin, or the API route without one', async () => {
    const { submit } = await signIn(OWNER);
    const before = await getAllSettings(pool);
    for (const bad of ['http://dealroom.example', 'https://dealroom.example/api/service/deals', 'https://user:pw@dealroom.example', 'dealroom.example']) {
      expect((await submit('/settings/sales', settingsForm({ 'sales.dealroom_url': bad, 'sales.dealroom_publish': '1' }))).page, bad).toContain('Not saved.');
    }
    expect((await submit('/settings/sales', settingsForm({ 'sales.dealroom_url': '' }))).page).toContain('Not saved. The service API needs the address of the deal room.');
    expect((await submit('/settings/sales', settingsForm({ 'sales.dealroom_route': 'email' }))).page).toContain('Not saved.');
    expect(await getAllSettings(pool)).toEqual(before);
  });

  it('close what was waiting and offer it again for the new route when they change', async () => {
    const { proposal, deal } = await drafted();
    // On the pull request route, with no slug, nothing is offered yet.
    expect(await offerFor(pool, proposal.id)).toBeNull();

    const { submit, agent } = await signIn(OWNER);
    await submit('/settings/sales', settingsForm());
    await work();
    const offer = (await offerFor(pool, proposal.id))!;
    expect(offer).toMatchObject({ status: 'posted' });
    expect(offer.action.type).toBe(DEALROOM_API_ACTION);
    expect((await agent.get('/sales')).text).toContain('no room yet');

    // Back to pull requests: the offer for the service API is closed.
    await submit('/settings/sales', settingsForm({ 'sales.dealroom_route': 'pull_request' }));
    await work();
    expect((await offerFor(pool, proposal.id))!).toMatchObject({ id: offer.id, status: 'expired', lastError: 'Closed: the deal room settings changed.' });
    expect(room.calls).toEqual([]);
    expect((await getDeal(pool, deal.id))!.dealRoomRef).toBeNull();
  });

  it('show on /health whether the token is configured, without any value', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(JSON.stringify(res.body)).toContain('dealroom_api');
    expect(JSON.stringify(res.body)).not.toContain(ROOM_TOKEN);
  });
});

describe('a deal on the service API route', () => {
  beforeEach(useApi);

  it('says how the room is reached, takes an optional slug, and says when the worker has no token', async () => {
    await setup({ api: false });
    const { deal, proposal } = await drafted();
    const { agent, submit } = await signIn(APPROVER);
    const page = (await agent.get(`/sales/deals/${deal.id}`).expect(200)).text;
    expect(page).toContain(`Service API at <code>${ROOM_ORIGIN}</code>`);
    expect(page).toContain('no room yet');
    expect(page).toContain('The deal room API token is not set on the worker (DEALROOM_API_TOKEN)');
    expect(page).toContain('Nothing is sent to the deal room before the approval.');
    expect(page).toContain('Publishing from Patcher is off');

    expect((await submit(`/sales/deals/${deal.id}/slug`, { slug: 'admin' })).page).toContain('not one of its own words');
    expect((await submit(`/sales/deals/${deal.id}/slug`, { slug: 'two--dashes' })).page).toContain('single dashes between them');
    const saved = await submit(`/sales/deals/${deal.id}/slug`, { slug: 'larkfield' });
    expect(saved.page).toContain('Saved. Approving the proposal now writes to the room &quot;larkfield&quot;');
    expect(saved.page).toContain('not linked yet · slug saved here: <code>larkfield</code>');
    await work();
    expect((await offerFor(pool, proposal.id))!.action.params).toMatchObject({ slug: 'larkfield' });

    const removed = await submit(`/sales/deals/${deal.id}/slug`, { slug: '' });
    expect(removed.page).toContain('Removed. The proposal is offered again without a slug.');
    await work();
    expect((await getDeal(pool, deal.id))!.dealRoomSlug).toBeNull();
    expect((await offerFor(pool, proposal.id))!.action.params).toMatchObject({ slug: null });

    const viewer = await signIn(VIEWER);
    await viewer.post(`/sales/deals/${deal.id}/slug`, { slug: 'larkfield' }).expect(403);
  });

  it('shows what approving would write, and after approval the draft room with Publish as its own approval', async () => {
    await setSetting(pool, 'sales.dealroom_publish', true, OWNER);
    const { deal, proposal, callId } = await drafted();
    const { agent, post } = await signIn(APPROVER);
    const before = (await agent.get(`/sales/proposals/${proposal.id}`).expect(200)).text;
    expect(before).toContain('Deal room files');
    expect(before).toContain('What approving would write to the deal room through its service API, if the room is a draft.');
    expect(before).toContain('<code>proposal/01-summary.md</code>');
    expect(before).toContain('or create it as a draft. If the room is a draft, write proposal v1 into it as 7 files');
    expect(room.calls).toEqual([]);

    const offer = (await offerFor(pool, proposal.id))!;
    await post(`/approvals/${offer.id}/approve`, { hash: offer.actionHash }).expect(303);
    await work();
    const created = room.only();
    expect(created.status).toBe('DRAFT');
    const [update] = await listUpdates(pool, deal.id);
    expect(update).toMatchObject({ status: 'draft_written', roomId: created.id });
    const publish = (await followUpFor(pool, update!.id))!;
    expect(publish.action.type).toBe(DEALROOM_PUBLISH_ACTION);

    const after = (await agent.get(`/sales/proposals/${proposal.id}`)).text;
    expect(after).toContain('Deal room: draft ready');
    expect(after).toContain(`href="${ROOM_ORIGIN}/deals/larkfield-outfitters"`);
    expect(after).toContain('from DRAFT to ACTIVE. It then opens to nobody yet');
    expect(after).toContain(`action="/approvals/${publish.id}/approve"`);
    expect(after).toContain('What the write did in the room');
    expect(after).toContain('<code>overview.md</code>: new');
    const dealPage = (await agent.get(`/sales/deals/${deal.id}`)).text;
    expect(dealPage).toContain(`linked to room <code>${created.id}</code>`);
    expect(dealPage).toContain('In a draft room');
    expect(dealPage).toContain('the room was DRAFT when last read, open to nobody yet');
    expect((await agent.get('/sales')).text).toContain(`href="${ROOM_ORIGIN}/deals/larkfield-outfitters"`);

    // Someone who may approve proposals only sees no button, and cannot approve it by posting.
    const seller = await signIn(SELLER);
    const limited = (await seller.agent.get(`/sales/proposals/${proposal.id}`)).text;
    expect(limited).toContain('Waiting for an approver.');
    expect(limited).not.toContain(`action="/approvals/${publish.id}/approve"`);
    await seller.post(`/approvals/${publish.id}/approve`, { hash: publish.actionHash });
    await work();
    expect(room.only().status).toBe('DRAFT');

    await post(`/approvals/${publish.id}/approve`, { hash: publish.actionHash }).expect(303);
    await work();
    expect(room.only().status).toBe('ACTIVE');
    expect(room.statusChanges()).toHaveLength(1);
    const published = (await agent.get(`/sales/deals/${deal.id}`)).text;
    expect(published).toContain('Published');
    expect(published).toContain(`<a href="${ROOM_ORIGIN}/deals/larkfield-outfitters" rel="noreferrer">Room larkfield-outfitters</a>`);
    expect(await proposalForCall(pool, callId)).toMatchObject({ status: 'final' });

    // An address that is not https (a local stand-in) is never a link, and the room is still named.
    await pool.query(`UPDATE deal_room_updates SET room_url = 'http://localhost:4030/deals/larkfield-outfitters' WHERE id = $1`, [update!.id]);
    const local = (await agent.get(`/sales/deals/${deal.id}`)).text;
    expect(local).toContain('Room <code>larkfield-outfitters</code>');
    expect(local).not.toContain('href="http://localhost:4030');
    expect(local).not.toContain('no room yet');
    // No page that was drawn held the token.
    expect([before, after, dealPage, limited].join('')).not.toContain(ROOM_TOKEN);
  });

  it('shows the files that wait for a live room, what writing would change, and offers nothing while publishing is off', async () => {
    const { deal, proposal, callId } = await drafted();
    const live = room.seed({ slug: 'larkfield', clientName: 'Larkfield Outfitters', status: 'ACTIVE', externalRef: externalRefFor(deal.id), memberCount: 2 });
    room.personWrites(live.id, 'proposal/01-summary.md', 'A person wrote this summary.');
    const { agent, post, submit } = await signIn(APPROVER);
    const offer = (await offerFor(pool, proposal.id))!;
    await post(`/approvals/${offer.id}/approve`, { hash: offer.actionHash }).expect(303);
    await work();

    const page = (await agent.get(`/sales/proposals/${proposal.id}`)).text;
    expect(page).toContain('Deal room: approved, not written');
    expect(page).toContain('The room is <strong>ACTIVE</strong>, open to 2 members, 0 pending invites and anyone who signs up with one of its 0 allowed email domains');
    expect(page).toContain('A person edited these files in the room, and writing would replace or remove them:');
    expect(page).toContain('Publishing from Patcher is off in <a href="/settings#sales">Settings</a>, so nothing more is offered here.');
    expect(page).toContain('What writing would do in the room');
    expect(page).toContain('<code>proposal/01-summary.md</code>: replaces what is there <span class="muted">(there now: written by a person)</span>');
    expect(page).not.toContain('pat.editor');
    expect((await agent.get(`/sales/deals/${deal.id}`)).text).toContain('Waiting: not written');
    expect(room.confirmed()).toEqual([]);
    expect(room.shown(live.id, 'proposal/01-summary.md')).toBe('A person wrote this summary.');

    // Nothing was offered, and nothing can be while publishing is off.
    expect((await submit(`/sales/calls/${callId}/reoffer`)).page).toContain('Nothing can be offered for the deal room as things are.');
    await work();
    expect(await followUpFor(pool, (await listUpdates(pool, deal.id))[0]!.id)).toBeNull();
    expect(room.confirmed()).toEqual([]);
  });
});
