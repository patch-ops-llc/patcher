import type { JobQueue } from '../queue/queue.js';
import { postDetails, postRecommendation, resumeHeld, syncMessage } from '../recommendations/delivery.js';
import { executeAction } from '../recommendations/executor.js';
import { runExpiry } from '../recommendations/expiry.js';
import { listRecommendations } from '../recommendations/service.js';
import { replaceChannels } from '../settings/routes.js';
import { isPaused } from '../settings/settings.js';
import { getUser } from '../settings/users.js';
import { SlackApiError } from '../slack/client.js';
import { clip, homeView } from '../slack/messages.js';
import type { WorkerDeps } from './deps.js';
import { notifyOps } from './notify.js';

/** A schedule's handler returns one short line for the run log. */
export type ScheduleHandler = (deps: WorkerDeps) => Promise<string>;

/**
 * Schedule key to handler. A later phase adds a row to `schedules` in its migration and an
 * entry here (for example `audit.weekly`).
 */
export const scheduleHandlers: Record<string, ScheduleHandler> = {
  'approvals.expire': (deps) => runExpiry(deps),
};

export async function runSchedule(
  deps: WorkerDeps,
  handlers: Record<string, ScheduleHandler>,
  job: { key: string; trigger: 'schedule' | 'manual' },
): Promise<void> {
  const run = await deps.pool.query<{ id: string }>(
    'INSERT INTO runs (pipeline, trigger) VALUES ($1, $2) RETURNING id',
    [job.key, job.trigger],
  );
  const runId = run.rows[0]!.id;
  const finish = async (ok: boolean, summary: string) => {
    await deps.pool.query('UPDATE runs SET finished_at = now(), ok = $2, summary = $3 WHERE id = $1', [
      runId,
      ok,
      clip(summary, 500),
    ]);
    await deps.pool.query('UPDATE schedules SET last_ok = $2 WHERE key = $1', [job.key, ok]);
  };
  const handler = handlers[job.key];
  if (!handler) {
    await finish(false, 'No handler is registered for this schedule.');
    throw new Error(`No handler for schedule ${job.key}`);
  }
  try {
    const summary = await handler({ ...deps, log: deps.log.child({ runId, pipeline: job.key }) });
    await finish(true, summary);
  } catch (err) {
    await finish(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Slack event type to handler, for events `web` stored and enqueued. */
type SlackEventHandler = (deps: WorkerDeps, event: Record<string, unknown>) => Promise<void>;

export const slackEventHandlers: Record<string, SlackEventHandler> = {
  app_home_opened: async (deps, event) => {
    if (event.tab !== 'home' || typeof event.user !== 'string') return;
    const user = await getUser(deps.pool, event.user);
    // The Home tab lists approvals, so it is shown only to people on the allowlist.
    const pending = user ? await listRecommendations(deps.pool, ['posted'], 50) : [];
    const view = user
      ? homeView(pending, (kind) => deps.catalog.label(kind), deps.appBaseUrl, await isPaused(deps.pool))
      : {
          type: 'home',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'You do not have access to Patcher.' } }],
        };
    await deps.slack.publishHome({ userId: event.user, view });
  },
};

export async function handleSlackEvent(deps: WorkerDeps, webhookEventId: string): Promise<void> {
  const { rows } = await deps.pool.query<{ payload: { event?: Record<string, unknown> }; processed_at: Date | null }>(
    'SELECT payload, processed_at FROM webhook_events WHERE id = $1',
    [webhookEventId],
  );
  const row = rows[0];
  if (!row || row.processed_at) return;
  const event = row.payload.event;
  const type = typeof event?.type === 'string' ? event.type : undefined;
  const handler = type ? slackEventHandlers[type] : undefined;
  if (event && handler) {
    try {
      await handler(deps, event);
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.retryable) throw err;
      deps.log.warn('slack event handler could not reach slack', { type, code: err.code });
    }
  }
  await deps.pool.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [webhookEventId]);
}

async function permanentSlackFailureIsFinal(deps: WorkerDeps, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof SlackApiError) || err.retryable) throw err;
    deps.log.warn(`${what} could not reach slack`, { code: err.code });
  }
}

/** Registers every consumer. This is the list of what the worker does. */
export async function registerHandlers(queue: JobQueue, deps: WorkerDeps): Promise<void> {
  await queue.work('recommendation.post', async (data) => {
    const outcome = await postRecommendation(deps, data.recommendationId);
    deps.log.info('recommendation post', { recommendationId: data.recommendationId, outcome });
  });
  await queue.work('recommendation.sync', (data) => syncMessage(deps, data.recommendationId));
  await queue.work('recommendation.details', (data) => postDetails(deps, data.recommendationId));
  await queue.work('action.execute', async (data) => {
    const outcome = await executeAction(deps, data.actionId);
    deps.log.info('action execute', { actionId: data.actionId, outcome });
  });
  await queue.work('slack.respond', (data) =>
    permanentSlackFailureIsFinal(deps, 'private reply', () => deps.slack.respond(data.responseUrl, data.text)),
  );
  await queue.work('slack.event', (data) => handleSlackEvent(deps, data.webhookEventId));
  await queue.work('slack.channels.sync', async () => {
    if (!deps.hubTeamId) return;
    const hubTeamId = deps.hubTeamId;
    await permanentSlackFailureIsFinal(deps, 'channel list', async () => {
      const channels = await deps.slack.listChannels();
      await replaceChannels(deps.pool, hubTeamId, channels);
      deps.log.info('channel list refreshed', { count: channels.length });
    });
  });
  await queue.work('schedule.run', (data) => runSchedule(deps, scheduleHandlers, data));
  await queue.work('system.resume', async () => {
    if (await isPaused(deps.pool)) return;
    const resumed = await resumeHeld(deps);
    deps.log.info('resumed held work', resumed);
  });

  await queue.onDeadLetter(async (dead) => {
    deps.log.error('job dead-lettered', { queue: dead.queue, jobId: dead.jobId, error: dead.error });
    await deps.pool.query(
      `INSERT INTO runs (pipeline, trigger, finished_at, ok, summary) VALUES ($1, 'job', now(), false, $2)`,
      [dead.queue, clip(dead.error, 500)],
    );
    await notifyOps(deps, `Job failed · ${dead.queue} · ${clip(dead.error, 200)}`);
  });
}
