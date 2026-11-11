import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { analyzeCall, suggestForCall } from '../src/calls/analyze.js';
import { CALL_ACTIONS, postCall, postCallDetails, renderCall } from '../src/calls/delivery.js';
import { ingestTranscript, removeTranscript } from '../src/calls/ingest.js';
import { PICK_MODAL, PROJECT_MODAL } from '../src/calls/slack.js';
import { carriedRecommendations, getCall, listMatches, listProjectTasks, listSuggestions } from '../src/calls/store.js';
import { listAgentRuns, pollAgentRun } from '../src/fix/agentFix.js';
import { runExpiry } from '../src/recommendations/expiry.js';
import { postRecommendation, resumeHeld, syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { getRecommendation, listApprovals } from '../src/recommendations/service.js';
import { setPaused } from '../src/settings/pause.js';
import { setSetting } from '../src/settings/settings.js';
import type { SlackView } from '../src/slack/client.js';
import { MAX_BUTTONS, MAX_LINES } from '../src/slack/messages.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { PORTAL_REPO, QUOTES, briefAnswer, matchAnswer, people, seedRegistry, suggestionsAnswer, transcript } from './fixtures/calls.js';
import { FakeCursor } from './fixtures/cursor.js';
import { FakeModel } from './fixtures/model.js';
import type { Harness } from './helpers.js';
import { APPROVER, BASE_URL, HUB, OWNER, SIGNING_SECRET, STRANGER, VIEWER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * The call's Slack message and its buttons, through to an agent and its pull request.
 * Slack, the model and Cursor are stand-ins; the call is made up. Nothing here has run
 * against the real services.
 */
const pool = testPool();
const CHANNEL = 'C0CALLS';
const LATER = () => new Date(Date.now() + 5 * 3600_000);
const RESPONSE_URL = 'https://hooks.slack.com/actions/T0HUB/1/abc';

let h: Harness;
let model: FakeModel;
let cursor: FakeCursor;
let app: ReturnType<typeof createApp>;
let ids: { acme: string; globex: string };

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'calls', CHANNEL);
  await setSetting(pool, 'calls.internal_domains', 'agency.example', OWNER);
  ids = await seedRegistry(pool, OWNER);
  model = new FakeModel();
  cursor = new FakeCursor();
  said.length = 0;
  h = harness(pool, { integrations: testIntegrations({ model, cursor }) });
  app = createApp(webDeps(h));
});
afterAll(() => pool.end());

