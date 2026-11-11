import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestTranscript, normalizeUpload, removeTranscript } from '../src/calls/ingest.js';
import { createRepoAdapter } from '../src/dealroom/adapter.js';
import { createDealRoomRepo } from '../src/dealroom/github.js';
import { syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { runExpiry } from '../src/recommendations/expiry.js';
import { listApprovals } from '../src/recommendations/service.js';
import type { Recommendation } from '../src/recommendations/types.js';
import { DEALROOM_NOT_CONFIGURED, DEALROOM_PR_ACTION, FINALIZE_ACTION } from '../src/sales/catalog.js';
import { syncDealRoom } from '../src/sales/dealroomSync.js';
import { SALES_ACTIONS, postSales, resumeHeldSalesPosts } from '../src/sales/delivery.js';
import { classifyCall, draftProposal } from '../src/sales/pipeline.js';
import { REGENERATE_MODAL, REVIEW_MODAL, SLUG_MODAL } from '../src/sales/slack.js';
import { getDeal, getSalesCall, listProposals, listUpdates, offerFor, proposalForCall } from '../src/sales/store.js';
import type { Deal, Proposal } from '../src/sales/types.js';
import { setPaused } from '../src/settings/pause.js';
import { setSetting } from '../src/settings/settings.js';
import type { SlackView } from '../src/slack/client.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES } from '../src/slack/messages.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { transcript } from './fixtures/calls.js';
import { FakeModel } from './fixtures/model.js';
import { APP_KEY, DEALROOM_REPO, FakeGitHub, PENGUIN, SALES_TEXT, briefAnswer, classifyAnswer, cleanCheck, draftAnswer, prospect, salesCall, seedCatalog } from './fixtures/sales.js';
import type { Harness } from './helpers.js';
import { APPROVER, BASE_URL, HUB, OWNER, SIGNING_SECRET, STRANGER, VIEWER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The sales call's Slack message and its buttons, through to a final proposal and a deal
 * room pull request. Slack, the model and GitHub are stand-ins; the call is made up. Nothing
 * here has run against the real services, and the deal room repository was never touched.
 */
const pool = testPool();
const CHANNEL = 'C0SALES';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T0HUB/1/abc';
const PENGUIN_HOST = { hostEmail: PENGUIN, attendees: [{ name: 'Morgan Host', email: PENGUIN, external: false }, prospect.jo, prospect.lee] };

let h: Harness;
let model: FakeModel;
let github: FakeGitHub;
let app: ReturnType<typeof createApp>;
const said: string[] = [];

function setup(options: { dealRoom?: boolean } = {}) {
  model = new FakeModel();
  github = new FakeGitHub();
  const dealRoom = options.dealRoom === false ? null : createRepoAdapter(createDealRoomRepo({ appId: '4242', privateKey: APP_KEY, installationId: '777', fetch: github.fetch }));
  h = harness(pool, { integrations: testIntegrations({ model, dealRoom }) });
  app = createApp(webDeps(h));
}

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'sales', CHANNEL);
  await routeTo(pool, 'errors', 'C0ERRORS');
  await setSetting(pool, 'calls.internal_domains', 'agency.example', OWNER);
  await setSetting(pool, 'sales.penguin_emails', PENGUIN, OWNER);
  await setSetting(pool, 'sales.dealroom_repo', DEALROOM_REPO, OWNER);
  await seedCatalog(pool, OWNER);
  said.length = 0;
  setup();
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

/** Runs what was enqueued, the way the worker would, until nothing is left. */
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

function answers(overrides: { brief?: unknown; draft?: unknown; check?: unknown } = {}): void {
  model
    .on('record_deal_brief', overrides.brief ?? briefAnswer())
    .on('record_proposal', overrides.draft ?? draftAnswer())
    .on('record_grounding_check', overrides.check ?? cleanCheck());
}

async function received(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await ingestTranscript(h, transcript(salesCall(overrides)), null);
  h.queue.clear();
  return (result as { callId: string }).callId;
}

interface Posted {
  callId: string;
  proposal: Proposal;
  deal: Deal;
  message: Message;
}

const current = async (callId: string): Promise<{ proposal: Proposal; deal: Deal; offer: Recommendation | null }> => {
  const proposal = (await proposalForCall(pool, callId))!;
  return { proposal, deal: (await getDeal(pool, proposal.dealId))!, offer: await offerFor(pool, proposal.id) };
};

/** A sales call the model was sure about, drafted and posted: what an approver finds in Slack. */
async function posted(overrides: Record<string, unknown> = {}): Promise<Posted> {
  const callId = await received(overrides);
  model.on('record_call_type', classifyAnswer());
  answers();
  await classifyCall(h.worker, callId);
  await work();
  const { proposal, deal } = await current(callId);
  return { callId, proposal, deal, message: last() };
}

/** A Penguin deal whose room a person has named: the approval offers a deal room pull request. */
async function penguinPosted(): Promise<Posted> {
  const first = await posted(PENGUIN_HOST);
  await click(buttonOf(first.message, 'Enter slug'));
  await submit(openedView(), { slug: { value: { value: 'larkfield' } } });
  await work();
  const { proposal, deal } = await current(first.callId);
  return { callId: first.callId, proposal, deal, message: last() };
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

const submit = (view: SlackView, values: Record<string, unknown>, userId = APPROVER) =>
  interact({
    type: 'view_submission',
    team: { id: HUB },
    user: { id: userId, team_id: HUB },
    view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } },
  }).expect(200);

