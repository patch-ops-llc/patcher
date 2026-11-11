import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../src/audit/auditLog.js';
import { listConnections } from '../src/calls/connections.js';
import { listCalls, listTranscripts } from '../src/calls/store.js';
import type { JobQueue } from '../src/queue/queue.js';
import type { JobName } from '../src/queue/jobs.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { registerHandlers, runSchedule, scheduleHandlers } from '../src/worker/handlers.js';
import { FakeSource, PORTAL_REPO, briefAnswer, matchAnswer, people, seedRegistry, suggestionsAnswer, testSecrets, transcript } from './fixtures/calls.js';
import { FakeCursor } from './fixtures/cursor.js';
import { FakeModel } from './fixtures/model.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, SIGNING_SECRET, harness, resetDb, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The phase 2 milestone, through the same HTTP routes and job handlers the two services
 * run: a call recorded by both Fathom and Calendly arrives by webhook and by poll, is
 * analysed once, matched to its project, posted to Slack as one short message, approved
 * there, and its code change goes to an agent that opens a pull request.
 *
 * Calendly, Fathom, the model, Slack and Cursor are all stand-ins, and the call is made up.
 */
const pool = testPool();
const secrets = testSecrets();
const PUBLIC_URL = 'https://patcher.example';

type Handler = (data: unknown, meta: { jobId: string; attempt: number }) => Promise<void>;

let h: Harness;
let model: FakeModel;
let cursor: FakeCursor;
let fathom: FakeSource;
let calendly: FakeSource;
let deps: ReturnType<typeof webDeps>;
let app: ReturnType<typeof createApp>;
let handlers: Map<string, Handler>;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await seedRegistry(pool, OWNER);
  model = new FakeModel();
  cursor = new FakeCursor();
  fathom = new FakeSource('fathom');
  calendly = new FakeSource('calendly');
  h = harness(pool, {
    integrations: testIntegrations({ model, cursor, transcripts: { calendly, fathom } }),
    secrets: secrets.box,
    appBaseUrl: PUBLIC_URL,
  });
  deps = webDeps(h, { seal: secrets.seal });
  app = createApp(deps);

  // The worker's own list of consumers, collected instead of attached to a real queue.
  handlers = new Map();
  const collector = {
    work: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return Promise.resolve();
    },
    onDeadLetter: () => Promise.resolve(),
  };
  await registerHandlers(collector as unknown as JobQueue, h.worker);
});
afterAll(() => pool.end());

/**
 * Runs queued jobs through the worker's handlers until none are left, in the order they
 * were queued. Start delays are ignored; `later` names jobs to leave for a later call.
 */
async function drain(later: JobName[] = ['agent.poll']): Promise<string[]> {
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
  value: string;
  text: { text: string };
}
interface Message {
  channel: string;
  threadTs?: string;
  text: string;
  blocks: [{ text: { text: string } }, { elements: Button[] }?];
}
const posts = () => h.slack.of('postMessage') as unknown as Message[];
const edits = () => h.slack.of('updateMessage') as unknown as Message[];

function click(button: Button, userId: string) {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: HUB },
      user: { id: userId, team_id: HUB },
      trigger_id: 'trigger-1',
      response_url: 'https://hooks.slack.com/actions/T0HUB/1/abc',
      actions: [{ action_id: button.action_id, value: button.value }],
    }),
  }).toString();
  const ts = Math.floor(Date.now() / 1000);
  return request(app)
    .post('/slack/interactions')
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', String(ts))
    .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, body))
    .send(body)
    .expect(200);
}

