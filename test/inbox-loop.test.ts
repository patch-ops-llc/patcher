import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { receiveCaptured } from '../src/inbox/capture.js';
import type { CapturedMessage } from '../src/inbox/capture.js';
import { INBOX_TASK_ACTION } from '../src/inbox/catalog.js';
import { INBOX_ACTIONS, postDigest, postItem, resumeHeldInboxPosts, runDigest } from '../src/inbox/delivery.js';
import { processBundle } from '../src/inbox/pipeline.js';
import { purgeInbox } from '../src/inbox/retention.js';
import { ITEM_MODAL } from '../src/inbox/slack.js';
import { getBundle, getItem, listBundles, listDigests, looseTasks, recentDecisions, ruleSuggestions } from '../src/inbox/store.js';
import { runExpiry } from '../src/recommendations/expiry.js';
import { getRecommendation } from '../src/recommendations/service.js';
import type { Recommendation } from '../src/recommendations/types.js';
import { setPaused } from '../src/settings/pause.js';
import { setSetting } from '../src/settings/settings.js';
import { ACTION_IDS, MAX_BUTTONS, MAX_LINES } from '../src/slack/messages.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { seedRegistry, testSecrets } from './fixtures/calls.js';
import { ASK, DM_CHANNEL, FakeReader, GENERAL_CHANNEL, OUTAGE, PORTAL_CHANNEL, captured, connectHub, recommendAnswer, triageAnswer, work } from './fixtures/inbox.js';
import { FakeModel } from './fixtures/model.js';
import type { Harness } from './helpers.js';
import { APPROVER, BASE_URL, HUB, OWNER, SIGNING_SECRET, STRANGER, VIEWER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * A Slack item in the approval loop: its own message when urgent, a line of the digest
 * otherwise, the buttons, the item modal, the reasons for a dismissal, expiry and
 * retention. Slack, the model and every message are stand-ins.
 */
const pool = testPool();
let h: Harness;
let model: FakeModel;
let app: ReturnType<typeof createApp>;
let hub: string;
let projects: { acme: string; globex: string };

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'inbox', 'C0INBOX');
  await routeTo(pool, 'errors', 'C0ERRORS');
  await setSetting(pool, 'inbox.enabled', true, OWNER);
  await setSetting(pool, 'inbox.settle_seconds', 0, OWNER);
  await setSetting(pool, 'inbox.quiet_hours', '', OWNER);
  projects = await seedRegistry(pool, OWNER);
  model = new FakeModel();
  const reader = new FakeReader();
  h = harness(pool, { integrations: testIntegrations({ model, slackReader: () => reader }), secrets: testSecrets().box });
  app = createApp(webDeps(h));
  hub = await connectHub(pool);
});
afterAll(() => pool.end());

const URGENT = { label: 'escalate', urgency: 'now', quote: OUTAGE };
const URGENT_WORDS = { summary: 'Portal login is down and customers are calling', action: 'reply_and_task', task_title: 'Restore the portal login', draft_reply: 'We are on it and will update you within the hour.', quote: OUTAGE };

/** A message arrives, is read, and its recommendation exists. Nothing has been posted yet. */
async function read(message: Partial<CapturedMessage> = {}, triage: Record<string, unknown> = {}, words: Record<string, unknown> = {}): Promise<string> {
  model.on('record_triage', triageAnswer(triage)).on('record_recommendation', recommendAnswer(words));
  expect(await receiveCaptured(h.worker, captured(hub, message))).toBe('stored');
  const [bundle] = await listBundles(pool, { statuses: ['open'] });
  h.queue.jobs = h.queue.jobs.filter((j) => j.name !== 'inbox.bundle');
  await processBundle(h.worker, bundle!.id);
  return bundle!.id;
}

/** An urgent item with its own message in the hub. */
async function urgentItem(message: Partial<CapturedMessage> = {}): Promise<{ id: string; rec: Recommendation }> {
  const id = await read({ text: OUTAGE, ...message }, URGENT, URGENT_WORDS);
  await work(h);
  return { id, rec: await recOf(id) };
}

