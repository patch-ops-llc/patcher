import { analyzeCall, resumeWaitingCalls, suggestForCall } from '../calls/analyze.js';
import { handleWebhook, pollAll, pollConnection, removeConnection, setupConnection } from '../calls/connections.js';
import { postCall, postCallDetails, resumeHeldCallPosts } from '../calls/delivery.js';
import { purgeTranscripts } from '../calls/ingest.js';
import { pollAgentRun } from '../fix/agentFix.js';
import { runProbes } from '../probes/run.js';
import { postSales, resumeHeldSalesPosts } from '../sales/delivery.js';
import { syncDealRoom } from '../sales/dealroomSync.js';
import { classifyCall, draftProposal, resumeWaitingSales } from '../sales/pipeline.js';
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
import { pollAnalysis, proposeFixFor } from '../weekly/analyze.js';
import { postAuditReport, resumeHeldReports } from '../weekly/delivery.js';
import { runAudit } from '../weekly/run.js';
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
  // The audit runs for minutes, so the schedule only starts it; the run is recorded when it ends.
  'audit.weekly': async (deps) => {
    if (!deps.integrations.railway) return 'Skipped: Railway is not configured (RAILWAY_API_TOKEN).';
    await deps.queue.enqueue('audit.run', { trigger: 'schedule', requestedBy: 'system' });
    return 'Audit started.';
  },
  'probe.health': (deps) => runProbes(deps),
  // The catch-up for missed webhooks, and the moment calls that were waiting are looked at again.
  'transcripts.poll': async (deps) => {
    const resumed = (await resumeWaitingCalls(deps)) + (await resumeWaitingSales(deps));
    const polled = await pollAll(deps);
    return resumed ? `${polled} ${resumed} waiting ${resumed === 1 ? 'call' : 'calls'} picked up again.` : polled;
  },
  'retention.purge': (deps) => purgeTranscripts(deps.pool),
  // Reads the state of the deal room pull requests Patcher opened. It never changes one.
  'dealroom.sync': (deps) => syncDealRoom(deps),
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
    const reports = await resumeHeldReports(deps);
    const callPosts = await resumeHeldCallPosts(deps);
    const calls = await resumeWaitingCalls(deps);
    const salesPosts = await resumeHeldSalesPosts(deps);
    const sales = await resumeWaitingSales(deps);
    deps.log.info('resumed held work', { ...resumed, auditReports: reports, callPosts, calls, salesPosts, sales });
  });
  await queue.work('audit.run', async (data) => {
    const started = new Date();
    const record = (ok: boolean, summary: string) =>
      deps.pool.query(
        `INSERT INTO runs (pipeline, trigger, started_at, finished_at, ok, summary) VALUES ('audit', $1, $2, now(), $3, $4)`,
        [data.trigger, started, ok, clip(summary, 500)],
      );
    try {
      const outcome = await runAudit(deps, data.trigger, data.requestedBy);
      await record(true, outcome.summary);
      deps.log.info('audit finished', { ...outcome });
    } catch (err) {
      await record(false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
  await queue.work('audit.analyze', async (data) => {
    const outcome = await pollAnalysis(deps, data.runId);
    deps.log[outcome === 'done' ? 'info' : 'debug']('audit analysis', { runId: data.runId, outcome });
  });
  await queue.work('audit.fix.propose', async (data) => {
    const recommendation = await proposeFixFor(deps, data.findingId, data.requestedBy);
    deps.log.info('fix proposal', { findingId: data.findingId, recommendationId: recommendation?.id ?? null });
  });
  await queue.work('audit.report.post', async (data) => {
    const outcome = await postAuditReport(deps, data.runId);
    deps.log.info('audit report post', { runId: data.runId, outcome });
  });
  await queue.work('agent.poll', async (data) => {
    const outcome = await pollAgentRun(deps, data.agentRunId);
    deps.log.debug('agent poll', { agentRunId: data.agentRunId, outcome });
  });

  await queue.work('calls.connection.setup', async (data) => {
    const outcome = await setupConnection(deps, data.connectionId);
    deps.log.info('call source setup', { connectionId: data.connectionId, outcome });
  });
  await queue.work('calls.connection.remove', async (data) => {
    const removed = await removeConnection(deps, data.connectionId, data.requestedBy);
    deps.log.info('call source removed', { connectionId: data.connectionId, removed });
  });
  await queue.work('calls.poll', async (data) => {
    const result = await pollConnection(deps, data.connectionId);
    deps.log.info('call source poll', { connectionId: data.connectionId, ...result });
  });
  await queue.work('calls.webhook', async (data) => {
    const outcome = await handleWebhook(deps, data.webhookEventId);
    deps.log.info('call webhook', { webhookEventId: data.webhookEventId, outcome });
  });
  await queue.work('calls.analyze', async (data) => {
    const outcome = await analyzeCall(deps, data.callId);
    deps.log.info('call analysis', { callId: data.callId, outcome });
  });
  await queue.work('calls.suggest', async (data) => {
    const outcome = await suggestForCall(deps, data.callId);
    deps.log.info('call suggestions', { callId: data.callId, outcome });
  });
  await queue.work('calls.post', async (data) => {
    const outcome = await postCall(deps, data.callId);
    deps.log.info('call post', { callId: data.callId, outcome });
  });
  await queue.work('calls.details', (data) => postCallDetails(deps, data.callId));

  await queue.work('sales.classify', async (data) => {
    const outcome = await classifyCall(deps, data.callId);
    deps.log.info('sales classify', { callId: data.callId, outcome });
  });
  await queue.work('sales.draft', async (data) => {
    const outcome = await draftProposal(deps, data.callId);
    deps.log.info('proposal draft', { callId: data.callId, outcome });
  });
  await queue.work('sales.post', async (data) => {
    const outcome = await postSales(deps, data.callId);
    deps.log.info('sales post', { callId: data.callId, outcome });
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
