import { z } from 'zod';

const id = z.string().uuid();

/**
 * Every job the system can enqueue, with the shape of its payload. A later phase adds its
 * jobs here and registers a consumer in the worker; the queue itself needs no other change.
 */
export const jobSchemas = {
  /** Post a drafted recommendation to its routed channel. */
  'recommendation.post': z.strictObject({ recommendationId: id }),
  /** Make the Slack message match the recommendation's current state. */
  'recommendation.sync': z.strictObject({ recommendationId: id }),
  /** Post the evidence and exact action in the recommendation's thread. */
  'recommendation.details': z.strictObject({ recommendationId: id }),
  /** Run an approved action from the catalog. */
  'action.execute': z.strictObject({ actionId: id }),
  /** Reply privately to the person who clicked, through Slack's response URL. */
  'slack.respond': z.strictObject({ responseUrl: z.string().url(), text: z.string().min(1).max(2000) }),
  /** Handle a stored Slack event. */
  'slack.event': z.strictObject({ webhookEventId: z.string().regex(/^\d+$/) }),
  /** Refresh the cached list of hub channels. */
  'slack.channels.sync': z.strictObject({ requestedBy: z.string() }),
  /** Run one schedule's handler. */
  'schedule.run': z.strictObject({
    key: z.string().min(1),
    trigger: z.enum(['schedule', 'manual']),
    scheduledFor: z.string().datetime(),
  }),
  /** Run the weekly audit. Its own queue, because it runs for minutes and must not be retried blindly. */
  'audit.run': z.strictObject({ trigger: z.enum(['schedule', 'manual']), requestedBy: z.string() }),
  /** Ask the model provider whether an audit's batch of per-service analyses has ended, and finish the audit when it has. */
  'audit.analyze': z.strictObject({ runId: id }),
  /** Draft a fix for one finding, asked for from its page: the brief, then the recommendation. */
  'audit.fix.propose': z.strictObject({ findingId: id, requestedBy: z.string() }),
  /** Post a finished audit's report to the channel routed for audits. */
  'audit.report.post': z.strictObject({ runId: id }),
  /** Ask Cursor how an agent started by an approved fix is doing. */
  'agent.poll': z.strictObject({ agentRunId: id }),
  /** Check a newly connected Calendly token or Fathom key and register its webhook. */
  'calls.connection.setup': z.strictObject({ connectionId: id }),
  /** Remove a connection's webhook at the vendor and forget its key. */
  'calls.connection.remove': z.strictObject({ connectionId: id, requestedBy: z.string() }),
  /** Ask one connection for the calls since its watermark. */
  'calls.poll': z.strictObject({ connectionId: id }),
  /** Verify and handle a stored Calendly or Fathom webhook. */
  'calls.webhook': z.strictObject({ webhookEventId: z.string().regex(/^\d+$/) }),
  /** Match a call to a project. */
  'calls.analyze': z.strictObject({ callId: id }),
  /** Draft the suggested changes for a matched call. */
  'calls.suggest': z.strictObject({ callId: id }),
  /** Post or update the one Slack message for a call. */
  'calls.post': z.strictObject({ callId: id }),
  /** Post a call's quotes and briefs in its thread. */
  'calls.details': z.strictObject({ callId: id }),
  /** Say what kind of call an analysed call was, and start the proposal pipeline for a sales call. */
  'sales.classify': z.strictObject({ callId: id }),
  /** Write the deal brief, the proposal and its check for a sales call. */
  'sales.draft': z.strictObject({ callId: id }),
  /** Post or update the one Slack message for a sales call, and offer its proposal for approval. */
  'sales.post': z.strictObject({ callId: id }),
  /** Read a settled bundle of Slack messages: triage, then the recommendation. */
  'inbox.bundle': z.strictObject({ bundleId: id }),
  /** Post or update the message of one Slack item that does not wait for the digest. */
  'inbox.post': z.strictObject({ bundleId: id }),
  /** Post or update one digest. */
  'inbox.digest.post': z.strictObject({ digestId: id }),
  /** Look again at the open items of one conversation: the reader answered, or a message was deleted. */
  'inbox.recheck': z.strictObject({ workspaceId: id, channelKey: z.string().min(1).max(300) }),
  /** Read channel history for a window the events did not cover. */
  'inbox.backfill': z.strictObject({ backfillId: id }),
  /** Check a newly connected reader's token and learn the workspace's address. */
  'inbox.workspace.check': z.strictObject({ workspaceId: id }),
  /** A workspace was switched off: revoke and forget its token. */
  'inbox.workspace.off': z.strictObject({ workspaceId: id, requestedBy: z.string() }),
  /** After a resume: pick up what waited while paused. */
  'system.resume': z.strictObject({ requestedBy: z.string() }),
} as const;

export type JobName = keyof typeof jobSchemas;
export type JobData<N extends JobName> = z.infer<(typeof jobSchemas)[N]>;
export const jobNames = Object.keys(jobSchemas) as JobName[];
