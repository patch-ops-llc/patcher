import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../src/audit/auditLog.js';
import { listCalls } from '../src/calls/store.js';
import { createRepoAdapter } from '../src/dealroom/adapter.js';
import { createDealRoomRepo } from '../src/dealroom/github.js';
import type { JobName } from '../src/queue/jobs.js';
import type { JobQueue } from '../src/queue/queue.js';
import { registerSalesSeam } from '../src/sales/pipeline.js';
import { listDeals, listProposals, listUpdates } from '../src/sales/store.js';
import type { SlackView } from '../src/slack/client.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { registerHandlers, runSchedule, scheduleHandlers } from '../src/worker/handlers.js';
import { FakeSource, matchAnswer, seedRegistry, testSecrets, transcript } from './fixtures/calls.js';
import { FakeModel } from './fixtures/model.js';
import { APP_KEY, DEALROOM_REPO, FakeGitHub, PENGUIN, briefAnswer, checkAnswer, classifyAnswer, draftAnswer, prospect, salesCall } from './fixtures/sales.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, SIGNING_SECRET, harness, resetDb, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The phase 3a milestone, through the same HTTP routes and job handlers the two services
 * run: a sales call recorded with a Penguin address arrives by webhook, is detected, gets a
 * proposal draft, is posted to the sales channel as one short message, and after a person
 * names the deal's room and approves, a content pull request is opened on the deal room
 * repository. Nothing is merged.
 *
 * Fathom, the model, Slack and GitHub are all stand-ins, and the call is made up. The real
 * deal room repository was not read or written.
 */
const pool = testPool();
const secrets = testSecrets();
const PUBLIC_URL = 'https://patcher.example';

type Handler = (data: unknown, meta: { jobId: string; attempt: number }) => Promise<void>;

let h: Harness;
let model: FakeModel;
let github: FakeGitHub;
let fathom: FakeSource;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;
let handlers: Map<string, Handler>;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await seedRegistry(pool, OWNER);
  model = new FakeModel();
  github = new FakeGitHub();
  fathom = new FakeSource('fathom');
  const dealRoom = createRepoAdapter(createDealRoomRepo({ appId: '4242', privateKey: APP_KEY, installationId: '777', fetch: github.fetch }));
  h = harness(pool, {
    integrations: testIntegrations({ model, dealRoom, transcripts: { calendly: new FakeSource('calendly'), fathom } }),
    secrets: secrets.box,
    appBaseUrl: PUBLIC_URL,
  });
  deps = webDeps(h, { seal: secrets.seal, appBaseUrl: PUBLIC_URL });
  app = createApp(deps);

  // What the worker does at start: its consumers, and the sales pipeline attached to the call pipeline.
  handlers = new Map();
  const collector = {
    work: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return Promise.resolve();
    },
    onDeadLetter: () => Promise.resolve(),
  };
  await registerHandlers(collector as unknown as JobQueue, h.worker);
  registerSalesSeam();
});
afterAll(() => pool.end());

async function drain(later: JobName[] = []): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const index = h.queue.jobs.findIndex((j) => !later.includes(j.name));
    if (index < 0) return ran;
    const [job] = h.queue.jobs.splice(index, 1);
    const handler = handlers.get(job!.name);
    if (!handler) throw new Error(`No handler for ${job!.name}`);
    await handler(job!.data, { jobId: `job-${i}`, attempt: 0 });
    ran.push(job!.name);
  }
  throw new Error('The queue did not settle.');
}

const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)![1]!;

async function signIn(userId: string) {
  deps.oidc.identity = { teamId: HUB, userId, name: null, email: null };
  const agent = request.agent(app);
  await agent.get('/auth/slack');
  await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState }).expect(302);
  const csrf = csrfOf((await agent.get('/settings').expect(200)).text);
  const post = (path: string, fields: Record<string, string> = {}) => agent.post(path).type('form').send({ _csrf: csrf, ...fields });
  return { agent, post };
}

