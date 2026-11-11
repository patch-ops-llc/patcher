import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestTranscript } from '../src/calls/ingest.js';
import { createServiceAdapter, externalRefFor } from '../src/dealroom/adapter.js';
import { createDealRoomService } from '../src/dealroom/service.js';
import { listIntegrations, recordConfigured } from '../src/integrations/status.js';
import { syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { runExpiry } from '../src/recommendations/expiry.js';
import type { Recommendation } from '../src/recommendations/types.js';
import { DEALROOM_API_ACTION, DEALROOM_API_NOT_CONFIGURED, DEALROOM_CONFIRM_ACTION, DEALROOM_PR_ACTION, DEALROOM_PUBLISH_ACTION, PUBLISH_OFF } from '../src/sales/catalog.js';
import { setDealRoomSlug } from '../src/sales/actions.js';
import { syncDealRoom } from '../src/sales/dealroomSync.js';
import { SALES_ACTIONS, postSales } from '../src/sales/delivery.js';
import { classifyCall, draftProposal } from '../src/sales/pipeline.js';
import { followUpFor, getDeal, listUpdates, offerFor, proposalForCall } from '../src/sales/store.js';
import type { Deal, DealRoomUpdate, Proposal } from '../src/sales/types.js';
import { setSetting } from '../src/settings/settings.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES } from '../src/slack/messages.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { transcript } from './fixtures/calls.js';
import { FakeDealRoom, ROOM_ORIGIN, ROOM_TOKEN } from './fixtures/dealroom.js';
import { FakeModel } from './fixtures/model.js';
import { PENGUIN, briefAnswer, classifyAnswer, cleanCheck, draftAnswer, prospect, salesCall, seedCatalog } from './fixtures/sales.js';
import type { Harness } from './helpers.js';
import { APPROVER, BASE_URL, HUB, OWNER, SIGNING_SECRET, VIEWER, addUser, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * A Penguin proposal through the deal room's service API: from the approval in Slack to a
 * draft room, and the two approvals that can follow (writing to a room that was held, and
 * publishing). The deal room is a stand-in built from the API's contract; Slack and the
 * model are stand-ins too. Nothing here has run against the real deal room.
 */
const pool = testPool();
const CHANNEL = 'C0SALES';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T0HUB/1/abc';
const PENGUIN_HOST = { hostEmail: PENGUIN, attendees: [{ name: 'Morgan Host', email: PENGUIN, external: false }, prospect.jo, prospect.lee] };
/** May approve proposals, and nothing about the deal room's status. */
const SELLER = 'U0SELLER';

let h: Harness;
let model: FakeModel;
let room: FakeDealRoom;
let app: ReturnType<typeof createApp>;
const said: string[] = [];

function setup(options: { api?: boolean } = {}) {
  model = new FakeModel();
  room = new FakeDealRoom();
  const dealRoomApi = options.api === false ? null : createServiceAdapter(createDealRoomService({ token: ROOM_TOKEN, fetch: room.fetch }));
  h = harness(pool, { integrations: testIntegrations({ model, dealRoomApi }) });
  app = createApp(webDeps(h));
}

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await addUser(pool, SELLER, 'approver');
  await pool.query(`UPDATE users SET approval_kinds = '{proposal}' WHERE slack_user_id = $1`, [SELLER]);
  await routeTo(pool, 'sales', CHANNEL);
  await routeTo(pool, 'errors', 'C0ERRORS');
  await setSetting(pool, 'calls.internal_domains', 'agency.example', OWNER);
  await setSetting(pool, 'sales.penguin_emails', PENGUIN, OWNER);
  await setSetting(pool, 'sales.dealroom_route', 'api', OWNER);
  await setSetting(pool, 'sales.dealroom_url', ROOM_ORIGIN, OWNER);
  await seedCatalog(pool, OWNER);
  said.length = 0;
  setup();
  // The worker reports what it has at start.
  await recordConfigured(pool, h.worker.integrations.status);
});
afterAll(() => pool.end());

interface Button {
  action_id: string;
  value?: string;
  url?: string;
  text: { text: string };
  style?: string;
}
interface Message {
  channel: string;
  ts?: string;
  threadTs?: string;
  text: string;
  blocks: [{ text: { text: string } }, { elements: Button[] }?];
}

const messages = (method: 'postMessage' | 'updateMessage') => (h.slack.of(method) as unknown as Message[]).filter((m) => m.channel === CHANNEL && !m.threadTs);
const last = (): Message => [...messages('postMessage'), ...messages('updateMessage')].at(-1)!;
const linesOf = (m: Message): string[] => m.blocks[0].text.text.split('\n');
const buttonsOf = (m: Message): Button[] => m.blocks[1]?.elements ?? [];
const labels = (m: Message): string[] => buttonsOf(m).map((b) => b.text.text);
const buttonOf = (m: Message, label: string): Button => {
  const found = buttonsOf(m).find((b) => b.text.text === label);
  if (!found) throw new Error(`no "${label}" button among: ${labels(m).join(', ')}`);
  return found;
};

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
      else if (job.name === 'slack.respond') said.push(data.text!);
    }
  }
}