interface Button {
  action_id: string;
  value: string;
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

const messages = (method: 'postMessage' | 'updateMessage') => h.slack.of(method) as unknown as Message[];
const last = (method: 'postMessage' | 'updateMessage' = 'updateMessage'): Message => messages(method).at(-1)!;
const linesOf = (m: Message): string[] => m.blocks[0].text.text.split('\n');
const buttonsOf = (m: Message): Button[] => m.blocks[1]?.elements ?? [];
const labels = (m: Message): string[] => buttonsOf(m).map((b) => b.text.text);
const buttonOf = (m: Message, label: string): Button => buttonsOf(m).find((b) => b.text.text === label)!;

async function received(overrides = {}): Promise<string> {
  const result = await ingestTranscript(h, transcript(overrides), null);
  return (result as { callId: string }).callId;
}

/** A matched call whose suggestions are posted: the state an approver finds in Slack. */
async function posted(answer = suggestionsAnswer()): Promise<{ callId: string; message: Message }> {
  const callId = await received();
  model.on('record_call_match', matchAnswer()).on('record_suggestions', answer).on('record_call_brief', briefAnswer());
  expect(await analyzeCall(h.worker, callId, LATER())).toBe('matched');
  await suggestForCall(h.worker, callId);
  expect(await postCall(h.worker, callId)).toBe('posted');
  h.queue.clear();
  return { callId, message: last('postMessage') };
}

/** A call the model was not sure about: the question is posted. */
async function asked(): Promise<{ callId: string; message: Message }> {
  const callId = await received({ title: 'Intro chat', durationSeconds: 18 * 60, attendees: [people.host, people.kit] });
  model.on('record_call_match', {
    summary: 'A first talk.',
    matches: [
      { project: 'P1', confidence: 0.7, quote: QUOTES.csv },
      { project: 'P2', confidence: 0.55, quote: QUOTES.zone },
    ],
  });
  expect(await analyzeCall(h.worker, callId, LATER())).toBe('needs_project');
  expect(await postCall(h.worker, callId)).toBe('posted');
  h.queue.clear();
  return { callId, message: last('postMessage') };
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
/** What people were told privately. The web process queues these; the worker sends them. */
const said: string[] = [];
const told = (): string[] => [...said, ...h.queue.of('slack.respond').map((j) => j.text)];

/** Runs what an approval enqueued, the way the worker would. */
async function work(): Promise<void> {
  for (const job of h.queue.of('action.execute')) await executeAction(h.worker, job.actionId);
  for (const job of h.queue.of('recommendation.sync')) await syncMessage(h.worker, job.recommendationId);
  said.push(...h.queue.of('slack.respond').map((j) => j.text));
  h.queue.clear();
}

const statuses = async (callId: string) => (await carriedRecommendations(pool, callId)).map((r) => r.status);

describe('the call message', () => {
  it('is one short message: the call, its project, the numbered suggestions and four buttons', async () => {
    const { callId, message } = await posted();
    expect(message.channel).toBe(CHANNEL);
    expect(linesOf(message)).toEqual([
      '*Call* · Acme weekly sync · 32 min · Acme Portal',
      '1. Add CSV export to the reports page (agent)',
      '2. Fix the time zone in the daily digest email (agent)',
      '3. Send Dana the staging link (draft)',
    ]);
    expect(message.text).toBe('Call · Acme weekly sync · 32 min · Acme Portal');
    expect(labels(message)).toEqual(['Approve all', 'Pick', 'Wrong project', 'Details']);
    expect(buttonOf(message, 'Approve all').style).toBe('primary');
    expect(linesOf(message).length).toBeLessThanOrEqual(MAX_LINES);
    expect(buttonsOf(message).length).toBeLessThanOrEqual(MAX_BUTTONS);
    // No transcript and no e-mail address in the channel.
    expect(JSON.stringify(message)).not.toMatch(/@[\w.]+\.example|Thanks for joining/);

    // Posting is what makes the suggestions decidable, each bound to the content that was shown.
    const recs = await carriedRecommendations(pool, callId);
    expect(recs.map((r) => r.status)).toEqual(['posted', 'posted', 'posted']);
    const { slackTs } = (await getCall(pool, callId))!;
    expect(recs.every((r) => r.slackChannel === CHANNEL && r.slackTs === slackTs)).toBe(true);
    expect(buttonOf(message, 'Approve all').value).toBe(recs.map((r) => `${r.id}|${r.actionHash}`).join(','));
    expect(await auditActions(pool)).toEqual(expect.arrayContaining(['call.post', 'recommendation.post']));

    // A second delivery of the job edits the same message and posts nothing new.
    expect(await postCall(h.worker, callId)).toBe('updated');
    expect(messages('postMessage')).toHaveLength(1);
  });

  it('keeps to five lines when a call has five suggestions, and says the rest are under Pick', async () => {
    const base = suggestionsAnswer().suggestions[0]!;
    const { message } = await posted({ suggestions: Array.from({ length: 5 }, (_, i) => ({ ...base, type: 'task', title: `Follow up on export item ${i + 1}` })) });
    expect(linesOf(message)).toEqual([
      '*Call* · Acme weekly sync · 32 min · Acme Portal',
      '1. Follow up on export item 1 (task)',
      '2. Follow up on export item 2 (task)',
      '3. Follow up on export item 3 (task)',
      '+2 more under Pick',
    ]);
    // The button says what it approves: only what the message shows.
    expect(labels(message)[0]).toBe('Approve 1-3');
    expect(buttonOf(message, 'Approve 1-3').value.split(',')).toHaveLength(3);
  });

  it('posts nothing for a call that matched no project, or that asked for nothing', async () => {
    const unmatched = await received({ title: 'Intro chat', attendees: [people.host, people.kit] });
    model.on('record_call_match', { summary: 'Nothing of ours.', matches: [] });
    await analyzeCall(h.worker, unmatched, LATER());
    expect(await postCall(h.worker, unmatched)).toBe('nothing');

    const quiet = await received({ externalId: 'rec-quiet', startedAt: new Date('2026-11-10T10:00:00Z'), text: 'Morgan Host: Just checking in on the portal this week.\nDana Client: All good on our side, nothing to add.' });
    model.on('record_call_match', matchAnswer('P1', 0.9, 'Just checking in on the portal this week.')).on('record_suggestions', { suggestions: [] });
    await analyzeCall(h.worker, quiet, LATER());
    await suggestForCall(h.worker, quiet);
    expect(await postCall(h.worker, quiet)).toBe('nothing');
    expect(h.slack.calls).toEqual([]);
  });

  it('waits while paused or without a channel, and says why in the UI', async () => {
    const callId = await received();
    model.on('record_call_match', matchAnswer()).on('record_suggestions', suggestionsAnswer()).on('record_call_brief', briefAnswer());
    await analyzeCall(h.worker, callId, LATER());
    await suggestForCall(h.worker, callId);

    await setPaused(h, true, OWNER);
    expect(await postCall(h.worker, callId)).toBe('held');
    expect((await getCall(pool, callId))!.postError).toBe('Waiting: Patcher is paused.');
    await setPaused(h, false, OWNER);

    await pool.query(`DELETE FROM channel_routes WHERE report_type = 'calls'`);
    expect(await postCall(h.worker, callId)).toBe('held');
    expect((await getCall(pool, callId))!.postError).toBe('Waiting: no channel is set for Calls reports.');
    expect(await statuses(callId)).toEqual(['drafted', 'drafted', 'drafted']);
    expect(h.slack.calls).toEqual([]);

    await routeTo(pool, 'calls', CHANNEL);
    // Saving a route or resuming picks up what was waiting: each suggestion asks its call to post.
    h.queue.clear();
    await resumeHeld(h.worker);
    for (const job of h.queue.of('recommendation.post')) expect(await postRecommendation(h.worker, job.recommendationId)).toBe('carried');
    expect(new Set(h.queue.of('calls.post').map((j) => j.callId))).toEqual(new Set([callId]));

    h.slack.fail('not_in_channel');
    expect(await postCall(h.worker, callId)).toBe('held');
    expect((await getCall(pool, callId))!.postError).toBe('Slack refused the post (not_in_channel). Invite the bot to the channel, then post again.');
    expect(await postCall(h.worker, callId)).toBe('posted');
    expect((await getCall(pool, callId))!.postError).toBeNull();
  });

  it('respects the hourly cap on posts to a channel', async () => {
    await setSetting(pool, 'slack.max_posts_per_hour', 1, OWNER);
    await posted();
    const second = await received({ externalId: 'rec-second', startedAt: new Date('2026-11-10T10:00:00Z'), text: 'Morgan Host: Shall we talk about the portal export again?\nDana Client: Yes, can we get a CSV export on the reports page? Still needed.' });
    await analyzeCall(h.worker, second, LATER());
    await suggestForCall(h.worker, second);
    h.queue.clear();
    expect(await postCall(h.worker, second)).toBe('deferred');
    expect(messages('postMessage')).toHaveLength(1);
    expect(h.queue.of('calls.post')).toEqual([{ callId: second }]);
  });
});

describe('approving from Slack', () => {
  it('Approve all approves every suggestion, starts one agent per code change and reports each pull request in the thread', async () => {
    const { callId, message } = await posted();
    await click(buttonOf(message, 'Approve all'));
    expect(await statuses(callId)).toEqual(['approved', 'approved', 'approved']);
    const recs = await carriedRecommendations(pool, callId);
    expect((await listApprovals(pool, recs[0]!.id))[0]).toMatchObject({ actor: APPROVER, via: 'slack', decision: 'approved' });
    await work();

    // One agent per code change, on the project's linked repository, with the brief that was approved.
    expect(cursor.started.map((s) => s.repo)).toEqual([PORTAL_REPO, PORTAL_REPO]);
    expect(cursor.started[0]!.prompt).toBe((recs[0]!.action.params as { prompt: string }).prompt);
    expect(cursor.started[0]!.prompt).toContain('Do not merge it.');
    expect(await statuses(callId)).toEqual(['done', 'done', 'done']);

    expect(linesOf(last())).toEqual(['*Call* · Acme weekly sync · Acme Portal', `Approved by <@${APPROVER}>: 1, 2, 3 (agents running)`]);
    expect(buttonsOf(last())).toEqual([]);

    // Each outcome is one thread reply, numbered like its line. The follow-up's draft is there to copy.
    const replies = messages('postMessage').filter((m) => m.threadTs);
    expect(replies.map((r) => r.text.split('\n')[0])).toEqual([
      expect.stringMatching(/^1 · Agent started\. The pull request is posted here when it is ready\. https:\/\/cursor\.com\/agents\//),
      expect.stringMatching(/^2 · Agent started\. /),
      '3 · Draft ready for a person to send. Patcher sent nothing.',
    ]);
    expect(replies[2]!.text).toContain('\n> Hi Dana, here is the staging link we talked about on the call today.');
    expect(await listProjectTasks(pool, ids.acme)).toMatchObject([{ kind: 'followup', title: 'Send Dana the staging link', status: 'open', callId }]);

    // The first agent opens a pull request. Patcher links it and merges nothing.
    const runs = await listAgentRuns(pool, recs.map((r) => r.id));
    cursor.run = { status: 'FINISHED', result: 'Opened a pull request.', branches: [{ repoUrl: `github.com/${PORTAL_REPO}`, branch: 'cursor/csv-export', prUrl: `https://github.com/${PORTAL_REPO}/pull/41` }] };
    expect(await pollAgentRun(h.worker, runs[0]!.id)).toBe('finished');
    expect(last('postMessage')).toMatchObject({ threadTs: (await getCall(pool, callId))!.slackTs, text: `1 · Agent finished · <https://github.com/${PORTAL_REPO}/pull/41|PR #41> ready for review` });
    await renderCall(h.worker, callId);
    expect(linesOf(last())[1]).toBe(`Approved by <@${APPROVER}>: 1, 2, 3 (agent running) · 1 <https://github.com/${PORTAL_REPO}/pull/41|PR #41> ready for review`);

    // The old button is dead: nothing is approved or started twice.
    await click(buttonOf(message, 'Approve all'));
    await work();
    expect(cursor.started).toHaveLength(2);
    expect(told().at(-1)).toBe(`Already approved by <@${APPROVER}>.`);
  });

  it('refuses someone who is not an approver, on every button', async () => {
    const { callId, message } = await posted();
    for (const label of ['Approve all', 'Pick', 'Wrong project']) {
      await click(buttonOf(message, label), VIEWER);
      await click(buttonOf(message, label), STRANGER);
    }
    expect(await statuses(callId)).toEqual(['posted', 'posted', 'posted']);
    expect(h.queue.of('action.execute')).toEqual([]);
    expect(h.slack.of('openView')).toEqual([]);
    expect(told()).toHaveLength(6);
    expect(told().every((t) => t.includes('not on the approver list'))).toBe(true);
    expect((await getCall(pool, callId))!.version).toBe(1);
  });

  it('Pick approves what stays ticked, with edits, and skips the rest', async () => {
    const { callId, message } = await posted();
    await click(buttonOf(message, 'Pick'));
    const view = openedView();
    expect(view.callback_id).toBe(PICK_MODAL);
    const blocks = view.blocks as { block_id: string; label: { text: string }; element: { options?: { value: string; text: { text: string } }[]; initial_value?: string } }[];
    expect(blocks.map((b) => b.block_id)).toEqual(['pick', 'edit_1', 'edit_2', 'edit_3']);
    expect(blocks[0]!.element.options!.map((o) => o.text.text)).toEqual([
      '1. Add CSV export to the reports page (agent)',
      '2. Fix the time zone in the daily digest email (agent)',
      '3. Send Dana the staging link (draft)',
    ]);
    expect(blocks[1]!.label.text).toBe('1. Add an instruction for the agent');
    expect(blocks[3]!.element.initial_value).toContain('here is the staging link');

    const res = await submit(view, {
      pick: { value: { selected_options: [{ value: '1' }, { value: '3' }] } },
      edit_1: { value: { value: 'Put the button to the right of the date filter.' } },
      edit_2: { value: { value: null } },
      edit_3: { value: { value: 'Hi Dana, the staging link is on its way. Thanks for today.' } },
    });
    expect(res.text).toBe('');
    expect(await statuses(callId)).toEqual(['approved', 'dismissed', 'approved']);
    const recs = await carriedRecommendations(pool, callId);
    // An edit is a new version, and the approval is of that version.
    expect(recs[0]).toMatchObject({ version: 2 });
    expect((recs[0]!.action.params as { prompt: string }).prompt).toContain('Added by the approver:\nPut the button to the right of the date filter.\n\nRules:\n');
    expect(recs[2]!.action.params).toMatchObject({ draft: 'Hi Dana, the staging link is on its way. Thanks for today.' });
    expect((await listApprovals(pool, recs[0]!.id)).map((a) => [a.decision, a.version])).toEqual(expect.arrayContaining([['edited', 2], ['approved', 2]]));

    await work();
    expect(cursor.started).toHaveLength(1);
    expect(cursor.started[0]!.prompt).toContain('Put the button to the right of the date filter.');
    expect(linesOf(last())).toEqual(['*Call* · Acme weekly sync · Acme Portal', `Approved by <@${APPROVER}>: 1, 3 (agent running) · Skipped: 2`]);
    expect((await listProjectTasks(pool, ids.acme))[0]!.body).toBe('Hi Dana, the staging link is on its way. Thanks for today.');
  });

  it('changes nothing when an edit in the Pick form is not valid, and shows the problem on its field', async () => {
    const { callId, message } = await posted();
    await click(buttonOf(message, 'Pick'));
    const res = await submit(openedView(), {
      pick: { value: { selected_options: [{ value: '1' }, { value: '2' }, { value: '3' }] } },
      edit_3: { value: { value: 'Too short' } },
    });
    expect(res.body).toEqual({ response_action: 'errors', errors: { edit_3: expect.stringContaining('too short to send') as string } });
    expect(await statuses(callId)).toEqual(['posted', 'posted', 'posted']);
    expect(h.queue.of('action.execute')).toEqual([]);
  });

  it('shows what is decided on the message while other lines still wait', async () => {
    const { callId, message } = await posted();
    await click(buttonOf(message, 'Pick'));
    const view = openedView();
    // Slack sends the modal's own metadata back; here only the second suggestion is in it, as if the others were decided elsewhere.
    const meta = JSON.parse(String(view.private_metadata)) as { c: string; v: number; r: [number, string][] };
    await submit({ ...view, private_metadata: JSON.stringify({ ...meta, r: [meta.r[1]] }) }, { pick: { value: { selected_options: [] } } });
    await work();
    expect(await statuses(callId)).toEqual(['posted', 'dismissed', 'posted']);
    const updated = last();
    expect(linesOf(updated)).toEqual([
      '*Call* · Acme weekly sync · 32 min · Acme Portal',
      '1. Add CSV export to the reports page (agent)',
      `2. Fix the time zone in the daily digest email (agent) · skipped by <@${APPROVER}>`,
      '3. Send Dana the staging link (draft)',
    ]);
    expect(labels(updated)).toEqual(['Approve 1, 3', 'Pick', 'Wrong project', 'Details']);
  });

  it('Details posts each suggestion\'s words from the call and what approving does, once, in the thread', async () => {
    const { callId, message } = await posted();
    await click(buttonOf(message, 'Details'), VIEWER);
    expect(h.queue.of('calls.details')).toEqual([{ callId }]);
    await postCallDetails(h.worker, callId);
    await postCallDetails(h.worker, callId);
    const replies = messages('postMessage').filter((m) => m.threadTs);
    expect(replies).toHaveLength(1);
    const text = (replies[0]!.blocks as unknown as { text: { text: string } }[]).map((b) => b.text.text).join('\n\n');
    expect(text).toContain('*1. Add CSV export to the reports page* (agent)');
    expect(text).toContain(`> ${QUOTES.csv} (at 00:01:12)`);
    expect(text).toContain(`On approval: Start a Cursor agent on ${PORTAL_REPO}`);
    expect(text).toContain('*4. Client has not decided who owns the billing export* (note)');
    expect(text).toContain('For awareness. Nothing to approve.');
    expect(text).toContain(`<${BASE_URL}/calls/${callId}|Open the call in Patcher>`);

    await click(buttonOf(message, 'Details'), STRANGER);
    expect(told().at(-1)).toBe('You do not have access to Patcher.');
  });

  it('offers Retry on the message when an approved action fails', async () => {
    const { callId, message } = await posted({ suggestions: [suggestionsAnswer().suggestions[0]!] });
    cursor.failStart = new Error('Cursor API: 503');
    await click(buttonOf(message, 'Approve all'));
    await work();
    expect(await statuses(callId)).toEqual(['failed']);
    expect(linesOf(last())[1]).toBe(`Approved by <@${APPROVER}>: 1 · Failed: 1`);
    expect(labels(last())).toEqual(['Retry 1']);

    cursor.failStart = undefined;
    await click(buttonOf(last(), 'Retry 1'));
    await work();
    expect(await statuses(callId)).toEqual(['done']);
    expect(cursor.started).toHaveLength(1);
  });

  it('reminds once in the thread, then expires what nobody decided', async () => {
    const { callId } = await posted();
    await pool.query(`UPDATE recommendations SET expires_at = now() + interval '1 hour'`);
    await runExpiry(h.worker);
    const reminders = messages('postMessage').filter((m) => m.threadTs);
    expect(reminders).toHaveLength(1);
    await pool.query(`UPDATE recommendations SET expires_at = now() - interval '1 minute'`);
    await runExpiry(h.worker);
    for (const job of h.queue.of('recommendation.sync')) await syncMessage(h.worker, job.recommendationId);
    expect(await statuses(callId)).toEqual(['expired', 'expired', 'expired']);
    expect(linesOf(last())).toEqual(['*Call* · Acme weekly sync · Acme Portal', 'Expired: 1, 2, 3']);
  });
});

describe('which project?', () => {
  it('asks with the closest projects as buttons, and drafts suggestions once someone answers', async () => {
    const { callId, message } = await asked();
    expect(linesOf(message)).toEqual(['*Call* · "Intro chat" · 18 min · which project?']);
    expect(labels(message)).toEqual(['Acme Portal', 'Globex Site', 'None / new']);
    expect(buttonsOf(message).map((b) => b.action_id)).toEqual([`${CALL_ACTIONS.project}:1`, `${CALL_ACTIONS.project}:2`, `${CALL_ACTIONS.project}:none`]);

    await click(buttonOf(message, 'Globex Site'));
    expect(await getCall(pool, callId)).toMatchObject({ status: 'matched', version: 2, projectSetBy: APPROVER });
    expect(await listMatches(pool, callId)).toMatchObject([{ projectId: ids.globex, source: 'person' }]);
    expect(h.queue.jobs.map((j) => j.name)).toEqual(['calls.suggest']);

    // The same message becomes the suggestions.
    model.on('record_suggestions', { suggestions: [{ ...suggestionsAnswer().suggestions[0]!, type: 'task' }] });
    await suggestForCall(h.worker, callId);
    expect(await postCall(h.worker, callId)).toBe('updated');
    expect(messages('postMessage')).toHaveLength(1);
    expect(linesOf(last())).toEqual(['*Call* · Intro chat · 18 min · Globex Site', '1. Add CSV export to the reports page (task)']);

    // A click on the old question no longer changes anything.
    await click(buttonOf(message, 'Acme Portal'), OWNER);
    expect(told().at(-1)).toContain('already changed');
    expect((await listMatches(pool, callId))[0]!.projectId).toBe(ids.globex);
  });

  it('takes "None / new" as an answer and stops asking', async () => {
    const { callId, message } = await asked();
    await click(buttonOf(message, 'None / new'));
    expect((await getCall(pool, callId))!.status).toBe('unmatched');
    expect(await postCall(h.worker, callId)).toBe('updated');
    expect(linesOf(last())).toEqual(['*Call* · Intro chat · no project', `Marked by <@${APPROVER}> as not belonging to a listed project`]);
    expect(buttonsOf(last())).toEqual([]);
  });

  it('Wrong project moves a call: what was waiting is closed and new suggestions are drafted', async () => {
    const { callId, message } = await posted();
    await click(buttonOf(message, 'Wrong project'));
    const view = openedView();
    expect(view.callback_id).toBe(PROJECT_MODAL);
    const options = (view.blocks as { element: { options: { value: string; text: { text: string } }[] } }[])[0]!.element.options;
    expect(options.map((o) => o.text.text)).toEqual(['Acme Portal', 'Globex Site', 'None of these / new']);

    await submit(view, { project: { value: { selected_option: { value: ids.globex } } } });
    expect(await statuses(callId)).toEqual([]);
    expect((await pool.query(`SELECT status FROM recommendations`)).rows.map((r: { status: string }) => r.status)).toEqual(['expired', 'expired', 'expired']);
    expect(h.queue.jobs.map((j) => j.name)).toEqual(['calls.suggest']);

    await renderCall(h.worker, callId);
    expect(linesOf(last())).toEqual(['*Call* · Acme weekly sync · Globex Site', `Project set by <@${APPROVER}> · drafting suggestions`]);
    // The buttons of the message as it was are refused.
    await click(buttonOf(message, 'Approve all'));
    await click(buttonOf(message, 'Pick'));
    expect(told().join(' ')).toContain('out of date');
    expect(h.queue.of('action.execute')).toEqual([]);

    const stale = await submit(view, { project: { value: { selected_option: { value: ids.acme } } } });
    expect(stale.body).toMatchObject({ response_action: 'errors', errors: { project: expect.stringContaining('already changed') as string } });
  });

  it('removes what it showed when the recording is deleted at its source', async () => {
    const { callId, message } = await posted();
    await removeTranscript(h, 'fathom', (await pool.query<{ external_id: string }>('SELECT external_id FROM transcripts')).rows[0]!.external_id);
    expect(await postCall(h.worker, callId)).toBe('updated');
    expect(linesOf(last())).toEqual(['*Call* · Acme weekly sync · the recording was deleted at its source']);
    expect(await listSuggestions(pool, callId)).toEqual([]);
    const { rows } = await pool.query<{ status: string; evidence: { quote: string }[] }>('SELECT status, evidence FROM recommendations');
    expect(rows.every((r) => r.status === 'expired' && r.evidence[0]!.quote === '[removed]')).toBe(true);
    // Nothing the call said is left anywhere: not in the brief an agent would have had, not in the draft.
    const everything = JSON.stringify((await pool.query('SELECT r.body, r.evidence, r.proposed_action, c.summary FROM recommendations r, calls c')).rows);
    for (const words of [QUOTES.csv, QUOTES.zone, QUOTES.staging, 'here is the staging link', 'An export button next to']) expect(everything).not.toContain(words);
    await click(buttonOf(message, 'Approve all'));
    expect(h.queue.of('action.execute')).toEqual([]);
  });
});

describe('approving in the control UI', () => {
  it('approves, edits and dismisses a call suggestion on its approval page, and the call message follows', async () => {
    const { callId } = await posted();
    const deps = webDeps(h);
    const ui = createApp(deps);
    deps.oidc.identity = { teamId: HUB, userId: APPROVER, name: null, email: null };
    const agent = request.agent(ui);
    await agent.get('/auth/slack');
    await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState }).expect(302);
    const csrf = /name="_csrf" value="([^"]+)"/.exec((await agent.get('/approvals').expect(200)).text)![1]!;
    const recs = await carriedRecommendations(pool, callId);
    const post = (path: string, fields: Record<string, string>) => agent.post(path).type('form').send({ _csrf: csrf, ...fields }).expect(303);

    const page = (await agent.get(`/approvals/${recs[2]!.id}`).expect(200)).text;
    expect(page).toContain('Call · Send Dana the staging link');
    expect(page).toContain('Keep this drafted message on the project for a person to send. Patcher sends nothing.');
    expect(page).toContain('I will also send Dana the staging link after this call.');

    const params = { ...(recs[2]!.action.params as object), draft: 'Hi Dana, edited in Patcher before sending. Thanks.' };
    await post(`/approvals/${recs[2]!.id}/edit`, { hash: recs[2]!.actionHash, title: recs[2]!.title, body: recs[2]!.body, params: JSON.stringify(params) });
    const edited = (await getRecommendation(pool, recs[2]!.id))!;
    await post(`/approvals/${edited.id}/approve`, { hash: edited.actionHash });
    await post(`/approvals/${recs[1]!.id}/dismiss`, { hash: recs[1]!.actionHash });
    await work();

    expect(await statuses(callId)).toEqual(['posted', 'dismissed', 'done']);
    expect((await listApprovals(pool, edited.id)).map((a) => a.via)).toEqual(expect.arrayContaining(['ui']));
    expect((await listProjectTasks(pool, ids.acme))[0]).toMatchObject({ kind: 'followup', body: 'Hi Dana, edited in Patcher before sending. Thanks.' });
    expect(linesOf(last())).toEqual([
      '*Call* · Acme weekly sync · 32 min · Acme Portal',
      '1. Add CSV export to the reports page (agent)',
      `2. Fix the time zone in the daily digest email (agent) · skipped by <@${APPROVER}>`,
      '3. Send Dana the staging link (draft) · done',
    ]);
  });
});