const openedView = (): SlackView => (h.slack.of('openView').at(-1) as { view: SlackView }).view;
const told = (): string[] => [...said, ...h.queue.of('slack.respond').map((j) => j.text)];

describe('"Sales call?"', () => {
  async function asked(): Promise<{ callId: string; message: Message }> {
    const callId = await received();
    model.on('record_call_type', classifyAnswer('sales_discovery', 0.62));
    answers();
    await classifyCall(h.worker, callId);
    await work();
    return { callId, message: last() };
  }

  it('asks in the sales channel when the model is not sure, and drafts once an approver says yes', async () => {
    const { callId, message } = await asked();
    expect(message.channel).toBe(CHANNEL);
    expect(linesOf(message)).toEqual(['*Sales call?* · "Larkfield intro" · 41 min', 'This looks like a sales call (0.62). Draft a proposal from it?']);
    expect(labels(message)).toEqual(['Yes, draft proposal', 'No']);
    expect(model.sent('record_deal_brief')).toEqual([]);

    await click(buttonOf(message, 'Yes, draft proposal'));
    expect(await getSalesCall(pool, callId)).toMatchObject({ state: 'drafting', decidedBy: APPROVER });
    await work();

    // The same message, edited in place: no second post.
    expect(messages('postMessage')).toHaveLength(1);
    expect(linesOf(last())[0]).toBe('*Sales call* · Larkfield Outfitters (Jo P.) · 41 min');
    expect(labels(last())).toEqual(['Review', 'Approve', 'Regenerate', 'Not a deal']);
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['call.type.set', 'proposal.draft']));
  });

  it('drops the call from the pipeline on No, and drafts nothing', async () => {
    const { callId, message } = await asked();
    await click(buttonOf(message, 'No'));
    await work();
    expect(await getSalesCall(pool, callId)).toMatchObject({ state: 'declined', decidedBy: APPROVER });
    expect(linesOf(last())).toEqual(['*Sales call* · Larkfield intro · not a sales call', `Marked by <@${APPROVER}>`]);
    expect(labels(last())).toEqual([]);
    expect(model.sent('record_deal_brief')).toEqual([]);
  });

  it('takes the answer only from someone on the approver list, and only on the current message', async () => {
    const { callId, message } = await asked();
    await click(buttonOf(message, 'Yes, draft proposal'), VIEWER);
    await click(buttonOf(message, 'Yes, draft proposal'), STRANGER);
    expect(told()).toEqual(['You are not on the approver list for this.', 'You do not have access to Patcher.']);
    expect((await getSalesCall(pool, callId))!.state).toBe('asked');

    await click(buttonOf(message, 'No'));
    h.queue.clear();
    // The old button, pressed again by someone who still has the old message on screen.
    await click(buttonOf(message, 'Yes, draft proposal'));
    expect(told()).toEqual(['This message is out of date. Check the current one.']);
    expect((await getSalesCall(pool, callId))!.state).toBe('declined');
  });
});