const recOf = async (bundleId: string): Promise<Recommendation> => (await getRecommendation(pool, (await getBundle(pool, bundleId))!.recommendationId!))!;
const lastPost = () => h.slack.of('postMessage').at(-1)!;
const lastUpdate = () => h.slack.of('updateMessage').at(-1)!;
type Block = { type: string; text?: { text: string }; elements?: { action_id: string; value?: string; url?: string; text: { text: string } }[]; accessory?: { action_id: string; value: string } };
const blocksOf = (message: Record<string, unknown>): Block[] => message.blocks as Block[];
const linesOf = (message: Record<string, unknown>): string[] => blocksOf(message).flatMap((b) => (b.type === 'section' ? b.text!.text.split('\n') : []));
const buttonsOf = (message: Record<string, unknown>) => blocksOf(message).flatMap((b) => (b.type === 'actions' ? b.elements! : []));

const RESPONSE_URL = 'https://hooks.slack.com/actions/T0HUB/1/abc';
function interaction(payload: unknown) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = Math.floor(Date.now() / 1000);
  return request(app)
    .post('/slack/interactions')
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', String(ts))
    .set('x-slack-signature', signSlackRequest(SIGNING_SECRET, ts, body))
    .send(body);
}
const click = (actionId: string, value: string, user = APPROVER) =>
  interaction({ type: 'block_actions', team: { id: HUB }, user: { id: user, team_id: HUB, name: 'someone' }, trigger_id: 'trigger-1', response_url: RESPONSE_URL, actions: [{ action_id: actionId, value }] });
const refOf = (rec: Recommendation) => `${rec.id}|${rec.actionHash}`;