describe('phase 2 milestone', () => {
  it('takes one call from two recorders to an approved change and a pull request', async () => {
    // 1. In the UI an owner picks the channel, sets the settle time and connects both sources.
    const owner = await signIn(OWNER);
    await owner.post('/settings/routes/calls', { channel_id: 'C0CALLS' }).expect(303);
    await owner.post('/settings/calls', { 'calls.enabled': '1', 'ai.calls.enabled': '1', 'calls.settle_minutes': '0', 'calls.internal_domains': 'agency.example' }).expect(303);
    await owner.post('/settings/calls/connections', { source: 'fathom:personal', owner: 'Morgan', key: 'made-up-fathom-key-morgan' }).expect(303);
    await owner.post('/settings/calls/connections', { source: 'calendly', owner: 'Agency', key: 'made-up-calendly-token' }).expect(303);
    // Checking a key also starts its first catch-up poll.
    expect(await drain()).toEqual(['calls.connection.setup', 'calls.connection.setup', 'calls.poll', 'calls.poll']);
    expect((await listConnections(pool)).map((c) => [c.source, c.status, c.hasWebhook])).toEqual(
      expect.arrayContaining([['fathom', 'connected', true], ['calendly', 'connected', true]]),
    );
    // Each webhook was registered with that connection's own key, at an address only the vendor knows.
    expect(fathom.webhooks[0]).toMatchObject({ key: 'made-up-fathom-key-morgan', url: expect.stringMatching(/^https:\/\/patcher\.example\/webhooks\/fathom\/[\w-]{43}$/) as string });
    expect(calendly.webhooks[0]).toMatchObject({ key: 'made-up-calendly-token' });

    // 2. The call ends. Fathom's webhook arrives; Calendly's copy is found by the catch-up poll.
    const fathomCopy = transcript({ source: 'fathom', externalId: 'rec-1', startedAt: new Date('2026-11-09T16:02:00Z') });
    const calendlyCopy = transcript({
      source: 'calendly',
      externalId: 'recap-1',
      startedAt: new Date('2026-11-09T16:00:00Z'),
      durationSeconds: 30 * 60,
      attendees: [people.host, { ...people.dana, external: null }],
      text: 'Morgan Host: Thanks for joining the weekly sync.\nDana Client: Can we get a CSV export on the reports page?',
      hasTimestamps: false,
    });
    fathom.add(fathomCopy);
    calendly.add(calendlyCopy);
    await request(app)
      .post(new URL(fathom.webhooks[0]!.url).pathname)
      .set('content-type', 'application/json')
      .set('webhook-id', 'msg_1')
      .set('webhook-timestamp', '1700000000')
      .set('webhook-signature', fathom.webhooks[0]!.secret)
      .send(JSON.stringify({ kind: 'ready', id: 'rec-1', embed: true }))
      .expect(200, { ok: true });
    await runSchedule(h.worker, scheduleHandlers, { key: 'transcripts.poll', trigger: 'schedule' });

    model.on('record_call_match', matchAnswer()).on('record_suggestions', suggestionsAnswer()).on('record_call_brief', briefAnswer());
    const ran = await drain();
    expect(ran.filter((name) => name === 'calls.analyze')).toHaveLength(1);

    // One call with both recordings; the model matched it once and drafted once.
    const calls = await listCalls(pool);
    expect(calls).toMatchObject([{ title: 'Acme weekly sync', status: 'matched', projects: ['Acme Portal'], sources: expect.arrayContaining(['fathom', 'calendly']) as string[] }]);
    const copies = await listTranscripts(pool, calls[0]!.id);
    expect(copies.map((c) => [c.source, c.isPreferred])).toEqual(expect.arrayContaining([['fathom', true], ['calendly', false]]));
    expect(model.sent('record_call_match')).toHaveLength(1);
    expect(model.sent('record_suggestions')).toHaveLength(1);
    // The model was handed one tool that only records its answer, and never a key.
    for (const sent of model.requests) {
      expect(sent.tool.name).toMatch(/^record_/);
      expect(JSON.stringify(sent)).not.toMatch(/made-up-fathom-key|made-up-calendly-token/);
    }

    // 3. One short message in the chosen channel.
    expect(posts()).toHaveLength(1);
    const message = posts()[0]!;
    expect(message.channel).toBe('C0CALLS');
    expect(message.blocks[0].text.text.split('\n')).toEqual([
      '*Call* · Acme weekly sync · 32 min · Acme Portal',
      '1. Add CSV export to the reports page (agent)',
      '2. Fix the time zone in the daily digest email (agent)',
      '3. Send Dana the staging link (draft)',
    ]);
    expect(cursor.started).toEqual([]);

    // 4. An approver approves in Slack. Only then does anything start.
    await click(message.blocks[1]!.elements.find((b) => b.text.text === 'Approve all')!, APPROVER);
    await drain();
    expect(cursor.started.map((s) => s.repo)).toEqual([PORTAL_REPO, PORTAL_REPO]);
    expect(cursor.started.every((s) => s.prompt.includes('Open a pull request') && s.prompt.includes('Do not merge it.'))).toBe(true);
    expect(edits().at(-1)!.blocks[0].text.text.split('\n')[1]).toBe(`Approved by <@${APPROVER}>: 1, 2, 3 (agents running)`);

    // 5. The agents finish with a pull request each; the thread says so. Patcher merges nothing.
    cursor.run = {
      status: 'FINISHED',
      result: 'Opened a pull request.',
      branches: [{ repoUrl: `github.com/${PORTAL_REPO}`, branch: 'cursor/csv-export', prUrl: `https://github.com/${PORTAL_REPO}/pull/41` }],
    };
    await drain([]);
    const replies = posts().filter((m) => m.threadTs).map((m) => m.text.split('\n')[0]);
    expect(replies).toEqual(
      expect.arrayContaining([
        `1 · Agent finished · <https://github.com/${PORTAL_REPO}/pull/41|PR #41> ready for review`,
        '3 · Draft ready for a person to send. Patcher sent nothing.',
      ]),
    );

    // 6. Everything that changed something is in the activity log, with who did it.
    const log = await listAudit(pool, 200);
    const actions = log.map((entry) => entry.action);
    for (const action of ['calls.connection.add', 'call.receive', 'call.copy', 'call.match', 'call.suggest', 'call.post', 'recommendation.approve', 'action.done', 'agent.finished']) {
      expect(actions).toContain(action);
    }
    expect(log.find((entry) => entry.action === 'recommendation.approve')!.actor).toBe(APPROVER);

    // And the call's page shows it all to someone signed in.
    const page = (await owner.agent.get(`/calls/${calls[0]!.id}`).expect(200)).text;
    expect(page).toContain('Fathom <span class="badge badge-done">analysed</span>');
    expect(page).toContain('duplicate');
    expect(page).toContain(`https://github.com/${PORTAL_REPO}/pull/41`);
  });
});