interface Posted {
  callId: string;
  proposal: Proposal;
  deal: Deal;
  message: Message;
}

const current = async (callId: string): Promise<{ proposal: Proposal; deal: Deal; offer: Recommendation | null; update: DealRoomUpdate | null; next: Recommendation | null }> => {
  const proposal = (await proposalForCall(pool, callId))!;
  const deal = (await getDeal(pool, proposal.dealId))!;
  const update = (await listUpdates(pool, deal.id)).find((u) => u.proposalId === proposal.id) ?? null;
  return { proposal, deal, offer: await offerFor(pool, proposal.id), update, next: update ? await followUpFor(pool, update.id) : null };
};

/** A Penguin sales call, drafted and posted: what an approver finds in Slack on the service API route. */
async function posted(): Promise<Posted> {
  const result = await ingestTranscript(h, transcript(salesCall(PENGUIN_HOST)), null);
  h.queue.clear();
  const callId = (result as { callId: string }).callId;
  model.on('record_call_type', classifyAnswer()).on('record_deal_brief', briefAnswer()).on('record_proposal', draftAnswer()).on('record_grounding_check', cleanCheck());
  await classifyCall(h.worker, callId);
  await work();
  const { proposal, deal } = await current(callId);
  return { callId, proposal, deal, message: last() };
}

function interact(payload: unknown) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = Math.floor(Date.now() / 1000);
  return request(app)
    .post('/slack/interactions')
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', String(ts))
    .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, body))
    .send(body);
}

const click = (button: Button, userId = APPROVER) =>
  interact({
    type: 'block_actions',
    team: { id: HUB },
    user: { id: userId, team_id: HUB, name: 'someone' },
    trigger_id: 'trigger-1',
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
  }).expect(200);