describe('an urgent item', () => {
  it('is posted on its own, short, with the buttons that decide it', async () => {
    const { id, rec } = await urgentItem();
    const message = lastPost();
    expect(message.channel).toBe('C0INBOX');
    const lines = linesOf(message);
    expect(lines).toHaveLength(3);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines[0]).toMatch(/^\*PatchOps Slack\* · #project-portal · Dana Reyes, <!date\^\d+\^/);
    expect(lines[1]).toBe('Portal login is down and customers are calling');
    expect(lines[2]).toBe('Suggest: reply "We are on it and will update you within the hour." and open a task');
    const buttons = buttonsOf(message);
    expect(buttons.length).toBeLessThanOrEqual(MAX_BUTTONS);
    expect(buttons.map((b) => b.text.text)).toEqual(['Copy draft', 'Open in Slack', 'Task only', 'Dismiss']);
    expect(buttons[1]!.url).toMatch(new RegExp(`^https://patchops\\.slack\\.com/archives/${PORTAL_CHANNEL}/p\\d+$`));
    expect(buttons[2]).toMatchObject({ action_id: ACTION_IDS.approve, value: refOf(rec) });
    // The message text is not in the post: the summary is Patcher's, and the words stay in Slack where they were written.
    expect(JSON.stringify(message)).not.toContain(OUTAGE);

    expect(rec).toMatchObject({ status: 'posted', slackChannel: 'C0INBOX' });
    expect(rec.expiresAt).not.toBeNull();
    expect(await getBundle(pool, id)).toMatchObject({ slackChannel: 'C0INBOX', slackTs: rec.slackTs, postError: null });
    expect(await auditActions(pool)).toContain('recommendation.post');
  });

  it('records a task when approved, and the message shrinks to one line', async () => {
    const { id, rec } = await urgentItem();
    await click(ACTION_IDS.approve, refOf(rec)).expect(200);
    await work(h);
    expect((await recOf(id)).status).toBe('done');
    const tasks = await pool.query<{ title: string; project_id: string; bundle_id: string; body: string }>('SELECT title, project_id, bundle_id, body FROM project_tasks');
    expect(tasks.rows).toEqual([{ title: 'Restore the portal login', project_id: projects.acme, bundle_id: id, body: expect.stringContaining('Portal login is down') as string }]);
    const lines = linesOf(lastUpdate());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Portal login is down and customers are calling · task recorded by <@${APPROVER}>`);
    expect(buttonsOf(lastUpdate())).toHaveLength(0);
    expect((await getItem(pool, id))!.feedback).toEqual({ decision: 'approved', reason: null });
    // Nothing was sent to the client workspace or anywhere else: the only Slack calls are Patcher's own post and edits.
    expect(new Set(h.slack.calls.map((c) => c.args.channel))).toEqual(new Set(['C0INBOX']));
  });

  it('refuses a decision from someone who is not an approver', async () => {
    const { id, rec } = await urgentItem();
    await click(ACTION_IDS.approve, refOf(rec), VIEWER).expect(200);
    await click(ACTION_IDS.dismiss, refOf(rec), STRANGER).expect(200);
    expect((await recOf(id)).status).toBe('posted');
    expect(h.queue.of('slack.respond')).toHaveLength(2);
    expect(h.queue.of('action.execute')).toHaveLength(0);
  });

  it('asks why after a dismissal, in one tap, and the next triage is told', async () => {
    const { id, rec } = await urgentItem();
    await click(ACTION_IDS.dismiss, refOf(rec)).expect(200);
    await work(h);
    let message = lastUpdate();
    expect(linesOf(message)).toEqual([expect.stringContaining(`dismissed by <@${APPROVER}>`) as string, 'Why? One tap.']);
    const reasons = buttonsOf(message);
    expect(reasons.map((b) => b.text.text)).toEqual(['Not relevant', 'Already handled', 'Wrong channel']);
    expect(new Set(reasons.map((b) => b.action_id)).size).toBe(3);

    await click(reasons[2]!.action_id, reasons[2]!.value!).expect(200);
    await work(h);
    message = lastUpdate();
    expect(linesOf(message)).toEqual([expect.stringContaining(`dismissed by <@${APPROVER}> · wrong channel`) as string]);
    expect(buttonsOf(message)).toHaveLength(0);
    expect((await getItem(pool, id))!.feedback).toEqual({ decision: 'dismissed', reason: 'wrong_channel' });
    expect(await recentDecisions(pool, hub)).toEqual([{ channel: '#project-portal', summary: 'Portal login is down and customers are calling', outcome: 'dismissed (wrong channel)' }]);
  });

  it('takes a reason only from an approver and only for a dismissed item', async () => {
    const { id, rec } = await urgentItem();
    await click(`${INBOX_ACTIONS.reason}:1`, `${id}|not_relevant`).expect(200);
    expect((await getItem(pool, id))!.feedback).toBeNull();
    await click(ACTION_IDS.dismiss, refOf(rec)).expect(200);
    await click(`${INBOX_ACTIONS.reason}:1`, `${id}|not_relevant`, STRANGER).expect(200);
    await click(`${INBOX_ACTIONS.reason}:1`, `${id}|because`).expect(200);
    await work(h);
    expect((await getItem(pool, id))!.feedback).toEqual({ decision: 'dismissed', reason: null });
  });

  it('suggests leaving a channel out after three "wrong channel" dismissals', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { id, rec } = await urgentItem({ channelId: GENERAL_CHANNEL, text: `${OUTAGE} (${i})` });
      await click(ACTION_IDS.dismiss, refOf(rec)).expect(200);
      await click(`${INBOX_ACTIONS.reason}:3`, `${id}|wrong_channel`).expect(200);
      expect(await ruleSuggestions(pool)).toHaveLength(i === 2 ? 1 : 0);
    }
    expect(await ruleSuggestions(pool)).toEqual([{ workspaceId: hub, channelId: GENERAL_CHANNEL, channelName: 'general', dismissals: 3 }]);
  });

  it('opens the item with the draft to copy, and decides from there', async () => {
    const { id, rec } = await urgentItem();
    await click(INBOX_ACTIONS.open, id).expect(200);
    const [opened] = h.slack.of('openView');
    const view = opened!.view as { callback_id: string; private_metadata: string; blocks: { type: string; block_id?: string; element?: { initial_value?: string; options?: { value: string }[] } }[] };
    expect(view.callback_id).toBe(ITEM_MODAL);
    expect(view.blocks.find((b) => b.block_id === 'draft')!.element!.initial_value).toBe('We are on it and will update you within the hour.');
    expect(view.blocks.find((b) => b.block_id === 'decision')!.element!.options!.map((o) => o.value)).toEqual(['approve', 'not_relevant', 'already_handled', 'wrong_channel']);

    const submit = (selected: string | null, metadata = view.private_metadata) =>
      interaction({
        type: 'view_submission',
        team: { id: HUB },
        user: { id: APPROVER, team_id: HUB },
        view: { callback_id: ITEM_MODAL, private_metadata: metadata, state: { values: { decision: { value: selected ? { selected_option: { value: selected } } : { selected_option: null } } } } },
      });
    // Closing with nothing chosen leaves it waiting.
    await submit(null).expect(200);
    expect((await recOf(id)).status).toBe('posted');
    const stale = await submit('approve', `${id}|${rec.id}|${'0'.repeat(64)}`).expect(200);
    expect(stale.body).toMatchObject({ response_action: 'errors' });

    await submit('already_handled').expect(200);
    await work(h);
    expect((await recOf(id)).status).toBe('dismissed');
    expect((await getItem(pool, id))!.feedback).toEqual({ decision: 'dismissed', reason: 'already_handled' });
    expect(linesOf(lastUpdate())).toEqual([expect.stringContaining('already handled') as string]);
  });

  it('shows the item without a decision to someone who may not decide, and nothing to a stranger', async () => {
    const { id } = await urgentItem();
    await pool.query(`UPDATE users SET approval_kinds = '{finding_fix}' WHERE slack_user_id = $1`, [APPROVER]);
    await click(INBOX_ACTIONS.open, id).expect(200);
    const view = h.slack.of('openView')[0]!.view as { blocks: { block_id?: string }[] };
    expect(view.blocks.some((b) => b.block_id === 'decision')).toBe(false);
    expect(JSON.stringify(view)).toContain('You are not on the approver list for this.');

    await click(INBOX_ACTIONS.open, id, STRANGER).expect(200);
    expect(h.slack.of('openView')).toHaveLength(1);
    expect(h.queue.of('slack.respond').at(-1)!.text).toBe('You do not have access to Patcher.');
  });

  it('points to the page when no modal can be opened', async () => {
    const { id } = await urgentItem();
    app = createApp(webDeps(h, { modals: null }));
    await click(INBOX_ACTIONS.open, id).expect(200);
    expect(h.queue.of('slack.respond').at(-1)!.text).toBe(`Open it in Patcher: ${BASE_URL}/inbox/items/${id}`);
  });

  it('posts the evidence in the thread when asked for details', async () => {
    const id = await read({ text: OUTAGE }, URGENT, { ...URGENT_WORDS, action: 'task', draft_reply: '' });
    await work(h);
    const message = lastPost();
    expect(buttonsOf(message).map((b) => b.text.text)).toEqual(['Open in Slack', 'Task', 'Dismiss', 'Details']);
    await click(ACTION_IDS.details, refOf(await recOf(id))).expect(200);
    await work(h);
    const reply = lastPost();
    expect(reply.threadTs).toBe((await recOf(id)).slackTs);
    expect(String(reply.text)).toContain(OUTAGE);
  });
});

describe('holding a post', () => {
  it('waits while paused and goes out on resume', async () => {
    await setPaused(h, true, OWNER);
    // Read before the pause would also hold the model; here the item already exists.
    await setPaused(h, false, OWNER);
    const id = await read({ text: OUTAGE }, URGENT, URGENT_WORDS);
    await setPaused(h, true, OWNER);
    h.queue.clear();
    expect(await postItem(h.worker, id)).toBe('held');
    expect((await getBundle(pool, id))!.postError).toBe('Waiting: Patcher is paused.');
    expect(h.slack.of('postMessage')).toHaveLength(0);

    await setPaused(h, false, OWNER);
    h.queue.clear();
    expect(await resumeHeldInboxPosts(h.worker)).toBe(1);
    await work(h);
    expect((await recOf(id)).status).toBe('posted');
  });

  it('waits for a channel, and says so when Slack refuses the post', async () => {
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'inbox'`);
    const id = await read({ text: OUTAGE }, URGENT, URGENT_WORDS);
    h.queue.clear();
    expect(await postItem(h.worker, id)).toBe('held');
    expect((await getBundle(pool, id))!.postError).toBe('Waiting: no channel is set for Slack inbox reports.');

    await routeTo(pool, 'inbox', 'C0INBOX');
    h.slack.fail('not_in_channel');
    expect(await postItem(h.worker, id)).toBe('held');
    expect((await getBundle(pool, id))!.postError).toBe('Slack refused the post (not_in_channel). Invite the bot to the channel, then post again.');
    expect(h.slack.of('postMessage').map((m) => m.channel)).toEqual(['C0ERRORS']);
    expect((await recOf(id)).status).toBe('drafted');

    expect(await postItem(h.worker, id)).toBe('posted');
  });

  it('moves an item to the digest when the channel has had its posts for the hour', async () => {
    await setSetting(pool, 'slack.max_posts_per_hour', 1, OWNER);
    await urgentItem();
    const second = await read({ text: `${OUTAGE} Again.` }, { ...URGENT, quote: OUTAGE }, URGENT_WORDS);
    h.queue.clear();
    expect(await postItem(h.worker, second)).toBe('to_digest');
    expect((await getBundle(pool, second))!.delivery).toBe('digest');
    expect(h.slack.of('postMessage')).toHaveLength(1);
  });

  it('posts nothing for an item that was closed before it could be shown', async () => {
    const id = await read({ text: OUTAGE }, URGENT, URGENT_WORDS);
    await pool.query(`UPDATE recommendations SET status = 'expired' WHERE id = $1`, [(await getBundle(pool, id))!.recommendationId]);
    expect(await postItem(h.worker, id)).toBe('nothing');
    expect(await postItem(h.worker, '00000000-0000-4000-8000-000000000000')).toBe('not_found');
  });
});

