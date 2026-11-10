import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postRecommendation } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { createRecommendation, getRecommendation, listApprovals } from '../src/recommendations/service.js';
import type { Recommendation } from '../src/recommendations/types.js';
import { getSetting } from '../src/settings/settings.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { handleSlackEvent } from '../src/worker/handlers.js';
import type { Harness } from './helpers.js';
import {
  APPROVER,
  BASE_URL,
  HUB,
  OWNER,
  SIGNING_SECRET,
  STRANGER,
  VIEWER,
  auditActions,
  harness,
  resetDb,
  routeTo,
  seedPeople,
  testPool,
  testRecommendation,
  webDeps,
} from './helpers.js';

const pool = testPool();
let h: Harness;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'calls', 'C0CALLS');
  h = harness(pool);
  app = createApp(webDeps(h));
});
afterAll(() => pool.end());

const RESPONSE_URL = 'https://hooks.slack.com/actions/T0HUB/1/abc';

interface SendOptions {
  secret?: string;
  timestamp?: number;
  tamper?: boolean;
  unsigned?: boolean;
}

/** Sends a request signed the way Slack signs them. */
function send(path: string, body: string, contentType: string, options: SendOptions = {}) {
  const ts = options.timestamp ?? Math.floor(Date.now() / 1000);
  const req = request(app).post(path).set('content-type', contentType);
  if (!options.unsigned) {
    req.set('x-slack-request-timestamp', String(ts));
    req.set('x-slack-signature', signSlackRequest(options.secret ?? SIGNING_SECRET, ts, body));
  }
  return req.send(options.tamper ? body + ' ' : body);
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = 'application/x-www-form-urlencoded';

const interaction = (payload: unknown, options?: SendOptions) =>
  send('/slack/interactions', form({ payload: JSON.stringify(payload) }), FORM, options);

function click(rec: Pick<Recommendation, 'id' | 'actionHash'>, actionId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    team: { id: HUB },
    user: { id: APPROVER, team_id: HUB, name: 'april' },
    trigger_id: 'trigger-1',
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: `${rec.id}|${rec.actionHash}` }],
    ...overrides,
  };
}

const command = (text: string, userId = APPROVER, teamId = HUB) =>
  send('/slack/commands', form({ command: '/ops', text, user_id: userId, team_id: teamId }), FORM);

async function posted(): Promise<Recommendation> {
  const { recommendation } = await createRecommendation(h, testRecommendation());
  await postRecommendation(h.worker, recommendation.id);
  h.queue.clear();
  return (await getRecommendation(pool, recommendation.id))!;
}

describe('request verification', () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });

  it('answers the URL verification challenge for a signed request', async () => {
    const res = await send('/slack/events', body, 'application/json').expect(200);
    expect(res.body).toEqual({ challenge: 'abc123' });
  });

  it.each([
    ['unsigned', { unsigned: true }],
    ['signed with another secret', { secret: 'not-the-secret' }],
    ['changed after signing', { tamper: true }],
    ['older than five minutes', { timestamp: Math.floor(Date.now() / 1000) - 301 }],
  ])('rejects a request that is %s on every Slack endpoint', async (_name, options) => {
    for (const path of ['/slack/events', '/slack/interactions', '/slack/commands']) {
      const res = await send(path, body, 'application/json', options);
      expect(res.status, path).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_signature' });
    }
  });

  it('does nothing for a forged approval', async () => {
    const rec = await posted();
    await interaction(click(rec, 'rec_approve'), { secret: 'not-the-secret' }).expect(401);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    expect(h.queue.jobs).toEqual([]);
  });

  it('answers 503 and does nothing while Slack is not configured', async () => {
    app = createApp(webDeps(h, { signingSecret: undefined, hubTeamId: undefined }));
    const res = await send('/slack/events', body, 'application/json');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'slack_not_configured' });
  });
});

describe('events', () => {
  const event = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'event_callback',
      team_id: HUB,
      event_id: 'Ev001',
      event: { type: 'app_home_opened', user: OWNER, tab: 'home' },
      ...overrides,
    });

  it('stores the event and enqueues it once, however many times Slack delivers it', async () => {
    await send('/slack/events', event(), 'application/json').expect(200);
    await send('/slack/events', event(), 'application/json').expect(200);
    const { rows } = await pool.query('SELECT id, source, external_event_id FROM webhook_events');
    expect(rows).toMatchObject([{ source: 'slack', external_event_id: 'Ev001' }]);
    expect(h.queue.of('slack.event')).toEqual([{ webhookEventId: rows[0].id }]);
  });

  it('ignores events from any workspace other than the hub', async () => {
    await send('/slack/events', event({ team_id: 'T0CLIENT' }), 'application/json').expect(200);
    expect((await pool.query('SELECT 1 FROM webhook_events')).rowCount).toBe(0);
    expect(h.queue.jobs).toEqual([]);
  });

  it('publishes the App Home tab for someone on the allowlist, and nothing for anyone else', async () => {
    await send('/slack/events', event(), 'application/json').expect(200);
    await handleSlackEvent(h.worker, h.queue.of('slack.event')[0]!.webhookEventId);
    expect(h.slack.of('publishHome')).toMatchObject([{ userId: OWNER }]);

    await send(
      '/slack/events',
      event({ event_id: 'Ev002', event: { type: 'app_home_opened', user: STRANGER, tab: 'home' } }),
      'application/json',
    ).expect(200);
    await handleSlackEvent(h.worker, h.queue.of('slack.event')[1]!.webhookEventId);
    const views = h.slack.of('publishHome');
    expect(views).toHaveLength(2);
    expect(JSON.stringify(views[1])).not.toContain('pending');
    expect((await pool.query('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NOT NULL')).rows[0].n).toBe('2');
  });
});