interface Button {
  action_id: string;
  value?: string;
  url?: string;
  text: { text: string };
}
interface Message {
  channel: string;
  threadTs?: string;
  text: string;
  blocks: [{ text: { text: string } }, { elements: Button[] }?];
}
const salesPosts = () => (h.slack.of('postMessage') as unknown as Message[]).filter((m) => m.channel === 'C0SALES' && !m.threadTs);
const lastEdit = () => (h.slack.of('updateMessage') as unknown as Message[]).filter((m) => m.channel === 'C0SALES').at(-1)!;
const linesOf = (m: Message) => m.blocks[0].text.text.split('\n');
const labels = (m: Message) => (m.blocks[1]?.elements ?? []).map((b) => b.text.text);
const buttonOf = (m: Message, label: string) => m.blocks[1]!.elements.find((b) => b.text.text === label)!;

function interact(payload: Record<string, unknown>) {
  const body = new URLSearchParams({ payload: JSON.stringify({ team: { id: HUB }, user: { id: APPROVER, team_id: HUB }, ...payload }) }).toString();
  const ts = Math.floor(Date.now() / 1000);
  return request(app)
    .post('/slack/interactions')
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', String(ts))
    .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, body))
    .send(body)
    .expect(200);
}
const click = (button: Button) =>
  interact({ type: 'block_actions', trigger_id: 'trigger-1', response_url: 'https://hooks.slack.com/actions/T0HUB/1/abc', actions: [{ action_id: button.action_id, value: button.value }] });