describe('the digest', () => {
  const question = (n: number, overrides: Partial<CapturedMessage> = {}) =>
    read({ text: `${ASK} (${n})`, channelId: `C0CHAN${n}`, ...overrides }, { quote: ASK }, { summary: `Question number ${n} about the invoice export`, quote: ASK });

  it('posts nothing when nothing needs him', async () => {
    expect(await runDigest(h.worker, 'schedule')).toBe('Nothing needs you.');
    expect(await listDigests(pool)).toHaveLength(0);
    expect(h.slack.calls).toHaveLength(0);
  });

  it('lists what waited as numbered lines in one message, and marks each recommendation posted', async () => {
    const ids = [await question(1), await question(2), await question(3)];
    expect(h.slack.calls).toHaveLength(0);
    expect(await runDigest(h.worker, 'schedule')).toBe('3 items in the digest.');
    await work(h);

    expect(h.slack.of('postMessage')).toHaveLength(1);
    const message = lastPost();
    const lines = linesOf(message);
    expect(lines).toEqual([
      '*Slack digest* · 1 workspace · 3 new · 3 need you',
      '1. PatchOps · Question number 1 about the invoice export',
      '2. PatchOps · Question number 2 about the invoice export',
      '3. PatchOps · Question number 3 about the invoice export',
    ]);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    const sections = blocksOf(message).filter((b) => b.accessory);
    expect(sections.map((b) => [b.accessory!.action_id, b.accessory!.value])).toEqual(ids.map((id, i) => [`${INBOX_ACTIONS.open}:${i + 1}`, id]));
    expect(buttonsOf(message).map((b) => [b.text.text, b.url])).toEqual([['Open in Patcher', `${BASE_URL}/inbox/digests/${(await listDigests(pool))[0]!.id}`]]);

    const recs = await Promise.all(ids.map(recOf));
    expect(recs.map((r) => r.status)).toEqual(['posted', 'posted', 'posted']);
    expect(new Set(recs.map((r) => r.slackTs)).size).toBe(1);
    // A second run has nothing new to say.
    expect(await runDigest(h.worker, 'schedule')).toBe('Nothing needs you.');
  });

  it('opens an item from its line, decides it there, and strikes the line through', async () => {
    const ids = [await question(1), await question(2)];
    await runDigest(h.worker, 'schedule');
    await work(h);
    await click(`${INBOX_ACTIONS.open}:2`, ids[1]!).expect(200);
    const view = h.slack.of('openView')[0]!.view as { private_metadata: string };
    await interaction({
      type: 'view_submission',
      team: { id: HUB },
      user: { id: APPROVER, team_id: HUB },
      view: { callback_id: ITEM_MODAL, private_metadata: view.private_metadata, state: { values: { decision: { value: { selected_option: { value: 'approve' } } } } } },
    }).expect(200);
    await work(h);
    expect((await recOf(ids[1]!)).status).toBe('done');
    expect((await recOf(ids[0]!)).status).toBe('posted');
    const lines = linesOf(lastUpdate());
    expect(lines[0]).toBe('*Slack digest* · 1 workspace · 2 new · 1 of 2 still need you');
    expect(lines[2]).toBe(`~2. PatchOps · Question number 2 about the invoice export~ · task recorded by <@${APPROVER}>`);
    expect(blocksOf(lastUpdate()).filter((b) => b.accessory)).toHaveLength(1);
    expect(await looseTasks(pool)).toHaveLength(0);
  });

  it('shows three and a link to the rest when there are more than four', async () => {
    for (let n = 1; n <= 6; n += 1) await question(n);
    await runDigest(h.worker, 'manual');
    await work(h);
    const message = lastPost();
    expect(linesOf(message)).toHaveLength(4);
    expect(linesOf(message)[0]).toContain('6 need you');
    expect(buttonsOf(message)[0]!.text.text).toBe('Show all 6');
    const posted = await pool.query(`SELECT 1 FROM recommendations WHERE status = 'posted'`);
    expect(posted.rowCount).toBe(6);
  });

  it('puts urgent and addressed items first, and leaves out what he answered meanwhile', async () => {
    await setSetting(pool, 'inbox.digest_only', true, OWNER);
    const later = await question(1);
    const dm = await question(2, { channelId: DM_CHANNEL, channelType: 'im', sentAt: new Date(Date.now() - 5000) });
    const urgent = await read({ text: OUTAGE }, URGENT, URGENT_WORDS);
    const answered = await question(4, { channelId: 'D0OTHER', channelType: 'im', sentAt: new Date(Date.now() - 5000) });
    await receiveCaptured(h.worker, captured(hub, { own: true, senderId: OWNER, channelId: 'D0OTHER', channelType: 'im', sentAt: new Date(Date.now() + 1000) }));
    h.queue.clear();

    expect(await runDigest(h.worker, 'schedule')).toBe('3 items in the digest, 1 already answered.');
    await work(h);
    const order = (await Promise.all([urgent, dm, later].map((id) => getBundle(pool, id)))).map((b) => b!.digestPosition);
    expect(order).toEqual([1, 2, 3]);
    expect(await getBundle(pool, answered)).toMatchObject({ status: 'handled', digestId: null });
    expect((await recOf(answered)).status).toBe('expired');
  });

  it('waits while paused or without a channel, and goes out afterwards', async () => {
    await question(1);
    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'inbox'`);
    await runDigest(h.worker, 'schedule');
    const [digest] = await listDigests(pool);
    h.queue.clear();
    expect(await postDigest(h.worker, digest!.id)).toBe('held');
    expect((await listDigests(pool))[0]!.postError).toBe('Waiting: no channel is set for Slack inbox reports.');
    await routeTo(pool, 'inbox', 'C0INBOX');
    expect(await resumeHeldInboxPosts(h.worker)).toBe(1);
    await work(h);
    expect((await listDigests(pool))[0]).toMatchObject({ slackChannel: 'C0INBOX', postError: null });

    await setPaused(h, true, OWNER);
    expect(await runDigest(h.worker, 'schedule')).toBe('Paused.');
  });

  it('reports the outcome in the digest thread, labelled with the item number', async () => {
    const ids = [await question(1), await question(2)];
    await runDigest(h.worker, 'schedule');
    await work(h);
    await click(ACTION_IDS.approve, refOf(await recOf(ids[1]!))).expect(200);
    await work(h);
    const reply = lastPost();
    expect(reply.threadTs).toBe((await recOf(ids[1]!)).slackTs);
    expect(String(reply.text)).toBe('2 · Task recorded on Acme Portal.');
  });
});

describe('expiry and retention', () => {
  it('reminds once, then expires an item nobody decided, and notes that for the next triage', async () => {
    const { id } = await urgentItem();
    const soon = new Date(Date.now() + 72 * 3_600_000);
    expect(await runExpiry(h.worker, soon)).toBe('1 reminded, 0 expired');
    expect(lastPost().threadTs).toBe((await recOf(id)).slackTs);
    expect(await runExpiry(h.worker, new Date(soon.getTime() + 3_600_000))).toBe('0 reminded, 1 expired');
    await work(h);
    expect((await recOf(id)).status).toBe('expired');
    expect(linesOf(lastUpdate())).toEqual([expect.stringContaining('expired with no decision') as string]);
    expect((await getItem(pool, id))!.feedback).toEqual({ decision: 'expired', reason: null });
  });

  it('removes the text, the draft and the quoted words after the retention period, and keeps the summary and the link', async () => {
    const { id, rec } = await urgentItem();
    await receiveCaptured(h.worker, captured(hub, { own: true, senderId: OWNER, channelId: GENERAL_CHANNEL }));
    expect(await purgeInbox(pool)).toBe('0 Slack messages cleared');

    await pool.query(`UPDATE slack_messages SET created_at = now() - interval '15 days', purge_after = now() - interval '1 day'`);
    await pool.query(`UPDATE slack_bundles SET created_at = now() - interval '15 days'`);
    await pool.query(`INSERT INTO inbound_aliases (token_hash, created_by) VALUES ('h', 'U0OWNER')`);
    await pool.query(
      `INSERT INTO inbound_emails (message_id, alias, outcome, sender, subject, received_at)
       SELECT 'old-' || n, (SELECT id FROM inbound_aliases), 'not_slack', 'someone@mail.example', 'A subject', now() - make_interval(days => n)
         FROM unnest(ARRAY[8, 31]) AS n`,
    );
    expect(await purgeInbox(pool)).toBe('1 Slack message cleared');

    const messages = await pool.query<{ text: string | null; own: boolean; link: string | null }>('SELECT text, own, link FROM slack_messages');
    expect(messages.rows).toEqual([{ text: null, own: false, link: expect.stringContaining('/archives/') as string }]);
    const bundle = (await getBundle(pool, id))!;
    expect(bundle).toMatchObject({ draft: null, quote: null, summary: 'Portal login is down and customers are calling' });
    expect(bundle.link).toContain('/archives/');
    const after = (await getRecommendation(pool, rec.id))!;
    expect(after.evidence).toEqual([{ quote: 'Removed after the retention period.', source: rec.evidence[0]!.source, url: rec.evidence[0]!.url }]);
    expect(JSON.stringify(after)).not.toContain(OUTAGE);
    const mails = await pool.query<{ message_id: string; subject: string | null }>('SELECT message_id, subject FROM inbound_emails');
    expect(mails.rows).toEqual([{ message_id: 'old-8', subject: null }]);
  });
});

describe('the task action', () => {
  it('records a task without a project when none was matched', async () => {
    const id = await read({ channelId: DM_CHANNEL, channelType: 'im' }, { project: '', label: 'task', urgency: 'now' }, { action: 'task', draft_reply: '', task_title: 'Send the signed contract' });
    await work(h);
    const rec = await recOf(id);
    expect(rec.action).toMatchObject({ type: INBOX_TASK_ACTION, params: { projectId: null } });
    await click(ACTION_IDS.approve, refOf(rec)).expect(200);
    await work(h);
    const tasks = await looseTasks(pool);
    expect(tasks).toMatchObject([{ title: 'Send the signed contract', status: 'open', bundleId: id }]);
    expect(linesOf(lastUpdate())[0]).toContain('task recorded by');
  });

  it('describes itself in words a person can check, and refuses parameters it does not know', () => {
    const params = { bundleId: '00000000-0000-4000-8000-000000000000', projectId: null, title: 'Call Dana back', detail: 'About the export.' };
    expect(h.catalog.describe({ type: INBOX_TASK_ACTION, params })).toBe('Record a task in Patcher: "Call Dana back". Nothing is sent or changed in Slack or anywhere else.');
    expect(() => h.catalog.validate({ type: INBOX_TASK_ACTION, params: { ...params, channel: 'C0CLIENT', text: 'post this' } })).toThrow();
    expect(() => h.catalog.validate({ type: 'slack.send_reply', params: { channel: 'C0CLIENT', text: 'hello' } })).toThrow();
  });
});
