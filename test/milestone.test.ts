import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../src/audit/auditLog.js';
import { postRecommendation, syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { getRecommendation, listApprovals } from '../src/recommendations/service.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, SIGNING_SECRET, harness, resetDb, seedPeople, testPool, webDeps } from './helpers.js';

/**
 * The phase 0 milestone, through the same HTTP routes and job handlers the two services run:
 * a test recommendation posted to a channel chosen in the UI can be approved in Slack or in
 * the UI, and the decision is logged. Slack itself is a stand-in that records calls.
 */
const pool = testPool();
let h: Harness;
let app: ReturnType<typeof createApp>;
let deps: ReturnType<typeof webDeps>;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  h = harness(pool);
  deps = webDeps(h);
  app = createApp(deps);
});
afterAll(() => pool.end());

const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)![1]!;

async function signIn(userId: string) {
  deps.oidc.identity = { teamId: HUB, userId, name: null, email: null };
  const agent = request.agent(app);
  await agent.get('/auth/slack');
  await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState }).expect(302);
  const csrf = csrfOf((await agent.get('/settings').expect(200)).text);
  const post = (path: string, fields: Record<string, string> = {}) =>
    agent.post(path).type('form').send({ _csrf: csrf, ...fields });
  return { agent, post };
}

/** Chooses a channel in the UI, sends the test recommendation, and has the worker post it. */
async function sendTestTo(channelId: string) {
  const owner = await signIn(OWNER);
  await owner.post('/settings/routes/calls', { channel_id: channelId }).expect(303);
  const sent = await owner.post('/settings/routes/calls/test').expect(303);
  const id = sent.headers.location!.split('/').pop()!;
  expect(h.queue.of('recommendation.post')).toEqual([{ recommendationId: id }]);
  expect(await postRecommendation(h.worker, id)).toBe('posted');
  h.queue.clear();
  return { owner, id };
}

async function runWorkerJobs() {
  for (const job of h.queue.of('action.execute')) await executeAction(h.worker, job.actionId);
  for (const job of h.queue.of('recommendation.sync')) await syncMessage(h.worker, job.recommendationId);
}