describe('phase 3a milestone', () => {
  it('takes a sales call with a Penguin address to an approved proposal and a deal room pull request', async () => {
    // 1. In the UI the owner routes the sales channel, saves the Penguin address and the rate card, and connects Fathom.
    const owner = await signIn(OWNER);
    await owner.post('/settings/routes/sales', { channel_id: 'C0SALES' }).expect(303);
    await owner.post('/settings/routes/calls', { channel_id: 'C0CALLS' }).expect(303);
    await owner.post('/settings/calls', { 'calls.enabled': '1', 'ai.calls.enabled': '1', 'calls.settle_minutes': '0', 'calls.internal_domains': 'agency.example' }).expect(303);
    await owner
      .post('/settings/sales', { 'sales.enabled': '1', 'ai.sales.enabled': '1', 'sales.penguin_emails': PENGUIN, 'sales.dealroom_repo': DEALROOM_REPO })
      .expect(303);
    await owner.post('/sales/catalog', { key: 'integration', name: 'System integration', description: 'Connecting two systems.', unit: 'integration', price: '12000', active: '1' }).expect(303);
    await owner.post('/settings/calls/connections', { source: 'fathom:personal', owner: 'Morgan', key: 'made-up-fathom-key-morgan' }).expect(303);
    await drain();

    // 2. The call ends and Fathom's webhook arrives. The Penguin address recorded the call.
    fathom.add(
      transcript(
        salesCall({
          source: 'fathom',
          externalId: 'rec-larkfield',
          hostEmail: PENGUIN,
          attendees: [{ name: 'Morgan Host', email: PENGUIN, external: false }, prospect.jo, prospect.lee],
        }),
      ),
    );
    model
      .on('record_call_match', matchAnswer('none', 0, ''))
      .on('record_call_type', classifyAnswer('sales_discovery', 0.93))
      .on('record_deal_brief', briefAnswer())
      .on('record_proposal', draftAnswer())
      .on('record_grounding_check', checkAnswer());
    await request(app)
      .post(new URL(fathom.webhooks[0]!.url).pathname)
      .set('content-type', 'application/json')
      .set('webhook-id', 'msg_1')
      .set('webhook-timestamp', '1700000000')
      .set('webhook-signature', fathom.webhooks[0]!.secret)
      .send(JSON.stringify({ kind: 'ready', id: 'rec-larkfield', embed: true }))
      .expect(200, { ok: true });
    const ran = await drain();
    expect(ran).toEqual(expect.arrayContaining(['calls.analyze', 'sales.classify', 'sales.draft', 'sales.post']));

    // One call, read once for its type; one deal, marked by the rule; one proposal.
    const [call] = await listCalls(pool);
    expect(call).toMatchObject({ title: 'Larkfield intro', callType: 'sales_discovery' });
    expect(model.sent('record_call_type')).toHaveLength(1);
    const [deal] = await listDeals(pool);
    expect(deal).toMatchObject({ company: 'Larkfield Outfitters', isPenguin: true, penguinReason: 'host', proposalVersion: 1, proposalStatus: 'draft' });
    // Every tool the model was handed only records an answer, and no key or price reached it.
    for (const sent of model.requests) {
      expect(sent.tool.name).toMatch(/^record_/);
      expect(`${sent.system}\n${sent.user}`).not.toMatch(/made-up-fathom-key|12,?000|BEGIN RSA|@penguin\.example|@larkfield\.example/);
    }

    // 3. One short message in the sales channel. Nothing can be approved until the room is named.
    expect(salesPosts()).toHaveLength(1);
    const first = salesPosts()[0]!;
    expect(linesOf(first)[0]).toBe('*Penguin deal* · Larkfield Outfitters · held with your Penguin email · no deal room yet');
    expect(labels(first)).toEqual(['Review', 'Enter slug', 'Not Penguin', 'Skip']);
    expect(github.calls).toEqual([]);

    // 4. A person created the room in the deal room admin and gives Patcher its slug.
    await click(buttonOf(first, 'Enter slug'));
    const view = (h.slack.of('openView').at(-1) as { view: SlackView }).view;
    await interact({ type: 'view_submission', view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { slug: { value: { value: 'larkfield' } } } } } });
    await drain();
    expect(labels(lastEdit())).toEqual(['Review', 'Approve', 'Regenerate', 'Not Penguin']);
    expect(linesOf(lastEdit())[2]).toBe('Approving opens a deal room pull request. Nothing is live until a person merges it');
    expect(github.writes()).toEqual([]);

    // 5. The approver approves in Slack. Only now is anything written, and only a pull request.
    await click(buttonOf(lastEdit(), 'Approve'));
    await drain();
    expect(github.pulls).toHaveLength(1);
    const pull = github.pulls[0]!;
    expect(pull).toMatchObject({ base: 'main', state: 'open', merged: false });
    expect(pull.head).toMatch(/^patcher\/larkfield\/proposal-v1-/);
    const files = github.branchFiles(pull.head);
    expect(files.length).toBeGreaterThan(3);
    expect(files.every((f) => f.path.startsWith('content/larkfield/'))).toBe(true);
    expect(files.map((f) => f.content).join('\n')).not.toMatch(/45,000|We guarantee zero failed orders|<script/);
    expect(github.branches.get('main')).toBe('sha-main-1');
    expect(github.calls.some((c) => /merge/.test(c.path) || ['PUT', 'PATCH', 'DELETE'].includes(c.method))).toBe(false);

    expect(linesOf(lastEdit())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room PR ready');
    expect(buttonOf(lastEdit(), 'Review PR').url).toBe(`https://github.com/${DEALROOM_REPO}/pull/101`);
    expect((await listProposals(pool, deal!.id))[0]).toMatchObject({ status: 'final', finalizedBy: APPROVER });
    expect((await listUpdates(pool, deal!.id))[0]).toMatchObject({ status: 'pr_open', prNumber: 101 });

    // 6. A person merges it in GitHub; the schedule notices and the message says so.
    github.merge(101);
    await runSchedule(h.worker, scheduleHandlers, { key: 'dealroom.sync', trigger: 'schedule' });
    await drain();
    expect(linesOf(lastEdit())[0]).toBe('*Penguin deal* · Larkfield Outfitters · deal room PR merged');
    expect(salesPosts()).toHaveLength(1);

    // 7. The activity log has who did what, and the UI shows the deal to someone signed in.
    const log = await listAudit(pool, 300);
    const actions = log.map((entry) => entry.action);
    for (const action of ['call.classify', 'deal.create', 'deal.penguin', 'proposal.draft', 'sales.post', 'deal.slug', 'recommendation.approve', 'dealroom.pr.open', 'proposal.final', 'dealroom.pr.merged']) {
      expect(actions).toContain(action);
    }
    expect(log.find((entry) => entry.action === 'recommendation.approve')!.actor).toBe(APPROVER);
    expect(log.find((entry) => entry.action === 'deal.slug')!.actor).toBe(APPROVER);

    const page = (await owner.agent.get(`/sales/deals/${deal!.id}`).expect(200)).text;
    expect(page).toContain('Penguin deal');
    expect(page).toContain(`https://github.com/${DEALROOM_REPO}/pull/101`);
    expect(page).toContain('Merged');
  });
});
