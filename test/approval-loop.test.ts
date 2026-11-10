import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { postDetails, postRecommendation, resumeHeld, syncMessage } from '../src/recommendations/delivery.js';
import { executeAction } from '../src/recommendations/executor.js';
import { runExpiry } from '../src/recommendations/expiry.js';
import {
  RecommendationInputError,
  createRecommendation,
  decide,
  editRecommendation,
  getRecommendation,
  listActions,
  listApprovals,
  retryRecommendation,
} from '../src/recommendations/service.js';
import type { Recommendation } from '../src/recommendations/types.js';
import { setPaused } from '../src/settings/pause.js';
import { setSetting } from '../src/settings/settings.js';
import { MAX_BUTTONS, MAX_LINES } from '../src/slack/messages.js';
import type { Harness } from './helpers.js';
import {
  APPROVER,
  OWNER,
  STRANGER,
  VIEWER,
  addUser,
  auditActions,
  harness,
  resetDb,
  routeTo,
  seedPeople,
  testPool,
  testRecommendation,
} from './helpers.js';

const pool = testPool();
let h: Harness;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'calls', 'C0CALLS');
  h = harness(pool);
});

afterAll(() => pool.end());

/** Creates a recommendation and posts it, as the worker would. */
async function posted(overrides = {}): Promise<Recommendation> {
  const { recommendation } = await createRecommendation(h, testRecommendation(overrides));
  expect(await postRecommendation(h.worker, recommendation.id)).toBe('posted');
  return (await getRecommendation(pool, recommendation.id))!;
}

const input = (rec: Recommendation, actor = APPROVER, via: 'slack' | 'ui' = 'slack') => ({
  id: rec.id,
  hash: rec.actionHash,
  actor,
  via,
});

const lines = (text: unknown) => String(text).split('\n');
const sectionText = (message: Record<string, unknown>) =>
  ((message.blocks as { text?: { text: string } }[])[0]!.text!.text);
const buttons = (message: Record<string, unknown>) =>
  (message.blocks as { type: string; elements?: { text: { text: string } }[] }[])
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements!.map((e) => e.text.text));

describe('creating a recommendation', () => {
  it('stores it drafted and enqueues the post in the same transaction', async () => {
    const { recommendation, created } = await createRecommendation(h, testRecommendation());
    expect(created).toBe(true);
    expect(recommendation.status).toBe('drafted');
    expect(recommendation.actionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.queue.of('recommendation.post')).toEqual([{ recommendationId: recommendation.id }]);
    expect(await auditActions(pool)).toEqual(['recommendation.create']);
  });

  it('drops a recommendation that has no evidence', async () => {
    await expect(createRecommendation(h, testRecommendation({ evidence: [] }))).rejects.toThrow(RecommendationInputError);
    await expect(
      createRecommendation(h, testRecommendation({ evidence: [{ quote: '  ', source: 'call' }] })),
    ).rejects.toThrow(RecommendationInputError);
  });

  it('refuses an action that is not in the catalog, or whose parameters do not validate', async () => {
    await expect(
      createRecommendation(h, testRecommendation({ action: { type: 'railway.delete_everything', params: {} } })),
    ).rejects.toThrow(/not in the catalog/);
    await expect(
      createRecommendation(h, testRecommendation({ action: { type: 'acknowledge', params: { nope: 1 } } })),
    ).rejects.toThrow(RecommendationInputError);
  });

  it('refuses an unregistered kind', async () => {
    await expect(createRecommendation(h, testRecommendation({ kind: 'mystery' }))).rejects.toThrow(/not registered/);
  });

  it('creates only one recommendation for a dedupe key', async () => {
    const first = await createRecommendation(h, testRecommendation({ dedupeKey: 'call-1:1' }));
    const second = await createRecommendation(h, testRecommendation({ dedupeKey: 'call-1:1', title: 'Other' }));
    expect(second.created).toBe(false);
    expect(second.recommendation.id).toBe(first.recommendation.id);
    expect(h.queue.of('recommendation.post')).toHaveLength(1);
  });
});