const told = (): string[] => [...said, ...h.queue.of('slack.respond').map((j) => j.text)];
const sent = (): string[] => room.calls.map((c) => `${c.method} ${c.path}`);
const link = (proposal: Proposal): string => `<${BASE_URL}/sales/proposals/${proposal.id}|Proposal v${proposal.version}>`;
const publishOn = () => setSetting(pool, 'sales.dealroom_publish', true, OWNER);
/** How the action behind a recommendation went, as the executor recorded it. */
const ran = async (recommendationId: string) => (await pool.query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM actions WHERE recommendation_id = $1 ORDER BY created_at', [recommendationId])).rows;

/** Approves the proposal that is on screen, and lets the worker finish. */
async function approved(): Promise<Posted> {
  const first = await posted();
  await click(buttonOf(first.message, 'Approve'));
  await work();
  return { ...first, message: last() };
}

describe('before the approval', () => {
  it('offers to write to a draft room, says what approving does, and has sent nothing to the deal room', async () => {
    const { message, proposal, deal } = await posted();
    expect(linesOf(message)).toEqual([
      '*Penguin deal* · Larkfield Outfitters · held with your Penguin email · new draft room',
      'Proposal v1: 6 sections. Order-to-billing sync, two phases. Gaps: start date, budget, price for Support plan · 4 to check',
      'Approving writes it to a draft deal room, which clients cannot open. A live room is not changed without asking again',
    ]);
    expect(labels(message)).toEqual(['Review', 'Approve', 'Regenerate', 'Not Penguin']);

    const offer = (await offerFor(pool, proposal.id))!;
    expect(offer).toMatchObject({ kind: 'proposal', status: 'posted', risk: 'medium' });
    expect(offer.action.type).toBe(DEALROOM_API_ACTION);
    expect(offer.action.params).toMatchObject({ origin: ROOM_ORIGIN, slug: null, version: 1, files: 7, company: 'Larkfield Outfitters' });
    expect(h.catalog.describe(offer.action)).toMatch(/or create it as a draft\. If the room is a draft, write proposal v1 into it as 7 files; clients cannot open a draft room\. If the room is not a draft, or a person edited its files, nothing is written and Patcher asks again\. .* The room's status is not changed\.$/);

    // The whole point: no request of any kind before a person approves.
    expect(room.calls).toEqual([]);
    expect(deal.dealRoomRef).toBeNull();
    expect(await listUpdates(pool, deal.id)).toEqual([]);
  });

  it('asks for the address when the route is the service API and none is saved, and offers nothing', async () => {
    await setSetting(pool, 'sales.dealroom_url', '', OWNER);
    const { message, proposal } = await posted();
    expect(linesOf(message)[0]).toBe('*Penguin deal* · Larkfield Outfitters · held with your Penguin email · deal room address not set');
    expect(linesOf(message)[2]).toBe('Save the deal room address in Settings, or switch the deal room back to pull requests');
    expect(labels(message)).toEqual(['Review', 'Regenerate', 'Not Penguin', 'Skip']);
    expect(await offerFor(pool, proposal.id)).toBeNull();
    expect(room.calls).toEqual([]);
  });

  it('sends nothing in dry run', async () => {
    await setSetting(pool, 'dry_run', true, OWNER);
    const { callId } = await approved();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(room.calls).toEqual([]);
    expect(linesOf(last())[1]).toMatch(/approved by <@U0APPROVER> in dry run · nothing was done$/);
  });

  it('refuses an approval from someone who is not on the approver list, and sends nothing', async () => {
    const { message, callId } = await posted();
    await click(buttonOf(message, 'Approve'), VIEWER);
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(room.calls).toEqual([]);
  });
});

describe('approving a proposal for a deal with no room yet', () => {
  it('creates a draft room by Patcher\'s reference, writes the files, marks the proposal final, and changes no status', async () => {
    const { callId, proposal, deal } = await approved();

    const created = room.only();
    expect(sent()).toEqual(['POST /api/service/deals', `GET /api/service/deals/${created.id}/content?include=body`, `PUT /api/service/deals/${created.id}/content`]);
    expect(room.calls.every((c) => c.authorized)).toBe(true);
    expect(room.calls[0]!.body).toEqual({
      externalRef: externalRefFor(deal.id),
      clientName: 'Larkfield Outfitters',
      proposalVersion: 'v1',
      proposalUpdatedAt: proposal.createdAt.toISOString().slice(0, 10),
    });
    expect(created).toMatchObject({ status: 'DRAFT', slug: 'larkfield-outfitters', externalRef: `patcher:deal:${deal.id}`, allowedEmailDomains: [], memberCount: 0 });
    expect(room.paths(created.id)).toEqual([
      'overview.md',
      'proposal/01-summary.md',
      'proposal/02-your-situation.md',
      'proposal/03-proposed-approach.md',
      'proposal/04-scope.md',
      'proposal/05-investment.md',
      'proposal/06-next-steps.md',
    ]);
    const written = room.paths(created.id).map((path) => room.shown(created.id, path)).join('\n');
    expect(written).not.toMatch(/<script|!\[|45,000/);
    expect(written).toContain('$12,000');
    // Nothing asked for a status, and nothing carried confirmLive.
    expect(room.statusChanges()).toEqual([]);
    expect(room.confirmed()).toEqual([]);

    // What Patcher recorded.
    expect(await proposalForCall(pool, callId)).toMatchObject({ status: 'final', finalizedBy: APPROVER });
    expect((await getDeal(pool, deal.id))!).toMatchObject({ dealRoomRef: created.id, stage: 'proposal_final' });
    const { update } = await current(callId);
    expect(update).toMatchObject({
      route: 'api',
      status: 'draft_written',
      origin: ROOM_ORIGIN,
      roomId: created.id,
      roomUrl: `${ROOM_ORIGIN}/deals/larkfield-outfitters`,
      slug: 'larkfield-outfitters',
      room: { status: 'DRAFT', slug: 'larkfield-outfitters', members: 0, invites: 0, domains: 0 },
      hold: null,
      error: null,
      prUrl: null,
    });
    expect(update!.changes).toHaveLength(7);
    expect(update!.changes.every((c) => c.change === 'add')).toBe(true);
    expect(update!.manualSteps.join(' ')).toMatch(/new draft with no members, invites or client domains/);
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['dealroom.api.create', 'dealroom.api.write', 'proposal.final']));
    expect((await listIntegrations(pool)).find((i) => i.name === 'dealroom_api')).toMatchObject({ lastError: null });

    // What the approver sees. Publishing is off, so there is no Publish button.
    expect(linesOf(last())).toEqual([
      '*Penguin deal* · Larkfield Outfitters · draft room ready',
      `${link(proposal)}: 6 sections · approved by <@${APPROVER}>. Draft: clients cannot see it yet`,
      'Publishing from Patcher is off. A person publishes the room in the deal room admin',
    ]);
    expect(labels(last())).toEqual(['Preview', 'Regenerate', 'Not Penguin']);
    expect(buttonOf(last(), 'Preview')).toMatchObject({ action_id: SALES_ACTIONS.openRoom, url: `${ROOM_ORIGIN}/deals/larkfield-outfitters` });
    expect((await current(callId)).next).toBeNull();
    expect(linesOf(last()).length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('never changes a room\'s status while the publish setting is off, whatever is pressed or approved', async () => {
    await publishOn();
    const { callId, message } = await approved();
    const publish = buttonOf(message, 'Publish');
    const offer = (await current(callId)).next!;

    // The owner switches publishing off after the offer was made.
    await setSetting(pool, 'sales.dealroom_publish', false, OWNER);
    await click(publish);
    await work();
    // The approval was taken and the action refused to run.
    expect(await ran(offer.id)).toEqual([{ status: 'failed', last_error: PUBLISH_OFF }]);
    expect(room.statusChanges()).toEqual([]);
    expect(room.only().status).toBe('DRAFT');

    // The offer that no longer applies is closed, and nothing is left to press.
    expect((await current(callId)).next).toMatchObject({ id: offer.id, status: 'expired' });
    expect(labels(last())).toEqual(['Preview', 'Regenerate', 'Not Penguin']);
    expect(linesOf(last())[2]).toBe('Publishing from Patcher is off. A person publishes the room in the deal room admin');
  });

  it('writes the next version over the first in the same room', async () => {
    const { callId, deal } = await approved();
    const created = room.only();
    await click(buttonOf(last(), 'Regenerate'));
    const view = (h.slack.of('openView').at(-1) as { view: { callback_id: string; private_metadata: string } }).view;
    model.on('record_proposal', draftAnswer({ summary: 'Order-to-billing sync, shorter' }));
    await interact({ type: 'view_submission', team: { id: HUB }, user: { id: APPROVER, team_id: HUB }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { note: { value: { value: 'Shorter.' } } } } } }).expect(200);
    await work();
    expect((await proposalForCall(pool, callId))!).toMatchObject({ version: 2, status: 'draft' });
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · held with your Penguin email · new draft room');
    const before = room.calls.length;

    await click(buttonOf(last(), 'Approve'));
    await work();
    expect(room.deals.size).toBe(1);
    expect(room.only()).toMatchObject({ id: created.id, status: 'DRAFT', proposalVersion: 'v2' });
    expect(room.calls.slice(before).map((c) => c.method)).toEqual(['POST', 'GET', 'PATCH']);
    expect((await listUpdates(pool, deal.id)).map((u) => `${u.status} ${u.roomId}`)).toEqual([`draft_written ${created.id}`, `draft_written ${created.id}`]);
    expect(room.statusChanges()).toEqual([]);
    expect(room.confirmed()).toEqual([]);
  });
});

describe('Publish', () => {
  it('is its own approval, offered only with the setting on, and sends the status alone', async () => {
    await publishOn();
    const { callId, proposal, message } = await approved();
    const created = room.only();
    expect(linesOf(message)).toEqual([
      '*Penguin deal* · Larkfield Outfitters · draft room ready',
      `${link(proposal)}: 6 sections · approved by <@${APPROVER}>. Draft: clients cannot see it yet`,
      'Publish opens the room to nobody yet: it has no members, invites or client domains',
    ]);
    expect(labels(message)).toEqual(['Preview', 'Publish', 'Regenerate', 'Not Penguin']);
    expect(buttonsOf(message).length).toBeLessThanOrEqual(MAX_BUTTONS);
    expect(buttonOf(message, 'Publish')).toMatchObject({ action_id: ACTION_IDS.approve, style: 'primary' });

    // A second recommendation in the shared loop, of its own kind, with its own evidence.
    const { next, update } = await current(callId);
    expect(next).toMatchObject({ kind: 'dealroom_publish', status: 'posted', risk: 'high', title: 'Publish deal room · Larkfield Outfitters', slackChannel: CHANNEL });
    expect(next!.action.type).toBe(DEALROOM_PUBLISH_ACTION);
    expect(next!.action.params).toMatchObject({ origin: ROOM_ORIGIN, roomId: created.id, updateId: update!.id, members: 0, invites: 0, domains: 0 });
    expect(next!.evidence[0]).toMatchObject({ source: 'Patcher proposal record', url: `${BASE_URL}/sales/proposals/${proposal.id}` });
    expect(h.catalog.describe(next!.action)).toBe(
      `Set the deal room for Larkfield Outfitters at ${ROOM_ORIGIN} from DRAFT to ACTIVE. It then opens to nobody yet: it has no members, invites or client domains. Nothing else in the room is changed, and nothing is sent to anyone.`,
    );
    // Approving the proposal did not publish anything.
    expect(room.statusChanges()).toEqual([]);

    // Someone who may approve proposals, and not the deal room kind, cannot publish.
    await click(buttonOf(message, 'Publish'), SELLER);
    await click(buttonOf(message, 'Publish'), VIEWER);
    await work();
    expect(room.only().status).toBe('DRAFT');
    expect(told()).toHaveLength(2);

    const before = room.calls.length;
    await click(buttonOf(message, 'Publish'));
    await work();
    expect(room.calls.slice(before).map((c) => [c.method, c.body])).toEqual([
      ['GET', undefined],
      ['GET', undefined],
      ['PATCH', { status: 'ACTIVE' }],
    ]);
    expect(room.only().status).toBe('ACTIVE');
    expect(room.confirmed()).toEqual([]);
    expect((await current(callId)).update).toMatchObject({ status: 'published', room: { status: 'ACTIVE' } });
    expect(await auditActions(pool)).toContain('dealroom.api.publish');
    expect(linesOf(last())).toEqual([
      '*Penguin deal* · Larkfield Outfitters · deal room is live',
      `${link(proposal)}: 6 sections · published by <@${APPROVER}>`,
      'Open to nobody yet: it has no members, invites or client domains',
    ]);
    expect(labels(last())).toEqual(['Open room', 'Regenerate', 'Not Penguin']);
  });

  it('changes nothing and asks again when who can open the room changed after the offer', async () => {
    await publishOn();
    const { callId, message } = await approved();
    const first = (await current(callId)).next!;
    // A person adds a client domain and two members in the deal room admin.
    Object.assign(room.only(), { allowedEmailDomains: ['larkfield.example'], memberCount: 2 });

    await click(buttonOf(message, 'Publish'));
    await work();
    expect(room.statusChanges()).toEqual([]);
    expect(room.only().status).toBe('DRAFT');

    const { next, update } = await current(callId);
    expect(update).toMatchObject({ status: 'draft_written', room: { members: 2, domains: 1 } });
    expect(next!.id).not.toBe(first.id);
    expect(next).toMatchObject({ status: 'posted' });
    expect(next!.action.params).toMatchObject({ members: 2, invites: 0, domains: 1 });
    expect(linesOf(last())[2]).toBe('Publish opens the room to 2 members, 0 pending invites and anyone who signs up with one of its 1 allowed email domain');

    await click(buttonOf(last(), 'Publish'));
    await work();
    expect(room.only().status).toBe('ACTIVE');
    expect(room.statusChanges()).toHaveLength(1);
  });

  it('is not offered again by itself after it expired; "Offer again" asks once more', async () => {
    await publishOn();
    const { callId } = await approved();
    const first = (await current(callId)).next!;
    // One reminder first, then the expiry on a later run.
    await pool.query(`UPDATE recommendations SET expires_at = now() + interval '1 hour' WHERE id = $1`, [first.id]);
    await runExpiry(h.worker);
    await pool.query(`UPDATE recommendations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [first.id]);
    await runExpiry(h.worker);
    await work();
    expect((await current(callId)).next).toMatchObject({ id: first.id, status: 'expired' });
    expect(linesOf(last())[2]).toBe('Publish was not decided in time');
    expect(labels(last())).toEqual(['Preview', 'Offer again', 'Regenerate', 'Not Penguin']);
    // Drawing the message again does not make a new offer.
    await postSales(h.worker, callId);
    expect((await current(callId)).next!.id).toBe(first.id);

    await click(buttonOf(last(), 'Offer again'), VIEWER);
    expect(told().at(-1)).toBe('You are not on the approver list for this.');
    await click(buttonOf(last(), 'Offer again'));
    await work();
    const { next } = await current(callId);
    expect(next!.id).not.toBe(first.id);
    expect(next).toMatchObject({ status: 'posted' });
    expect(labels(last())).toEqual(['Preview', 'Publish', 'Regenerate', 'Not Penguin']);
    expect(room.statusChanges()).toEqual([]);
    expect(await auditActions(pool)).toContain('dealroom.reoffer');
  });

  it('does nothing in dry run, and says so', async () => {
    await publishOn();
    const { callId, message } = await approved();
    await setSetting(pool, 'dry_run', true, OWNER);
    await click(buttonOf(message, 'Publish'));
    await work();
    expect(room.statusChanges()).toEqual([]);
    expect((await current(callId)).update!.status).toBe('draft_written');
    expect(linesOf(last())[2]).toBe(`Publish: approved by <@${APPROVER}> in dry run · nothing was changed`);
    expect(labels(last())).toEqual(['Preview', 'Offer again', 'Regenerate', 'Not Penguin']);
  });

  it('records a room a person published in the deal room admin, by reading only', async () => {
    const { callId, proposal } = await approved();
    expect(await syncDealRoom(h.worker)).toBe('1 room read, 0 changed');
    const before = room.writes().length;

    room.only().status = 'ACTIVE';
    expect(await syncDealRoom(h.worker)).toBe('1 room read, 1 changed');
    await work();
    expect((await current(callId)).update).toMatchObject({ status: 'published', room: { status: 'ACTIVE' } });
    expect(linesOf(last()).slice(0, 2)).toEqual(['*Penguin deal* · Larkfield Outfitters · deal room is live', `${link(proposal)}: 6 sections · published in the deal room admin`]);
    expect(await auditActions(pool)).toContain('dealroom.api.published_elsewhere');
    expect(room.writes()).toHaveLength(before);
    expect(await syncDealRoom(h.worker)).toBe('0 rooms read, 0 changed');
  });

  it('reads no room at an address that is no longer the one in Settings', async () => {
    await approved();
    const before = room.calls.length;
    await setSetting(pool, 'sales.dealroom_url', 'https://another.example', OWNER);
    expect(await syncDealRoom(h.worker)).toBe('0 rooms read, 0 changed');
    expect(room.calls).toHaveLength(before);
  });
});

describe('a room that is already live', () => {
  /** A room that already carries this deal's reference and has been published, as after an earlier proposal. */
  async function liveRoom(): Promise<Posted> {
    const first = await posted();
    room.seed({ slug: 'larkfield', clientName: 'Larkfield Outfitters', status: 'ACTIVE', externalRef: externalRefFor(first.deal.id), memberCount: 3, pendingInviteCount: 1, allowedEmailDomains: ['larkfield.example'] });
    return first;
  }

  it('is not written on the proposal\'s approval: the proposal is final and the files wait', async () => {
    const { message, callId, proposal } = await liveRoom();
    await click(buttonOf(message, 'Approve'));
    await work();

    expect(room.writes().map((c) => c.method)).toEqual(['POST']);
    expect(room.confirmed()).toEqual([]);
    expect(room.paths(room.only().id)).toEqual([]);
    expect(room.only().proposalVersion).toBeNull();
    expect((await proposalForCall(pool, callId))!.status).toBe('final');
    const { update, next } = await current(callId);
    expect(update).toMatchObject({ status: 'held', room: { status: 'ACTIVE', members: 3, invites: 1, domains: 1 }, hold: { reasons: ['live'], replaces: [], removes: [] } });
    expect(update!.files).toHaveLength(7);
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['dealroom.api.link', 'dealroom.api.hold', 'proposal.final']));

    // Publishing is off: nothing a client could see is offered at all.
    expect(next).toBeNull();
    expect(linesOf(last())).toEqual([
      '*Penguin deal* · Larkfield Outfitters · deal room is live · nothing written',
      `${link(proposal)} is final · approved by <@${APPROVER}>. The room is ACTIVE, open to 3 members, 1 pending invite and anyone who signs up with one of its 1 allowed email domain`,
      'Publishing from Patcher is off, so the room stays as it is. Turn it on in Settings, or enter the text in Deal Admin',
    ]);
    expect(labels(last())).toEqual(['Open room', 'Regenerate', 'Not Penguin']);
  });

  it('is written with confirmLive only after its own approval, which names the room\'s status and audience', async () => {
    await publishOn();
    const { message, callId, proposal } = await liveRoom();
    await click(buttonOf(message, 'Approve'));
    await work();
    expect(room.confirmed()).toEqual([]);
    expect(labels(last())).toEqual(['Open room', 'Write to live room', 'Regenerate', 'Not Penguin']);
    expect(linesOf(last())[2]).toBe('Writing shows the new text at once to everyone who can open the room');

    const { next } = await current(callId);
    expect(next).toMatchObject({ kind: 'dealroom_publish', status: 'posted', risk: 'high', title: 'Write to deal room · Larkfield Outfitters' });
    expect(next!.action.type).toBe(DEALROOM_CONFIRM_ACTION);
    expect(next!.action.params).toMatchObject({ roomStatus: 'ACTIVE', members: 3, invites: 1, domains: 1, files: 7, replaces: 0, removes: 0 });
    expect(h.catalog.describe(next!.action)).toBe(
      `Write proposal v1 for Larkfield Outfitters (7 files) into its deal room at ${ROOM_ORIGIN}, which is ACTIVE. The new text shows at once to everyone who can open the room: 3 members, 1 pending invite and anyone who signs up with one of its 1 allowed email domain. The room's status is not changed.`,
    );

    // The proposal's approver may not be the one who writes to a live room.
    await click(buttonOf(last(), 'Write to live room'), SELLER);
    await work();
    expect(room.confirmed()).toEqual([]);

    await click(buttonOf(last(), 'Write to live room'));
    await work();
    const live = room.only();
    expect(room.confirmed().map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /api/service/deals/${live.id}/content`, `PATCH /api/service/deals/${live.id}`]);
    expect(room.statusChanges()).toEqual([]);
    expect(room.paths(live.id)).toHaveLength(7);
    expect(live).toMatchObject({ status: 'ACTIVE', proposalVersion: 'v1' });
    expect((await current(callId)).update).toMatchObject({ status: 'published', hold: null });
    expect(await auditActions(pool)).toContain('dealroom.api.write');
    expect(linesOf(last()).slice(0, 2)).toEqual(['*Penguin deal* · Larkfield Outfitters · deal room is live', `${link(proposal)}: 6 sections · written to the live room by <@${APPROVER}>`]);
  });

  it('sends no confirmLive when the room is not as the approver was shown, and asks again', async () => {
    await publishOn();
    const { message, callId } = await liveRoom();
    await click(buttonOf(message, 'Approve'));
    await work();
    const first = (await current(callId)).next!;
    // Two more people were invited after the question was put.
    room.only().pendingInviteCount = 3;

    await click(buttonOf(last(), 'Write to live room'));
    await work();
    expect(room.confirmed()).toEqual([]);
    expect(room.paths(room.only().id)).toEqual([]);
    const { next, update } = await current(callId);
    expect(update).toMatchObject({ status: 'held', room: { invites: 3 } });
    expect(next!.id).not.toBe(first.id);
    expect(next!.action.params).toMatchObject({ invites: 3 });
    expect(labels(last())).toContain('Write to live room');
  });

  it('refuses the live write when publishing was switched off after the offer', async () => {
    await publishOn();
    const { message, callId } = await liveRoom();
    await click(buttonOf(message, 'Approve'));
    await work();
    const write = buttonOf(last(), 'Write to live room');
    const offer = (await current(callId)).next!;
    await setSetting(pool, 'sales.dealroom_publish', false, OWNER);
    await click(write);
    await work();
    expect(await ran(offer.id)).toEqual([{ status: 'failed', last_error: PUBLISH_OFF }]);
    expect((await current(callId)).next).toMatchObject({ id: offer.id, status: 'expired' });
    expect(labels(last())).toEqual(['Open room', 'Regenerate', 'Not Penguin']);
    expect(room.confirmed()).toEqual([]);
    expect(room.paths(room.only().id)).toEqual([]);
  });

  it('links a room a person made when its slug was saved on the deal, and still writes nothing to it while it is live', async () => {
    const first = await posted();
    const handmade = room.seed({ slug: 'larkfield', clientName: 'Larkfield', status: 'ACTIVE', memberCount: 2 });
    expect(await setDealRoomSlug(h.worker, { dealId: first.deal.id, slug: 'larkfield', actor: APPROVER, via: 'ui' })).toMatchObject({ ok: true });
    await work();
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · held with your Penguin email · room larkfield');
    expect((await offerFor(pool, first.proposal.id))!.action.params).toMatchObject({ slug: 'larkfield' });
    expect(room.calls).toEqual([]);

    await click(buttonOf(last(), 'Approve'));
    await work();
    expect(room.writes().map((c) => [c.method, c.body])).toEqual([
      ['POST', expect.objectContaining({ slug: 'larkfield' })],
      ['PATCH', { externalRef: externalRefFor(first.deal.id) }],
    ]);
    expect(room.only()).toMatchObject({ id: handmade.id, externalRef: externalRefFor(first.deal.id), status: 'ACTIVE', clientName: 'Larkfield' });
    expect(room.paths(handmade.id)).toEqual([]);
    expect((await current(first.callId)).update).toMatchObject({ status: 'held', roomId: handmade.id });
    expect((await getDeal(pool, first.deal.id))!.dealRoomRef).toBe(handmade.id);
  });
});

describe('a draft room a person edited', () => {
  it('is not overwritten without its own approval, which needs no publish setting and sends no confirmLive', async () => {
    const { callId } = await approved();
    const created = room.only();
    room.personWrites(created.id, 'proposal/01-summary.md', 'A person rewrote the summary.');

    await click(buttonOf(last(), 'Regenerate'));
    const view = (h.slack.of('openView').at(-1) as { view: { callback_id: string; private_metadata: string } }).view;
    model.on('record_proposal', draftAnswer({ summary: 'Order-to-billing sync, shorter' }));
    await interact({ type: 'view_submission', team: { id: HUB }, user: { id: APPROVER, team_id: HUB }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { note: { value: { value: 'Shorter.' } } } } } }).expect(200);
    await work();
    await click(buttonOf(last(), 'Approve'));
    await work();

    const { update, next, proposal } = await current(callId);
    expect(proposal).toMatchObject({ version: 2, status: 'final' });
    expect(update).toMatchObject({ status: 'held', hold: { reasons: ['edited'], replaces: ['proposal/01-summary.md'], removes: [] } });
    expect(update!.changes.find((c) => c.path === 'proposal/01-summary.md')).toEqual({ path: 'proposal/01-summary.md', change: 'replace', by: 'person' });
    expect(room.shown(created.id, 'proposal/01-summary.md')).toBe('A person rewrote the summary.');
    expect(linesOf(last())).toEqual([
      '*Penguin deal* · Larkfield Outfitters · draft room has edits · nothing written',
      `${link(proposal)} is final · approved by <@${APPROVER}>. 1 file a person edited in the room would be replaced or removed`,
      'Writing replaces them. Clients cannot open a draft room',
    ]);
    expect(labels(last())).toEqual(['Open room', 'Replace edits', 'Regenerate', 'Not Penguin']);
    expect(next).toMatchObject({ kind: 'dealroom_publish', risk: 'medium' });
    expect(next!.action.params).toMatchObject({ roomStatus: 'DRAFT', replaces: 1, removes: 0 });

    await click(buttonOf(last(), 'Replace edits'));
    await work();
    expect(room.shown(created.id, 'proposal/01-summary.md')).toMatch(/^---\ntitle: Summary\n---\n/);
    expect(room.confirmed()).toEqual([]);
    expect(room.statusChanges()).toEqual([]);
    expect((await current(callId)).update).toMatchObject({ status: 'draft_written', hold: null });
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · draft room ready');
  });
});

describe('when it cannot be done', () => {
  it('fails with the variable to set when the token is not on the worker', async () => {
    setup({ api: false });
    const { callId } = await approved();
    expect((await current(callId)).offer).toMatchObject({ status: 'failed', lastError: DEALROOM_API_NOT_CONFIGURED });
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room not written');
    expect(labels(last())).toEqual(['Retry', 'Review', 'Not Penguin']);
  });

  it('says what the deal room refused, without the token, and Retry finishes the same update', async () => {
    room.token = `rotated-${ROOM_TOKEN}`;
    const { callId, deal } = await approved();
    const { offer, update } = await current(callId);
    expect(offer).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/refused the bot token\. DEALROOM_API_TOKEN on the worker must be the same value as OPS_BOT_TOKEN/) });
    expect(update).toMatchObject({ status: 'failed', roomId: null });
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect((await listIntegrations(pool)).find((i) => i.name === 'dealroom_api')!.lastError).toMatch(/refused the bot token/);
    expect(room.deals.size).toBe(0);

    // Nothing Patcher kept or showed holds either token.
    const everything = JSON.stringify([
      (await pool.query('SELECT * FROM recommendations')).rows,
      (await pool.query('SELECT * FROM deal_room_updates')).rows,
      (await pool.query('SELECT * FROM audit_log')).rows,
      (await pool.query('SELECT * FROM integrations')).rows,
      h.slack.calls,
    ]);
    expect(everything).not.toContain(ROOM_TOKEN);

    room.token = ROOM_TOKEN;
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect(await listUpdates(pool, deal.id)).toHaveLength(1);
    expect((await current(callId)).update).toMatchObject({ id: update!.id, status: 'draft_written', error: null });
    expect((await proposalForCall(pool, callId))!.status).toBe('final');
    const status = (await listIntegrations(pool)).find((i) => i.name === 'dealroom_api')!;
    expect(status.lastOkAt!.getTime()).toBeGreaterThanOrEqual(status.lastErrorAt!.getTime());
  });

  it('creates nothing when a room with that slug exists and is not linked, and says what to save', async () => {
    const first = await posted();
    room.seed({ slug: 'larkfield-outfitters', clientName: 'Larkfield Outfitters', status: 'ACTIVE' });
    await click(buttonOf(first.message, 'Approve'));
    await work();
    expect((await current(first.callId)).offer!.lastError).toMatch(/already has a room at "larkfield-outfitters" .* If it is this deal's room, save "larkfield-outfitters" as the slug on the deal in Patcher/);
    expect(room.deals.size).toBe(1);
    expect(room.only().externalRef).toBeNull();
    expect((await proposalForCall(pool, first.callId))!.status).toBe('draft');
  });

  it('sends nothing when the address, the route, the slug or the mark changed after the approval was given', async () => {
    const { message, callId, deal } = await posted();
    await click(buttonOf(message, 'Approve'));
    // Approved, not yet run: the owner points Patcher at another address meanwhile.
    await setSetting(pool, 'sales.dealroom_url', 'https://another.example', OWNER);
    await work();
    expect((await current(callId)).offer).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/address in Settings changed after this was offered/) });

    await setSetting(pool, 'sales.dealroom_url', ROOM_ORIGIN, OWNER);
    await setSetting(pool, 'sales.dealroom_route', 'pull_request', OWNER);
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await current(callId)).offer!.lastError).toMatch(/way Patcher reaches the deal room was changed in Settings/);

    await setSetting(pool, 'sales.dealroom_route', 'api', OWNER);
    await pool.query(`UPDATE deals SET deal_room_slug = 'another-room' WHERE id = $1`, [deal.id]);
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await current(callId)).offer!.lastError).toMatch(/slug changed after the approval/);

    await pool.query(`UPDATE deals SET deal_room_slug = NULL, is_penguin = false WHERE id = $1`, [deal.id]);
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await current(callId)).offer!.lastError).toMatch(/no longer marked as a Penguin deal/);

    await pool.query(`UPDATE deals SET is_penguin = true WHERE id = $1`, [deal.id]);
    await pool.query(`UPDATE proposals SET content_md = content_md || 'x' WHERE call_id = $1`, [callId]);
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await current(callId)).offer!.lastError).toMatch(/not the ones that were approved/);
    expect(room.calls).toEqual([]);
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
  });

  it('keeps the pull request route working when it is the one selected, and sends nothing to the service API', async () => {
    await setSetting(pool, 'sales.dealroom_route', 'pull_request', OWNER);
    const { message, proposal, deal } = await posted();
    expect(linesOf(message)[0]).toBe('*Penguin deal* · Larkfield Outfitters · held with your Penguin email · no deal room yet');
    expect(labels(message)).toEqual(['Review', 'Enter slug', 'Not Penguin', 'Skip']);
    await setDealRoomSlug(h.worker, { dealId: deal.id, slug: 'larkfield', actor: APPROVER, via: 'ui' });
    await work();
    expect((await offerFor(pool, proposal.id))!.action.type).toBe(DEALROOM_PR_ACTION);
    expect(linesOf(last())[2]).toBe('Approving opens a deal room pull request. Nothing is live until a person merges it');
    expect(room.calls).toEqual([]);
  });
});
