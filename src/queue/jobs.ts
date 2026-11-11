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
  /** After a resume: pick up what waited while paused. */
  'system.resume': z.strictObject({ requestedBy: z.string() }),
} as const;

export type JobName = keyof typeof jobSchemas;
export type JobData<N extends JobName> = z.infer<(typeof jobSchemas)[N]>;
export const jobNames = Object.keys(jobSchemas) as JobName[];
