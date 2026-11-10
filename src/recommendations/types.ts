import { z } from 'zod';
import type { ReportType } from '../settings/routes.js';
import type { ProposedAction } from './catalog.js';

export const RECOMMENDATION_STATUSES = [
  'drafted',
  'posted',
  'approved',
  'executing',
  'done',
  'failed',
  'dismissed',
  'expired',
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** Guardrail 2: every recommendation carries a quote and a pointer to where it came from. */
export const evidenceSchema = z.object({
  quote: z.string().trim().min(1).max(2000),
  source: z.string().trim().min(1).max(300),
  url: z.string().url().max(2000).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .refine((s) => !/[\r\n]/.test(s), 'The title must be one line.');
export const bodySchema = z.string().trim().max(2000);

export type Risk = 'low' | 'medium' | 'high';

export interface Recommendation {
  id: string;
  kind: string;
  reportType: ReportType;
  sourceType: string;
  sourceId: string | null;
  title: string;
  body: string;
  evidence: Evidence[];
  action: ProposedAction;
  actionHash: string;
  version: number;
  risk: Risk;
  status: RecommendationStatus;
  slackTeam: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  postedAt: Date | null;
  expiresAt: Date | null;
  remindedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  detailsTs: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRecord {
  decision: 'approved' | 'dismissed' | 'edited' | 'retried';
  actor: string;
  via: 'slack' | 'ui';
  version: number;
  at: Date;
}

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ActionRecord {
  id: string;
  recommendationId: string;
  type: string;
  request: unknown;
  idempotencyKey: string;
  status: ActionStatus;
  dryRun: boolean;
  externalRef: string | null;
  attempts: number;
  lastError: string | null;
  reportedAt: Date | null;
}

export interface RecommendationRow {
  id: string;
  kind: string;
  report_type: ReportType;
  source_type: string;
  source_id: string | null;
  title: string;
  body: string;
  evidence: Evidence[];
  proposed_action: ProposedAction;
  action_hash: string;
  version: number;
  risk: Risk;
  status: RecommendationStatus;
  slack_team: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: Date | null;
  expires_at: Date | null;
  reminded_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  details_ts: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export const recommendationFromRow = (r: RecommendationRow): Recommendation => ({
  id: r.id,
  kind: r.kind,
  reportType: r.report_type,
  sourceType: r.source_type,
  sourceId: r.source_id,
  title: r.title,
  body: r.body,
  evidence: r.evidence,
  action: r.proposed_action,
  actionHash: r.action_hash,
  version: r.version,
  risk: r.risk,
  status: r.status,
  slackTeam: r.slack_team,
  slackChannel: r.slack_channel,
  slackTs: r.slack_ts,
  postedAt: r.posted_at,
  expiresAt: r.expires_at,
  remindedAt: r.reminded_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  detailsTs: r.details_ts,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface ActionRow {
  id: string;
  recommendation_id: string;
  type: string;
  request: unknown;
  idempotency_key: string;
  status: ActionStatus;
  dry_run: boolean;
  external_ref: string | null;
  attempts: number;
  last_error: string | null;
  reported_at: Date | null;
}

export const actionFromRow = (r: ActionRow): ActionRecord => ({
  id: r.id,
  recommendationId: r.recommendation_id,
  type: r.type,
  request: r.request,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  dryRun: r.dry_run,
  externalRef: r.external_ref,
  attempts: r.attempts,
  lastError: r.last_error,
  reportedAt: r.reported_at,
});