describe('buttons', () => {
  it('approves from Slack: decision recorded, action enqueued, logged', async () => {
    const rec = await posted();
    await interaction(click(rec, 'rec_approve')).expect(200);

    expect((await getRecommendation(pool, rec.id))!.status).toBe('approved');
    expect(await listApprovals(pool, rec.id)).toMatchObject([{ decision: 'approved', actor: APPROVER, via: 'slack' }]);
    expect(h.queue.of('action.execute')).toHaveLength(1);
    expect(await executeAction(h.worker, h.queue.of('action.execute')[0]!.actionId)).toBe('done');
    expect(await auditActions(pool)).toEqual([
      'recommendation.create',
      'recommendation.post',
      'recommendation.approve',
      'action.done',
    ]);
  });

  it('tells the second person privately who decided first, and changes nothing', async () => {
    const rec = await posted();
    await interaction(click(rec, 'rec_approve')).expect(200);
    h.queue.clear();
    await interaction(click(rec, 'rec_dismiss', { user: { id: OWNER, team_id: HUB } })).expect(200);
    expect(h.queue.of('slack.respond')).toEqual([{ responseUrl: RESPONSE_URL, text: `Already approved by <@${APPROVER}>.` }]);
    expect(h.queue.of('action.execute')).toEqual([]);
    expect(await listApprovals(pool, rec.id)).toHaveLength(1);
  });

  it('refuses a click from someone who is not an approver, privately', async () => {
    const rec = await posted();
    for (const id of [VIEWER, STRANGER]) {
      await interaction(click(rec, 'rec_approve', { user: { id, team_id: HUB } })).expect(200);
    }
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    expect(h.queue.of('slack.respond').map((r) => r.text)).toEqual([
      'You are not on the approver list for this.',
      'You are not on the approver list for this.',
    ]);
    expect(h.queue.of('action.execute')).toEqual([]);
  });

  it('ignores a click from another workspace or from a guest of another workspace', async () => {
    const rec = await posted();
    await interaction(click(rec, 'rec_approve', { team: { id: 'T0CLIENT' } })).expect(200);
    await interaction(click(rec, 'rec_approve', { user: { id: APPROVER, team_id: 'T0CLIENT' } })).expect(200);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    expect(h.queue.jobs).toEqual([]);
  });

  it('refuses a button whose hash is not the stored one', async () => {
    const rec = await posted();
    await interaction(click({ id: rec.id, actionHash: '0'.repeat(64) }, 'rec_approve')).expect(200);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    expect(h.queue.of('slack.respond')[0]!.text).toBe('This was edited after you opened it. Check the current version.');
  });

  it('ignores button values and action ids it does not know', async () => {
    const rec = await posted();
    await interaction(click(rec, 'something_else')).expect(200);
    await interaction({ ...click(rec, 'rec_approve'), actions: [{ action_id: 'rec_approve', value: 'garbage' }] }).expect(200);
    await send('/slack/interactions', 'payload=not-json', FORM).expect(400);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
  });

  it('Details enqueues the thread reply', async () => {
    const rec = await posted();
    await interaction(click(rec, 'rec_details')).expect(200);
    expect(h.queue.of('recommendation.details')).toEqual([{ recommendationId: rec.id }]);
  });

  it('Edit opens a modal for an approver, carrying the hash it was opened against', async () => {
    const rec = await posted();
    await interaction(click(rec, 'rec_edit')).expect(200);
    const [opened] = h.slack.of('openView');
    expect(opened!.triggerId).toBe('trigger-1');
    const view = opened!.view as { callback_id: string; private_metadata: string };
    expect(view.callback_id).toBe('rec_edit_modal');
    expect(view.private_metadata).toBe(`${rec.id}|${rec.actionHash}`);

    await interaction(click(rec, 'rec_edit', { user: { id: VIEWER, team_id: HUB } })).expect(200);
    expect(h.slack.of('openView')).toHaveLength(1);
  });

  it('points to the UI when there is no bot token to open a modal with', async () => {
    app = createApp(webDeps(h, { modals: null }));
    const rec = await posted();
    await interaction(click(rec, 'rec_edit')).expect(200);
    expect(h.queue.of('slack.respond')[0]!.text).toBe(`Edit it in Patcher: ${BASE_URL}/approvals/${rec.id}`);
  });

  function submission(rec: Recommendation, fields: { title?: string; body?: string; params?: string }, metadata?: string) {
    return {
      type: 'view_submission',
      team: { id: HUB },
      user: { id: APPROVER, team_id: HUB },
      view: {
        callback_id: 'rec_edit_modal',
        private_metadata: metadata ?? `${rec.id}|${rec.actionHash}`,
        state: {
          values: {
            title: { value: { value: fields.title ?? rec.title } },
            body: { value: { value: fields.body ?? rec.body } },
            params: { value: { value: fields.params ?? JSON.stringify(rec.action.params) } },
          },
        },
      },
    };
  }

  it('saves a modal submission as a new version, after which the old buttons are refused', async () => {
    const rec = await posted();
    const res = await interaction(submission(rec, { title: 'Add CSV and Excel export' })).expect(200);
    expect(res.text).toBe('');
    const next = (await getRecommendation(pool, rec.id))!;
    expect(next).toMatchObject({ version: 2, title: 'Add CSV and Excel export', status: 'posted' });
    expect(h.queue.of('recommendation.sync')).toEqual([{ recommendationId: rec.id }]);

    h.queue.clear();
    await interaction(click(rec, 'rec_approve')).expect(200);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    await interaction(click(next, 'rec_approve')).expect(200);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('approved');
  });

  it('shows a field error in the modal instead of saving an invalid edit', async () => {
    const rec = await posted();
    const badJson = await interaction(submission(rec, { params: '{not json' })).expect(200);
    expect(badJson.body).toEqual({ response_action: 'errors', errors: { params: 'This is not valid JSON.' } });

    const badParams = await interaction(submission(rec, { params: '{"unknown": true}' })).expect(200);
    expect(badParams.body.response_action).toBe('errors');
    expect(Object.keys(badParams.body.errors)).toEqual(['params']);

    const noTitle = await interaction(submission(rec, { title: '' })).expect(200);
    expect(Object.keys(noTitle.body.errors)).toEqual(['title']);
    expect((await getRecommendation(pool, rec.id))!.version).toBe(1);
  });
});