describe('posting', () => {
  it('posts to the channel routed for its report type and records where', async () => {
    const rec = await posted();
    expect(rec.status).toBe('posted');
    expect(rec.slackChannel).toBe('C0CALLS');
    expect(rec.slackTs).toBeTruthy();
    expect(rec.expiresAt!.getTime() - rec.postedAt!.getTime()).toBe(72 * 3600 * 1000);
    const [message] = h.slack.of('postMessage');
    expect(message!.channel).toBe('C0CALLS');
    expect(await auditActions(pool)).toContain('recommendation.post');
  });

  it('follows a route changed in the UI before posting', async () => {
    const { recommendation } = await createRecommendation(h, testRecommendation());
    await routeTo(pool, 'calls', 'C0ELSEWHERE');
    await postRecommendation(h.worker, recommendation.id);
    expect(h.slack.of('postMessage')[0]!.channel).toBe('C0ELSEWHERE');
  });

  it('keeps the top-level message to five lines and one row of four buttons', async () => {
    await posted({ body: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n') });
    const [message] = h.slack.of('postMessage');
    expect(lines(sectionText(message!))).toHaveLength(MAX_LINES);
    expect(buttons(message!)).toEqual(['Approve', 'Edit', 'Dismiss', 'Details']);
    expect(buttons(message!).length).toBeLessThanOrEqual(MAX_BUTTONS);
  });

  it('escapes text so content cannot mention a channel or forge a link', async () => {
    await posted({ title: 'Ping <!channel> & <https://evil.example|click>' });
    const text = sectionText(h.slack.of('postMessage')[0]!);
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;');
  });

  it('does not post twice', async () => {
    const rec = await posted();
    expect(await postRecommendation(h.worker, rec.id)).toBe('skipped');
    expect(h.slack.of('postMessage')).toHaveLength(1);
  });

  it('holds a recommendation whose report type has no channel, and says why', async () => {
    const { recommendation } = await createRecommendation(h, testRecommendation({ reportType: 'sales' }));
    expect(await postRecommendation(h.worker, recommendation.id)).toBe('held');
    const rec = (await getRecommendation(pool, recommendation.id))!;
    expect(rec.status).toBe('drafted');
    expect(rec.lastError).toMatch(/no channel is set for Sales/);
    expect(h.slack.calls).toHaveLength(0);
  });

  it('holds when Slack refuses for a reason a retry cannot fix, and reports it once', async () => {
    await routeTo(pool, 'errors', 'C0LOG');
    const { recommendation } = await createRecommendation(h, testRecommendation());
    h.slack.fail('not_in_channel');
    expect(await postRecommendation(h.worker, recommendation.id)).toBe('held');
    expect((await getRecommendation(pool, recommendation.id))!.lastError).toMatch(/not_in_channel.*Invite the bot/);
    const notices = h.slack.of('postMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.channel).toBe('C0LOG');
  });

  it('lets a temporary Slack failure propagate so the queue retries it', async () => {
    const { recommendation } = await createRecommendation(h, testRecommendation());
    h.slack.fail('rate_limited');
    await expect(postRecommendation(h.worker, recommendation.id)).rejects.toThrow(/rate_limited/);
    expect((await getRecommendation(pool, recommendation.id))!.status).toBe('drafted');
  });

  it('holds everything while Slack is not configured', async () => {
    const unconfigured = harness(pool, { hubTeamId: undefined });
    const { recommendation } = await createRecommendation(unconfigured, testRecommendation());
    expect(await postRecommendation(unconfigured.worker, recommendation.id)).toBe('held');
    expect((await getRecommendation(pool, recommendation.id))!.lastError).toMatch(/Slack is not configured/);
  });

  it('defers posts beyond the hourly limit for a channel', async () => {
    await setSetting(pool, 'slack.max_posts_per_hour', 2, OWNER);
    await posted({ title: 'One' });
    await posted({ title: 'Two' });
    const { recommendation } = await createRecommendation(h, testRecommendation({ title: 'Three' }));
    h.queue.clear();
    expect(await postRecommendation(h.worker, recommendation.id)).toBe('deferred');
    expect(h.slack.of('postMessage')).toHaveLength(2);
    const [requeued] = h.queue.jobs;
    expect(requeued!.name).toBe('recommendation.post');
    expect((requeued!.options.startAfter as Date).getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });
});

describe('deciding', () => {
  it('approves, runs the action once, edits the message to one line and logs the decision', async () => {
    const rec = await posted();
    h.queue.clear();

    const result = await decide(h, { ...input(rec), decision: 'approve' });
    expect(result.ok).toBe(true);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('approved');

    const [job] = h.queue.of('action.execute');
    expect(h.queue.of('recommendation.sync')).toEqual([{ recommendationId: rec.id }]);
    expect(await executeAction(h.worker, job!.actionId)).toBe('done');

    const after = (await getRecommendation(pool, rec.id))!;
    expect(after.status).toBe('done');
    expect(after.decidedBy).toBe(APPROVER);

    const update = h.slack.of('updateMessage').at(-1)!;
    expect(lines(sectionText(update))).toHaveLength(1);
    expect(sectionText(update)).toContain(`approved by <@${APPROVER}> · done`);
    expect(buttons(update)).toEqual([]);
    const reply = h.slack.of('postMessage').at(-1)!;
    expect(reply.threadTs).toBe(rec.slackTs);

    expect(await listApprovals(pool, rec.id)).toMatchObject([{ decision: 'approved', actor: APPROVER, via: 'slack', version: 1 }]);
    const [action] = await listActions(pool, rec.id);
    expect(action).toMatchObject({ status: 'done', attempts: 1, idempotencyKey: `rec:${rec.id}:v1` });
    expect(await auditActions(pool)).toEqual([
      'recommendation.create',
      'recommendation.post',
      'recommendation.approve',
      'action.done',
    ]);
    const audit = await pool.query(`SELECT actor, after FROM audit_log WHERE action = 'recommendation.approve'`);
    expect(audit.rows[0]).toMatchObject({ actor: APPROVER, after: { via: 'slack', status: 'approved', actionHash: rec.actionHash } });
  });

  it('records a decision made in the UI the same way', async () => {
    const rec = await posted();
    const result = await decide(h, { ...input(rec, OWNER, 'ui'), decision: 'approve' });
    expect(result.ok).toBe(true);
    expect(await listApprovals(pool, rec.id)).toMatchObject([{ actor: OWNER, via: 'ui' }]);
    // The Slack message is brought in line with a decision taken in the UI.
    await syncMessage(h.worker, rec.id);
    expect(sectionText(h.slack.of('updateMessage')[0]!)).toContain(`approved by <@${OWNER}>`);
  });

  it('dismisses without creating an action', async () => {
    const rec = await posted();
    h.queue.clear();
    expect((await decide(h, { ...input(rec), decision: 'dismiss' })).ok).toBe(true);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('dismissed');
    expect(h.queue.of('action.execute')).toEqual([]);
    expect(await listActions(pool, rec.id)).toEqual([]);
    await syncMessage(h.worker, rec.id);
    expect(sectionText(h.slack.of('updateMessage')[0]!)).toMatch(/dismissed by <@U0APPROVER>$/);
    expect(await auditActions(pool)).toContain('recommendation.dismiss');
  });

  it('accepts exactly one of two simultaneous approvals', async () => {
    const rec = await posted();
    h.queue.clear();
    const results = await Promise.all([
      decide(h, { ...input(rec, APPROVER), decision: 'approve' }),
      decide(h, { ...input(rec, OWNER), decision: 'approve' }),
      decide(h, { ...input(rec, APPROVER), decision: 'approve' }),
      decide(h, { ...input(rec, OWNER), decision: 'dismiss' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'not_pending')).toBe(true);
    expect(await listApprovals(pool, rec.id)).toHaveLength(1);
    expect((await listActions(pool, rec.id)).length).toBeLessThanOrEqual(1);
    expect(h.queue.of('action.execute').length).toBeLessThanOrEqual(1);
  });

  it('runs the action only once however many times the job is delivered', async () => {
    let runs = 0;
    h.catalog.registerAction({
      type: 'test.count',
      params: z.object({}).strict(),
      describe: () => 'Count a run.',
      execute: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { externalRef: 'run-1' };
      },
    });
    const rec = await posted({ action: { type: 'test.count', params: {} } });
    await decide(h, { ...input(rec), decision: 'approve' });
    const { actionId } = h.queue.of('action.execute')[0]!;
    h.queue.clear();
    const outcomes = await Promise.all([
      executeAction(h.worker, actionId),
      executeAction(h.worker, actionId),
      executeAction(h.worker, actionId),
    ]);
    // The copies that arrived while it was running step aside and ask to be looked at again.
    expect(outcomes.sort()).toEqual(['busy', 'busy', 'done']);
    expect(h.queue.of('action.execute')).toHaveLength(2);
    expect(await executeAction(h.worker, actionId)).toBe('already_finished');
    expect(runs).toBe(1);
    expect(await auditActions(pool)).not.toContain('action.failed');
    const replies = h.slack.of('postMessage').filter((m) => m.threadTs);
    expect(replies).toHaveLength(1);
  });

  it('refuses someone who is not on the approver list', async () => {
    const rec = await posted();
    for (const actor of [VIEWER, STRANGER]) {
      const result = await decide(h, { ...input(rec, actor), decision: 'approve' });
      expect(result).toMatchObject({ ok: false, reason: 'forbidden' });
    }
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    expect(await listApprovals(pool, rec.id)).toEqual([]);
  });

  it('honours the kinds a person may approve', async () => {
    await addUser(pool, 'U0SALES', 'approver', ['sales.proposal']);
    await addUser(pool, 'U0TESTS', 'approver', ['test']);
    const rec = await posted();
    expect(await decide(h, { ...input(rec, 'U0SALES'), decision: 'approve' })).toMatchObject({ ok: false, reason: 'forbidden' });
    expect((await decide(h, { ...input(rec, 'U0TESTS'), decision: 'approve' })).ok).toBe(true);
  });

  it('refuses a hash that is not the one stored', async () => {
    const rec = await posted();
    const result = await decide(h, { ...input(rec), hash: 'f'.repeat(64), decision: 'approve' });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
  });

  it('refuses an unknown or malformed id', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const result = await decide(h, { id, hash: 'x', actor: APPROVER, via: 'slack', decision: 'approve' });
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    }
  });

  it('refuses a decision on something not yet posted', async () => {
    const { recommendation } = await createRecommendation(h, testRecommendation());
    const result = await decide(h, { ...input(recommendation), decision: 'approve' });
    expect(result).toMatchObject({ ok: false, reason: 'not_pending' });
  });
});

describe('editing', () => {
  it('makes a new version with a new hash, and the old hash stops working', async () => {
    const rec = await posted();
    h.queue.clear();
    const edited = await editRecommendation(h, {
      ...input(rec),
      title: 'Add CSV and Excel export',
      body: rec.body,
      params: { note: 'edited' },
    });
    expect(edited.ok && edited.changed).toBe(true);
    const next = (await getRecommendation(pool, rec.id))!;
    expect(next.version).toBe(2);
    expect(next.status).toBe('posted');
    expect(next.actionHash).not.toBe(rec.actionHash);
    expect(next.action.params).toEqual({ note: 'edited' });
    expect(h.queue.of('recommendation.sync')).toEqual([{ recommendationId: rec.id }]);

    // An approval carrying the hash that was shown before the edit is refused.
    expect(await decide(h, { ...input(rec), decision: 'approve' })).toMatchObject({ ok: false, reason: 'stale' });
    expect((await decide(h, { ...input(next), decision: 'approve' })).ok).toBe(true);

    const approvals = await listApprovals(pool, rec.id);
    expect(approvals.map((a) => [a.decision, a.version])).toEqual([
      ['edited', 2],
      ['approved', 2],
    ]);
    const audit = await pool.query(`SELECT before, after FROM audit_log WHERE action = 'recommendation.edit'`);
    expect(audit.rows[0].before).toMatchObject({ version: 1, title: rec.title, actionHash: rec.actionHash });
    expect(audit.rows[0].after).toMatchObject({ version: 2, title: 'Add CSV and Excel export', actionHash: next.actionHash });
  });

  it('shows the edited content and new hash on the message', async () => {
    const rec = await posted();
    await editRecommendation(h, { ...input(rec), title: 'New title', body: 'New body', params: {} });
    await syncMessage(h.worker, rec.id);
    const update = h.slack.of('updateMessage')[0]!;
    const next = (await getRecommendation(pool, rec.id))!;
    expect(sectionText(update)).toContain('New title');
    expect(JSON.stringify(update.blocks)).toContain(`${rec.id}|${next.actionHash}`);
    expect(JSON.stringify(update.blocks)).not.toContain(rec.actionHash);
  });

  it('does not make a version when nothing changed', async () => {
    const rec = await posted();
    const result = await editRecommendation(h, { ...input(rec), title: rec.title, body: rec.body, params: rec.action.params });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect((await getRecommendation(pool, rec.id))!.version).toBe(1);
  });

  it('refuses parameters the catalog entry does not accept', async () => {
    const rec = await posted();
    const result = await editRecommendation(h, { ...input(rec), title: rec.title, body: rec.body, params: { run: 'rm -rf' } });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getRecommendation(pool, rec.id))!.version).toBe(1);
  });

  it('refuses an edit by a viewer', async () => {
    const rec = await posted();
    const result = await editRecommendation(h, { ...input(rec, VIEWER), title: 'x', body: '', params: {} });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden' });
  });
});

describe('failure and retry', () => {
  function registerFlaky(h: Harness) {
    const state = { fail: true, runs: 0 };
    h.catalog.registerAction({
      type: 'test.flaky',
      params: z.object({}).strict(),
      describe: () => 'Fail until told otherwise.',
      execute: () => {
        state.runs += 1;
        return state.fail ? Promise.reject(new Error('upstream said no')) : Promise.resolve({ externalRef: 'PR #41' });
      },
    });
    return state;
  }

  it('marks a failed action failed with the reason and offers Retry, without retrying on its own', async () => {
    const state = registerFlaky(h);
    const rec = await posted({ action: { type: 'test.flaky', params: {} } });
    h.queue.clear();
    await decide(h, { ...input(rec), decision: 'approve' });
    const { actionId } = h.queue.of('action.execute')[0]!;

    expect(await executeAction(h.worker, actionId)).toBe('failed');
    expect(await executeAction(h.worker, actionId)).toBe('already_finished');
    expect(state.runs).toBe(1);

    const failed = (await getRecommendation(pool, rec.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('upstream said no');
    const update = h.slack.of('updateMessage').at(-1)!;
    expect(sectionText(update)).toMatch(/failed$/);
    expect(buttons(update)).toEqual(['Retry', 'Details']);
    expect(h.slack.of('postMessage').at(-1)!.text).toBe('Failed: upstream said no');
    expect(await auditActions(pool)).toContain('action.failed');
  });

  it('runs again only when a person retries', async () => {
    const state = registerFlaky(h);
    const rec = await posted({ action: { type: 'test.flaky', params: {} } });
    await decide(h, { ...input(rec), decision: 'approve' });
    const { actionId } = h.queue.of('action.execute')[0]!;
    await executeAction(h.worker, actionId);
    h.queue.clear();

    expect(await retryRecommendation(h, input(rec, VIEWER))).toMatchObject({ ok: false, reason: 'forbidden' });
    state.fail = false;
    expect((await retryRecommendation(h, input(rec, OWNER, 'ui'))).ok).toBe(true);
    expect(h.queue.of('action.execute')).toEqual([{ actionId }]);
    expect(await executeAction(h.worker, actionId)).toBe('done');

    expect(state.runs).toBe(2);
    expect((await getRecommendation(pool, rec.id))!.status).toBe('done');
    const [action] = await listActions(pool, rec.id);
    expect(action).toMatchObject({ status: 'done', attempts: 2, externalRef: 'PR #41' });
    expect((await listApprovals(pool, rec.id)).map((a) => a.decision)).toEqual(['approved', 'retried']);
    expect(await auditActions(pool)).toContain('recommendation.retry');
  });

  it('treats an action found mid-run as failed, for a person to check', async () => {
    const state = registerFlaky(h);
    const rec = await posted({ action: { type: 'test.flaky', params: {} } });
    await decide(h, { ...input(rec), decision: 'approve' });
    const { actionId } = h.queue.of('action.execute')[0]!;
    // The worker died after starting the action and before recording how it ended.
    await pool.query(`UPDATE actions SET status = 'running', attempts = 1 WHERE id = $1`, [actionId]);
    await pool.query(`UPDATE recommendations SET status = 'executing' WHERE id = $1`, [rec.id]);

    expect(await executeAction(h.worker, actionId)).toBe('already_finished');
    expect(state.runs).toBe(0);
    const after = (await getRecommendation(pool, rec.id))!;
    expect(after.status).toBe('failed');
    expect(after.lastError).toMatch(/Interrupted/);
  });
});

describe('dry run', () => {
  it('logs the action instead of executing it, from the switch or the environment', async () => {
    for (const mode of ['switch', 'env'] as const) {
      await resetDb(pool);
      await seedPeople(pool);
      await routeTo(pool, 'calls', 'C0CALLS');
      h = harness(pool, { dryRunEnv: mode === 'env' });
      if (mode === 'switch') await setSetting(pool, 'dry_run', true, OWNER);
      let runs = 0;
      h.catalog.registerAction({
        type: 'test.count',
        params: z.object({}).strict(),
        describe: () => 'Count a run.',
        execute: () => Promise.resolve({ externalRef: String(++runs) }),
      });
      const rec = await posted({ action: { type: 'test.count', params: {} } });
      await decide(h, { ...input(rec), decision: 'approve' });
      await executeAction(h.worker, h.queue.of('action.execute')[0]!.actionId);
      expect(runs).toBe(0);
      const [action] = await listActions(pool, rec.id);
      expect(action).toMatchObject({ status: 'done', dryRun: true });
      expect(h.slack.of('postMessage').at(-1)!.text).toMatch(/^Dry run/);
    }
  });
});

describe('pause', () => {
  it('refuses approvals, holds posts and actions, and picks them up on resume', async () => {
    const waitingForApproval = await posted({ title: 'Posted before the pause' });
    const approvedBefore = await posted({ title: 'Approved before the pause' });
    await decide(h, { ...input(approvedBefore), decision: 'approve' });
    const { actionId } = h.queue.of('action.execute')[0]!;

    await setPaused(h, true, APPROVER);
    const { recommendation: draftedDuring } = await createRecommendation(h, testRecommendation({ title: 'During' }));

    expect(await decide(h, { ...input(waitingForApproval), decision: 'approve' })).toMatchObject({ ok: false, reason: 'paused' });
    expect(await postRecommendation(h.worker, draftedDuring.id)).toBe('held');
    expect(await executeAction(h.worker, actionId)).toBe('held');
    expect((await listActions(pool, approvedBefore.id))[0]!.status).toBe('pending');
    // Dismissing runs nothing, so it stays possible while paused.
    const other = await getRecommendation(pool, waitingForApproval.id);
    expect((await decide(h, { ...input(other!), decision: 'dismiss' })).ok).toBe(true);

    h.queue.clear();
    await setPaused(h, false, OWNER);
    expect(h.queue.of('system.resume')).toEqual([{ requestedBy: OWNER }]);
    h.queue.clear();
    expect(await resumeHeld(h.worker)).toEqual({ posts: 1, actions: 1 });
    expect(h.queue.of('recommendation.post')).toEqual([{ recommendationId: draftedDuring.id }]);
    expect(h.queue.of('action.execute')).toEqual([{ actionId }]);
    expect(await executeAction(h.worker, actionId)).toBe('done');

    const audit = await pool.query(`SELECT actor, before, after FROM audit_log WHERE action = 'setting.update' ORDER BY id`);
    expect(audit.rows).toMatchObject([
      { actor: APPROVER, before: false, after: true },
      { actor: OWNER, before: true, after: false },
    ]);
  });
});

describe('details', () => {
  it('posts the evidence and the exact action once in the thread', async () => {
    const rec = await posted();
    await postDetails(h.worker, rec.id);
    await postDetails(h.worker, rec.id);
    const replies = h.slack.of('postMessage').filter((m) => m.threadTs === rec.slackTs);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('Can we get a CSV export?');
    expect(replies[0]!.text).toContain('On approval: Record the approval only.');
    expect(replies[0]!.text).toContain(`/approvals/${rec.id}`);
  });
});

describe('expiry', () => {
  const HOUR = 3600 * 1000;

  it('reminds once in the thread, then expires on a later run', async () => {
    const rec = await posted();
    const postedAt = rec.postedAt!.getTime();
    h.queue.clear();

    expect(await runExpiry(h.worker, new Date(postedAt + 10 * HOUR))).toBe('0 reminded, 0 expired');
    expect(await runExpiry(h.worker, new Date(postedAt + 50 * HOUR))).toBe('1 reminded, 0 expired');
    const reminder = h.slack.of('postMessage').at(-1)!;
    expect(reminder.threadTs).toBe(rec.slackTs);
    expect(reminder.text).toMatch(/Reminder.*in about 22 hours/);

    expect(await runExpiry(h.worker, new Date(postedAt + 60 * HOUR))).toBe('0 reminded, 0 expired');
    expect(await runExpiry(h.worker, new Date(postedAt + 73 * HOUR))).toBe('0 reminded, 1 expired');
    expect((await getRecommendation(pool, rec.id))!.status).toBe('expired');
    expect(h.queue.of('recommendation.sync')).toEqual([{ recommendationId: rec.id }]);
    expect(await auditActions(pool)).toContain('recommendation.expire');

    await syncMessage(h.worker, rec.id);
    expect(sectionText(h.slack.of('updateMessage')[0]!)).toMatch(/expired with no decision$/);
    expect(await decide(h, { ...input(rec), decision: 'approve' })).toMatchObject({ ok: false, reason: 'not_pending' });
  });

  it('never expires without the reminder having gone out on an earlier run', async () => {
    const rec = await posted();
    const late = new Date(rec.postedAt!.getTime() + 200 * HOUR);
    expect(await runExpiry(h.worker, late)).toBe('1 reminded, 0 expired');
    expect((await getRecommendation(pool, rec.id))!.status).toBe('posted');
    expect(await runExpiry(h.worker, late)).toBe('0 reminded, 1 expired');
  });

  it('leaves decided recommendations alone', async () => {
    const rec = await posted();
    await decide(h, { ...input(rec), decision: 'dismiss' });
    expect(await runExpiry(h.worker, new Date(rec.postedAt!.getTime() + 200 * HOUR))).toBe('0 reminded, 0 expired');
  });
});