describe('milestone', () => {
  it('posts the test recommendation to the channel chosen in the UI', async () => {
    const { id } = await sendTestTo('C0PICKED');
    const [message] = h.slack.of('postMessage');
    expect(message!.channel).toBe('C0PICKED');
    expect(String(message!.text)).toContain('Routing check for Calls');
    expect(await getRecommendation(pool, id)).toMatchObject({ status: 'posted', slackChannel: 'C0PICKED' });
  });

  it('can be approved in Slack, and the decision is logged', async () => {
    const { id } = await sendTestTo('C0PICKED');
    const rec = (await getRecommendation(pool, id))!;
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: HUB },
        user: { id: APPROVER, team_id: HUB },
        actions: [{ action_id: 'rec_approve', value: `${rec.id}|${rec.actionHash}` }],
      }),
    }).toString();
    const ts = Math.floor(Date.now() / 1000);
    await request(app)
      .post('/slack/interactions')
      .set('content-type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', String(ts))
      .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, body))
      .send(body)
      .expect(200);
    await runWorkerJobs();

    expect((await getRecommendation(pool, id))!.status).toBe('done');
    expect(await listApprovals(pool, id)).toMatchObject([{ decision: 'approved', actor: APPROVER, via: 'slack' }]);
    const log = (await listAudit(pool, 20)).reverse();
    expect(log.map((e) => [e.actor, e.action])).toEqual([
      [OWNER, 'auth.login'],
      [OWNER, 'route.update'],
      [OWNER, 'recommendation.create'],
      ['system', 'recommendation.post'],
      [APPROVER, 'recommendation.approve'],
      ['system', 'action.done'],
    ]);
    expect(String(h.slack.of('updateMessage').at(-1)!.text)).toContain(`approved by <@${APPROVER}> · done`);
  });

  it('can be approved in the UI, and the decision is logged and shown', async () => {
    const { id } = await sendTestTo('C0PICKED');
    const rec = (await getRecommendation(pool, id))!;
    const approver = await signIn(APPROVER);

    const pending = await approver.agent.get('/approvals').expect(200);
    expect(pending.text).toContain('Routing check for Calls');

    const res = await approver.post(`/approvals/${id}/approve`, { hash: rec.actionHash }).expect(303);
    expect(res.headers.location).toBe(`/approvals/${id}`);
    await runWorkerJobs();

    expect((await getRecommendation(pool, id))!.status).toBe('done');
    expect(await listApprovals(pool, id)).toMatchObject([{ decision: 'approved', actor: APPROVER, via: 'ui' }]);
    const entry = (await listAudit(pool, 20)).find((e) => e.action === 'recommendation.approve')!;
    expect(entry).toMatchObject({ actor: APPROVER, target: id, after: { via: 'ui', actionHash: rec.actionHash } });
    // The Slack message is brought in line with the decision made in the UI.
    expect(String(h.slack.of('updateMessage').at(-1)!.text)).toContain(`approved by <@${APPROVER}> · done`);

    const detail = await approver.agent.get(`/approvals/${id}`).expect(200);
    expect(detail.text).toContain('Approved.');
    expect(detail.text).not.toContain(`action="/approvals/${id}/approve"`);
    const activity = await approver.agent.get('/activity').expect(200);
    expect(activity.text).toContain('recommendation.approve');
  });

  it('refuses a UI approval that carries an out-of-date hash, and a second approval', async () => {
    const { id } = await sendTestTo('C0PICKED');
    const rec = (await getRecommendation(pool, id))!;
    const approver = await signIn(APPROVER);

    await approver.post(`/approvals/${id}/edit`, {
      hash: rec.actionHash,
      title: 'Edited title',
      body: rec.body,
      params: JSON.stringify(rec.action.params),
    }).expect(303);
    await approver.post(`/approvals/${id}/approve`, { hash: rec.actionHash }).expect(303);
    expect((await getRecommendation(pool, id))!.status).toBe('posted');

    const next = (await getRecommendation(pool, id))!;
    await approver.post(`/approvals/${id}/approve`, { hash: next.actionHash }).expect(303);
    await approver.post(`/approvals/${id}/approve`, { hash: next.actionHash }).expect(303);
    expect((await listApprovals(pool, id)).map((a) => a.decision)).toEqual(['edited', 'approved']);
  });

  it('holds the test while no channel is chosen, and posts it once one is', async () => {
    const owner = await signIn(OWNER);
    const sent = await owner.post('/settings/routes/sales/test').expect(303);
    const id = sent.headers.location!.split('/').pop()!;
    expect(await postRecommendation(h.worker, id)).toBe('held');
    h.queue.clear();

    await owner.post('/settings/routes/sales', { channel_id: 'C0SALES' }).expect(303);
    expect(h.queue.of('recommendation.post')).toEqual([{ recommendationId: id }]);
    expect(await postRecommendation(h.worker, id)).toBe('posted');
    expect(h.slack.of('postMessage')[0]!.channel).toBe('C0SALES');
  });
});

describe('health', () => {
  it('reports the database, queue and switches without needing a session, and no secrets', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      service: 'web',
      database: 'ok',
      paused: false,
      dryRun: false,
      features: { slackRequests: true, slackModals: true, signIn: true },
    });
    expect(res.body.queue).toEqual({ depth: 0, oldestReadySeconds: 0, deadLetters: 0 });
    expect(JSON.stringify(res.body)).not.toContain(SIGNING_SECRET);
  });

  it('reports features that are not configured as false, by feature and not by variable name', async () => {
    const missing = { configured: false, missing: ['SLACK_SIGNING_SECRET', 'SLACK_TEAM_ID'] };
    app = createApp(webDeps(h, { features: { slackRequests: missing } }));
    const res = await request(app).get('/health').expect(200);
    expect(res.body.features).toEqual({ slackRequests: false });
    expect(JSON.stringify(res.body)).not.toContain('SLACK_SIGNING_SECRET');
  });
});