describe('a drafted proposal', () => {
  it('is one short message with the gaps named and at most four buttons', async () => {
    const { proposal, message, callId } = await posted();
    expect(linesOf(message)).toEqual([
      '*Sales call* · Larkfield Outfitters (Jo P.) · 41 min',
      'Proposal drafted: Order-to-billing sync, two phases. Gaps: start date, budget, price for Support plan · 4 to check',
    ]);
    expect(linesOf(message).length).toBeLessThanOrEqual(MAX_LINES);
    expect(buttonsOf(message).length).toBeLessThanOrEqual(MAX_BUTTONS);
    expect(labels(message)).toEqual(['Review', 'Approve', 'Regenerate', 'Not a deal']);
    expect(buttonOf(message, 'Approve')).toMatchObject({ action_id: ACTION_IDS.approve, style: 'primary' });

    // Behind the Approve button is a recommendation in the shared loop, with the call's words as evidence.
    const offer = (await offerFor(pool, proposal.id))!;
    expect(offer).toMatchObject({ kind: 'proposal', status: 'posted', risk: 'low', title: 'Proposal v1 · Larkfield Outfitters', slackChannel: CHANNEL });
    expect(offer.action.type).toBe(FINALIZE_ACTION);
    expect(offer.action.params).toMatchObject({ proposalId: proposal.id, version: 1, contentHash: proposal.contentHash });
    expect(offer.evidence.length).toBeGreaterThan(0);
    expect(offer.evidence[0]).toMatchObject({ source: 'Call "Larkfield intro" at 00:01:10' });
    expect((await getSalesCall(pool, callId))!.slackTs).toBeTruthy();
  });

  it('becomes final on Approve, with the PDF link for a person to send, and sends nothing itself', async () => {
    const { proposal, message, callId } = await posted();
    await click(buttonOf(message, 'Approve'));
    await work();

    const after = (await proposalForCall(pool, callId))!;
    expect(after).toMatchObject({ status: 'final', finalizedBy: APPROVER });
    expect((await getDeal(pool, after.dealId))!.stage).toBe('proposal_final');
    expect(linesOf(last())).toEqual([
      '*Sales call* · Larkfield Outfitters (Jo P.) · 41 min',
      `<${BASE_URL}/sales/proposals/${proposal.id}|Proposal v1> final · approved by <@${APPROVER}> · <${BASE_URL}/sales/proposals/${proposal.id}/pdf|PDF> for a person to send`,
    ]);
    expect(labels(last())).toEqual([]);
    expect((await listApprovals(pool, (await offerFor(pool, proposal.id))!.id)).map((a) => `${a.decision}/${a.via}/${a.actor}`)).toEqual([`approved/slack/${APPROVER}`]);
    expect(await auditActions(pool)).toContain('proposal.final');
    // Not a Penguin deal: nothing goes near the deal room.
    expect(github.calls).toEqual([]);
    expect(await listUpdates(pool, after.dealId)).toEqual([]);
  });

  it('refuses an approval from someone who is not on the approver list', async () => {
    const { message, callId } = await posted();
    await click(buttonOf(message, 'Approve'), VIEWER);
    await click(buttonOf(message, 'Approve'), STRANGER);
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(told()).toHaveLength(2);
  });

  it('does nothing in dry run, and says so', async () => {
    await setSetting(pool, 'dry_run', true, OWNER);
    const { message, callId } = await penguinPosted();
    await click(buttonOf(message, 'Approve'));
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(github.writes()).toEqual([]);
    expect(linesOf(last())[1]).toMatch(/approved by <@U0APPROVER> in dry run · nothing was done$/);
  });

  it('opens Review with each section in a box; a changed section is a new version and the old approval no longer counts', async () => {
    const { proposal, message, callId, deal } = await posted();
    await click(buttonOf(message, 'Review'));
    const view = openedView();
    expect(view.callback_id).toBe(REVIEW_MODAL);
    const blocks = view.blocks as { type: string; block_id?: string; label?: { text: string }; text?: { text: string }; element?: { initial_value?: string } }[];
    expect(blocks[0]!.text!.text).toContain('*Gaps:* start date, budget, price for Support plan');
    expect(blocks[0]!.text!.text).toContain('"Pricing" section was left out');
    expect(blocks.filter((b) => b.block_id?.startsWith('section_')).map((b) => b.label!.text)).toEqual(['Summary', 'Your situation', 'Proposed approach', 'Scope', 'Investment', 'Next steps']);

    const oldApprove = buttonOf(message, 'Approve');
    await submit(view, {
      section_0: { value: { value: 'Larkfield Outfitters wants orders to reach billing on their own.\n\n<img src="https://tracker.example/x.png">' } },
      section_3: { value: { value: '' } },
      penguin: { value: { selected_option: { value: 'no' } } },
    });
    await work();

    const proposals = await listProposals(pool, deal.id);
    expect(proposals.map((p) => `v${p.version} ${p.status} by ${p.createdBy}`)).toEqual([`v2 draft by ${APPROVER}`, 'v1 superseded by system']);
    const v2 = proposals[0]!;
    expect(v2.contentMd).toContain('Larkfield Outfitters wants orders to reach billing on their own.');
    expect(v2.contentMd).not.toContain('<img');
    expect(v2.contentMd.match(/^## .+$/gm)).toEqual(['## Summary', '## Your situation', '## Proposed approach', '## Investment', '## Next steps']);
    expect(v2.flags[0]).toMatch(/^Removed from the edit: .*HTML/);
    expect(v2.hasPdf).toBe(true);

    // The approval that was waiting was for v1 and is closed; the message now offers v2.
    expect((await offerFor(pool, proposal.id))!.status).toBe('expired');
    expect((await offerFor(pool, v2.id))!).toMatchObject({ status: 'posted', title: 'Proposal v2 · Larkfield Outfitters' });
    expect(linesOf(last())[1]).toContain('Proposal drafted');

    await click(oldApprove);
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(told().at(-1)).toMatch(/no longer|already|out of date|expired/i);

    await click(buttonOf(last(), 'Approve'));
    await work();
    expect(await proposalForCall(pool, callId)).toMatchObject({ version: 2, status: 'final' });
  });

  it('drafts again with the approver\'s note on Regenerate, as the next version', async () => {
    const { message, callId, deal } = await posted();
    await click(buttonOf(message, 'Regenerate'));
    const view = openedView();
    expect(view.callback_id).toBe(REGENERATE_MODAL);
    await submit(view, { note: { value: { value: 'Shorter, and lead with the dashboard.' } } });
    expect(await getSalesCall(pool, callId)).toMatchObject({ state: 'drafting', note: 'Shorter, and lead with the dashboard.', requestedBy: APPROVER });
    await work();

    expect(model.sent('record_proposal')[1]!.user).toContain('<approver_note>\nShorter, and lead with the dashboard.');
    expect((await listProposals(pool, deal.id)).map((p) => `v${p.version} ${p.status}`)).toEqual(['v2 draft', 'v1 superseded']);
    expect((await getSalesCall(pool, callId))!.note).toBeNull();
    expect(labels(last())).toEqual(['Review', 'Approve', 'Regenerate', 'Not a deal']);
    expect(await auditActions(pool)).toContain('call.proposal.regenerate');
  });

  it('records "Not a deal" as a dismissal in the loop and closes the call', async () => {
    const { proposal, message, callId } = await posted();
    await click(buttonOf(message, 'Not a deal'));
    await work();
    expect((await offerFor(pool, proposal.id))!).toMatchObject({ status: 'dismissed', decidedBy: APPROVER });
    expect((await proposalForCall(pool, callId))!.status).toBe('dismissed');
    expect((await getSalesCall(pool, callId))!.state).toBe('declined');
    expect(linesOf(last())).toEqual(['*Sales call* · Larkfield intro · not a deal', `Marked by <@${APPROVER}>`]);
    expect(labels(last())).toEqual([]);
  });

  it('says when nobody decided in time, and leaves Review and Regenerate', async () => {
    const { proposal, callId } = await posted();
    await pool.query(`UPDATE recommendations SET expires_at = now() + interval '1 hour'`);
    await runExpiry(h.worker);
    // One reminder in the message's thread, before anything expires.
    expect((h.slack.of('postMessage') as { threadTs?: string }[]).filter((m) => m.threadTs)).toHaveLength(1);
    await pool.query(`UPDATE recommendations SET expires_at = now() - interval '1 minute'`);
    await runExpiry(h.worker);
    await work();
    expect((await offerFor(pool, proposal.id))!.status).toBe('expired');
    expect(linesOf(last())[1]).toBe(`<${BASE_URL}/sales/proposals/${proposal.id}|Proposal v1> expired without a decision`);
    expect(labels(last())).toEqual(['Review', 'Regenerate']);
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
  });

  it('shows a failed draft with its reason and a Retry that drafts again', async () => {
    const callId = await received();
    model.on('record_call_type', classifyAnswer());
    const invented = { text: 'Something', quote: 'These words were never said.' };
    answers({ brief: briefAnswer({ problem: invented, outcome: invented, scope: [invented] }) });
    await classifyCall(h.worker, callId);
    await work();
    expect(linesOf(last())[0]).toBe('*Sales call* · Larkfield intro · proposal not drafted');
    expect(linesOf(last())[1]).toMatch(/nothing a proposal could stand on/);
    expect(labels(last())).toEqual(['Retry']);

    answers();
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(labels(last())).toEqual(['Review', 'Approve', 'Regenerate', 'Not a deal']);
  });

  it('waits while paused or without a sales channel, and posts once it can', async () => {
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'sales'`);
    const callId = await received();
    model.on('record_call_type', classifyAnswer());
    answers();
    await classifyCall(h.worker, callId);
    await work();
    expect(messages('postMessage')).toEqual([]);
    expect((await getSalesCall(pool, callId))!.postError).toMatch(/no channel is set for/);
    // Nothing can be approved before it has been shown.
    expect((await current(callId)).offer!.status).toBe('drafted');

    await routeTo(pool, 'sales', CHANNEL);
    await setPaused(h, true, OWNER);
    expect(await postSales(h.worker, callId)).toBe('held');
    expect((await getSalesCall(pool, callId))!.postError).toBe('Waiting: Patcher is paused.');
    await setPaused(h, false, OWNER);
    h.queue.clear();

    expect(await resumeHeldSalesPosts(h.worker)).toBe(1);
    await work();
    expect(messages('postMessage')).toHaveLength(1);
    expect((await current(callId)).offer!.status).toBe('posted');
    expect((await getSalesCall(pool, callId))!.postError).toBeNull();
  });

  it('withdraws the offer and the draft when the recording is deleted at its source', async () => {
    const { proposal, callId } = await posted({ source: 'fathom', externalId: 'rec-larkfield' });
    await removeTranscript(h, 'fathom', 'rec-larkfield');
    await work();
    const offer = (await offerFor(pool, proposal.id))!;
    expect(offer.status).toBe('expired');
    expect(JSON.stringify(offer.evidence)).not.toContain('spreadsheet');
    expect(linesOf(last())).toEqual(['*Sales call* · Larkfield intro · the recording was deleted at its source']);
    expect(labels(last())).toEqual([]);
    expect((await proposalForCall(pool, callId))!.contentMd).toBe('');
  });
});

describe('a Penguin deal', () => {
  it('is recognised from the host address and asks for the room before it offers anything', async () => {
    const { message, deal, proposal } = await posted(PENGUIN_HOST);
    expect(deal).toMatchObject({ isPenguin: true, penguinReason: 'host' });
    expect(linesOf(message)).toEqual([
      '*Penguin deal* · Larkfield Outfitters · held with your Penguin email · no deal room yet',
      'Proposal drafted: Order-to-billing sync, two phases. Gaps: start date, budget, price for Support plan · 4 to check',
      'Create it at /admin with no client domains, then give me the slug',
    ]);
    expect(labels(message)).toEqual(['Review', 'Enter slug', 'Not Penguin', 'Skip']);
    // No approval is offered until Patcher knows where the content would go.
    expect(await offerFor(pool, proposal.id)).toBeNull();
  });

  it('takes the slug of the room a person created, and then offers a deal room pull request', async () => {
    const first = await posted(PENGUIN_HOST);
    await click(buttonOf(first.message, 'Enter slug'));
    const view = openedView();
    expect(view.callback_id).toBe(SLUG_MODAL);

    const refused = await submit(view, { slug: { value: { value: '../Other Deal' } } });
    expect(refused.body).toMatchObject({ response_action: 'errors', errors: { slug: expect.stringMatching(/lower-case letters, digits and dashes/) } });
    expect((await getDeal(pool, first.deal.id))!.dealRoomSlug).toBeNull();

    await submit(view, { slug: { value: { value: ' Larkfield ' } } });
    await work();
    expect((await getDeal(pool, first.deal.id))!.dealRoomSlug).toBe('larkfield');

    const message = last();
    expect(linesOf(message)).toEqual([
      '*Penguin deal* · Larkfield Outfitters · held with your Penguin email · room larkfield',
      'Proposal v1: 6 sections. Order-to-billing sync, two phases. Gaps: start date, budget, price for Support plan · 4 to check',
      'Approving opens a deal room pull request. Nothing is live until a person merges it',
    ]);
    expect(labels(message)).toEqual(['Review', 'Approve', 'Regenerate', 'Not Penguin']);

    const offer = (await offerFor(pool, first.proposal.id))!;
    expect(offer).toMatchObject({ status: 'posted', risk: 'medium' });
    expect(offer.action.type).toBe(DEALROOM_PR_ACTION);
    expect(offer.action.params).toMatchObject({ repo: DEALROOM_REPO, slug: 'larkfield', version: 1, files: 7 });
    // Nothing has reached GitHub: preparing the files is pure.
    expect(github.calls).toEqual([]);
    expect(await auditActions(pool)).toContain('deal.slug');
  });

  it('opens a content pull request under content/<slug>/ on approval, marks the proposal final, and never merges or pushes to main', async () => {
    const { message, callId, proposal, deal } = await penguinPosted();
    await click(buttonOf(message, 'Approve'));
    await work();

    // What reached the stand-in for GitHub.
    expect(github.tokenRequests).toEqual([{ repositories: ['dealroom'], permissions: { contents: 'write', pull_requests: 'write' } }]);
    expect(github.writes().map((c) => `${c.method} ${c.path.replace(`/repos/${DEALROOM_REPO}`, '')}`)).toEqual(['POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls']);
    expect(github.calls.some((c) => /merge/.test(c.path) || ['PUT', 'PATCH', 'DELETE'].includes(c.method))).toBe(false);
    expect(github.branches.get('main')).toBe('sha-main-1');
    expect(github.pulls).toHaveLength(1);
    const pull = github.pulls[0]!;
    expect(pull).toMatchObject({ base: 'main', state: 'open', merged: false, title: 'Deal room content: Larkfield Outfitters proposal v1' });
    expect(pull.head).toMatch(/^patcher\/larkfield\/proposal-v1-[0-9a-f]{8}$/);
    const files = github.branchFiles(pull.head);
    expect(files.map((f) => f.path)).toEqual([
      'content/larkfield/overview.md',
      'content/larkfield/proposal/01-summary.md',
      'content/larkfield/proposal/02-your-situation.md',
      'content/larkfield/proposal/03-proposed-approach.md',
      'content/larkfield/proposal/04-scope.md',
      'content/larkfield/proposal/05-investment.md',
      'content/larkfield/proposal/06-next-steps.md',
    ]);
    const written = files.map((f) => f.content).join('\n');
    expect(written).not.toMatch(/<script|!\[|45,000/);
    expect(written).toContain('$12,000');
    expect(files[1]!.content).toMatch(/^---\ntitle: Summary\n---\n/);
    expect(pull.body).toContain('**Patcher does not merge this.**');
    expect(pull.body).toContain(`${BASE_URL}/sales/proposals/${proposal.id}`);

    // What Patcher recorded.
    expect(await proposalForCall(pool, callId)).toMatchObject({ status: 'final', finalizedBy: APPROVER });
    const [update] = await listUpdates(pool, deal.id);
    expect(update).toMatchObject({ route: 'pull_request', status: 'pr_open', repo: DEALROOM_REPO, slug: 'larkfield', prNumber: 101, branch: pull.head, error: null });
    expect(update!.files.map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect(update!.manualSteps[0]).toMatch(/Deal Admin/);
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['dealroom.pr.open', 'proposal.final']));

    // What the approver sees.
    expect(linesOf(last())).toEqual([
      '*Penguin deal* · Larkfield Outfitters · deal room PR ready',
      `<${BASE_URL}/sales/proposals/${proposal.id}|Proposal v1>: 6 sections · approved by <@${APPROVER}>. Merging makes it live to everyone in the room`,
    ]);
    expect(labels(last())).toEqual(['Review PR', 'Regenerate', 'Not Penguin']);
    expect(buttonOf(last(), 'Review PR')).toMatchObject({ action_id: SALES_ACTIONS.openPr, url: `https://github.com/${DEALROOM_REPO}/pull/101` });
    // There is no button that merges.
    expect(labels(last()).join(' ')).not.toMatch(/merge|publish/i);
  });

  it('says so when a person merges or closes the pull request', async () => {
    const { message } = await penguinPosted();
    await click(buttonOf(message, 'Approve'));
    await work();
    expect(await syncDealRoom(h.worker)).toBe('1 open, 0 changed');

    github.merge(101);
    expect(await syncDealRoom(h.worker)).toBe('1 open, 1 changed');
    await work();
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room PR merged');
    expect(linesOf(last())[1]).toMatch(/was merged\. It is live in the room once the app has redeployed\.$/);
    expect(await auditActions(pool)).toContain('dealroom.pr.merged');
    // The sync only reads.
    expect(github.writes()).toHaveLength(4);
    expect(await syncDealRoom(h.worker)).toBe('0 open, 0 changed');
  });

  it('offers Regenerate when the pull request was closed without merging', async () => {
    const { message, deal } = await penguinPosted();
    await click(buttonOf(message, 'Approve'));
    await work();
    github.close(101);
    await syncDealRoom(h.worker);
    await work();
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room PR closed');
    expect(labels(last())).toEqual(['Regenerate']);
    expect((await listUpdates(pool, deal.id))[0]!.status).toBe('closed');
  });

  it('shows what GitHub refused and offers Retry, which finishes the same pull request', async () => {
    const { message, callId, deal } = await penguinPosted();
    github.failOn = { match: '/pulls', status: 403, message: 'Resource not accessible by integration' };
    await click(buttonOf(message, 'Approve'));
    await work();

    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect((await listUpdates(pool, deal.id))[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Resource not accessible by integration') });
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room PR not opened');
    expect(linesOf(last())[1]).toContain('could not open the pull request: Resource not accessible by integration (HTTP 403)');
    expect(labels(last())).toEqual(['Retry', 'Review', 'Not Penguin']);

    await click(buttonOf(last(), 'Retry'));
    await work();
    expect(github.pulls).toHaveLength(1);
    // The branch from the first attempt is reused: one tree, one commit, one branch in all.
    expect(github.writes().filter((c) => c.path.endsWith('/git/refs'))).toHaveLength(1);
    expect(await listUpdates(pool, deal.id)).toHaveLength(1);
    expect((await listUpdates(pool, deal.id))[0]).toMatchObject({ status: 'pr_open', prNumber: 101, error: null });
    expect((await proposalForCall(pool, callId))!.status).toBe('final');
    expect(linesOf(last())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room PR ready');
  });

  it('fails with the variables to set when the deal room app is not configured on the worker', async () => {
    setup({ dealRoom: false });
    const { message, callId } = await penguinPosted();
    await click(buttonOf(message, 'Approve'));
    await work();
    expect((await current(callId)).offer).toMatchObject({ status: 'failed', lastError: DEALROOM_NOT_CONFIGURED });
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');
    expect(labels(last())).toContain('Retry');
  });

  it('opens nothing when the proposal, the slug or the mark changed after the approval was given', async () => {
    const { message, callId, deal } = await penguinPosted();
    await click(buttonOf(message, 'Approve'));
    // Approved, not yet run: a person changes the room meanwhile.
    await pool.query(`UPDATE deals SET deal_room_slug = 'another-room' WHERE id = $1`, [deal.id]);
    await work();
    expect((await current(callId)).offer).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/slug changed after the approval/) });
    expect(github.writes()).toEqual([]);

    await pool.query(`UPDATE deals SET deal_room_slug = 'larkfield', is_penguin = false WHERE id = $1`, [deal.id]);
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await current(callId)).offer!.lastError).toMatch(/no longer marked as a Penguin deal/);

    await pool.query(`UPDATE deals SET is_penguin = true WHERE id = $1`, [deal.id]);
    await pool.query(`UPDATE proposals SET content_md = content_md || 'x' WHERE id = (SELECT id FROM proposals WHERE call_id = $1 ORDER BY version DESC LIMIT 1)`, [callId]);
    await click(buttonOf(last(), 'Retry'));
    await work();
    expect((await current(callId)).offer!.lastError).toMatch(/not the ones that were approved/);
    expect(github.writes()).toEqual([]);
    expect(github.pulls).toEqual([]);
  });

  it('lets a person say it is not a Penguin deal: the approval then only finalises the proposal', async () => {
    const { message, callId, deal, proposal } = await penguinPosted();
    const before = (await offerFor(pool, proposal.id))!;
    await click(buttonOf(message, 'Not Penguin'));
    await work();

    expect(await getDeal(pool, deal.id)).toMatchObject({ isPenguin: false, penguinReason: 'flagged', penguinSetBy: APPROVER });
    const offer = (await offerFor(pool, proposal.id))!;
    expect(offer.id).not.toBe(before.id);
    expect(offer.action.type).toBe(FINALIZE_ACTION);
    expect(linesOf(last())[0]).toBe('*Sales call* · Larkfield Outfitters (Jo P.) · 41 min');
    expect(labels(last())).toEqual(['Review', 'Approve', 'Regenerate', 'Not a deal']);

    // The button of the earlier message approves nothing.
    await click(buttonOf(message, 'Approve'));
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('draft');

    await click(buttonOf(last(), 'Approve'));
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('final');
    expect(github.calls).toEqual([]);
    expect(await auditActions(pool)).toContain('deal.penguin');
  });

  it('lets a person skip the deal room for a Penguin deal', async () => {
    const { message, callId, deal } = await posted(PENGUIN_HOST);
    await click(buttonOf(message, 'Skip'));
    await work();
    expect(await getDeal(pool, deal.id)).toMatchObject({ isPenguin: true, dealRoomSkipped: true });
    expect((await current(callId)).offer!.action.type).toBe(FINALIZE_ACTION);
    expect(labels(last())).toEqual(['Review', 'Approve', 'Regenerate', 'Not a deal']);
    await click(buttonOf(last(), 'Approve'));
    await work();
    expect((await proposalForCall(pool, callId))!.status).toBe('final');
    expect(github.calls).toEqual([]);
  });

  it('asks "Penguin deal?" when the transcript carries no addresses, and a person can say yes', async () => {
    const upload = await ingestTranscript(h, normalizeUpload({ title: 'Larkfield intro (pasted)', startedAt: null, text: SALES_TEXT }), null);
    const callId = (upload as { callId: string }).callId;
    h.queue.clear();
    model.on('record_call_type', classifyAnswer());
    answers();
    await classifyCall(h.worker, callId);
    await work();

    expect(linesOf(last())[2]).toBe('Penguin deal? The transcript carries no addresses, so I cannot tell');
    expect(labels(last())).toEqual(['Review', 'Yes, Penguin', 'Not Penguin', 'Not a deal']);
    expect((await current(callId)).offer).toBeNull();

    await click(buttonOf(last(), 'Yes, Penguin'), VIEWER);
    expect(told().at(-1)).toBe('You are not on the approver list for this.');
    await click(buttonOf(last(), 'Yes, Penguin'));
    await work();
    expect((await current(callId)).deal).toMatchObject({ isPenguin: true, penguinReason: 'flagged', penguinSetBy: APPROVER });
    expect(linesOf(last())[0]).toBe(`*Penguin deal* · Larkfield Outfitters · marked by <@${APPROVER}> · no deal room yet`);
    expect(labels(last())).toEqual(['Review', 'Enter slug', 'Not Penguin', 'Skip']);
  });

  it('can be marked in the Review form of a call the rule did not catch', async () => {
    const { message, callId } = await posted();
    await click(buttonOf(message, 'Review'));
    await submit(openedView(), { penguin: { value: { selected_option: { value: 'yes' } } } });
    await work();
    expect((await current(callId)).deal).toMatchObject({ isPenguin: true, penguinReason: 'flagged' });
    // Nothing in the text changed, so there is no new version.
    expect((await current(callId)).proposal.version).toBe(1);
    expect(labels(last())).toEqual(['Review', 'Enter slug', 'Not Penguin', 'Skip']);
  });
});