describe('/ops', () => {
  it('reports status in two lines', async () => {
    await posted();
    const res = await command('status').expect(200);
    expect(res.body.response_type).toBe('ephemeral');
    expect(res.body.text).toBe(`Patcher is running · 1 pending · 0 jobs queued\n<${BASE_URL}|Open Patcher>`);
    expect((await command('')).body.text).toBe(res.body.text);
  });

  it('lists what is pending, at most four with a link to the rest', async () => {
    expect((await command('pending')).body.text).toBe('Nothing is waiting for a decision.');
    for (let i = 1; i <= 6; i++) {
      const { recommendation } = await createRecommendation(h, testRecommendation({ title: `Item ${i}` }));
      await postRecommendation(h.worker, recommendation.id);
    }
    const text = (await command('pending')).body.text as string;
    expect(text.split('\n')).toHaveLength(5);
    expect(text).toContain(`<${BASE_URL}/approvals|All 6 pending>`);
  });

  it('lets an approver pause and only an owner resume', async () => {
    expect((await command('pause', VIEWER)).body.text).toBe('Only an approver or owner can pause Patcher.');
    expect(await getSetting(pool, 'paused')).toBe(false);

    expect((await command('pause', APPROVER)).body.text).toMatch(/^Paused\./);
    expect(await getSetting(pool, 'paused')).toBe(true);
    expect((await command('pause', APPROVER)).body.text).toBe('Already paused.');
    expect((await command('status')).body.text).toMatch(/^Patcher is paused/);

    expect((await command('resume', APPROVER)).body.text).toBe('Only an owner can resume Patcher.');
    expect(await getSetting(pool, 'paused')).toBe(true);
    expect((await command('resume', OWNER)).body.text).toBe('Resumed.');
    expect(await getSetting(pool, 'paused')).toBe(false);
    expect(h.queue.of('system.resume')).toEqual([{ requestedBy: OWNER }]);
  });

  it('refuses people who are not on the allowlist and other workspaces', async () => {
    expect((await command('pause', STRANGER)).body.text).toBe('You do not have access to Patcher.');
    expect((await command('pause', OWNER, 'T0CLIENT')).body.text).toBe('This command works only in the PatchOps workspace.');
    expect(await getSetting(pool, 'paused')).toBe(false);
  });

  it('answers an unknown subcommand with usage', async () => {
    expect((await command('deploy everything')).body.text).toMatch(/^Usage:/);
  });
});
