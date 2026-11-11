/**
 * Shapes shared by the call pipeline (design section 5): what an adapter returns, and what
 * is stored once it has been grouped into a call.
 */
export const VENDORS = ['calendly', 'fathom'] as const;
export type Vendor = (typeof VENDORS)[number];
export type TranscriptOrigin = Vendor | 'upload';

export const VENDOR_LABEL: Record<TranscriptOrigin, string> = {
  calendly: 'Calendly',
  fathom: 'Fathom',
  upload: 'Upload',
};

export function isVendor(value: string): value is Vendor {
  return (VENDORS as readonly string[]).includes(value);
}

export interface Attendee {
  name: string | null;
  email: string | null;
  /** Fathom says whether an invitee is outside the recorder's organisation. Null: not known. */
  external: boolean | null;
}

/** One transcript in the shape every source is reduced to (design 5.1). */
export interface NormalizedTranscript {
  source: TranscriptOrigin;
  externalId: string;
  title: string;
  startedAt: Date | null;
  durationSeconds: number | null;
  /** Calendly's host attendee, or the person whose Fathom recorded the call. */
  hostEmail: string | null;
  attendees: Attendee[];
  /** One line per turn: `[HH:MM:SS] Speaker: words` where the source gives both. */
  text: string;
  hasSpeakers: boolean;
  hasTimestamps: boolean;
  url: string | null;
}

export const CALL_STATUSES = ['received', 'analyzing', 'needs_project', 'unmatched', 'matched', 'held', 'failed', 'deleted'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  received: 'Received',
  analyzing: 'Analysing',
  needs_project: 'Needs answer',
  unmatched: 'Unmatched',
  matched: 'Matched',
  held: 'Waiting',
  failed: 'Failed',
  deleted: 'Deleted at source',
};

export interface Call {
  id: string;
  title: string;
  startedAt: Date | null;
  durationSeconds: number | null;
  hostEmail: string | null;
  attendees: Attendee[];
  status: CallStatus;
  statusDetail: string | null;
  holdReason: string | null;
  analyzeAfter: Date | null;
  version: number;
  suggestedVersion: number | null;
  summary: string | null;
  slackTeam: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  postedAt: Date | null;
  postError: string | null;
  detailsTs: string | null;
  projectSetBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallRow {
  id: string;
  title: string;
  started_at: Date | null;
  duration_seconds: number | null;
  host_email: string | null;
  attendees: Attendee[];
  status: CallStatus;
  status_detail: string | null;
  hold_reason: string | null;
  analyze_after: Date | null;
  version: number;
  suggested_version: number | null;
  summary: string | null;
  slack_team: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: Date | null;
  post_error: string | null;
  details_ts: string | null;
  project_set_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const callFromRow = (r: CallRow): Call => ({
  id: r.id,
  title: r.title,
  startedAt: r.started_at,
  durationSeconds: r.duration_seconds,
  hostEmail: r.host_email,
  attendees: r.attendees,
  status: r.status,
  statusDetail: r.status_detail,
  holdReason: r.hold_reason,
  analyzeAfter: r.analyze_after,
  version: r.version,
  suggestedVersion: r.suggested_version,
  summary: r.summary,
  slackTeam: r.slack_team,
  slackChannel: r.slack_channel,
  slackTs: r.slack_ts,
  postedAt: r.posted_at,
  postError: r.post_error,
  detailsTs: r.details_ts,
  projectSetBy: r.project_set_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface StoredTranscript {
  id: string;
  source: TranscriptOrigin;
  connectionId: string | null;
  externalId: string;
  callId: string;
  isPreferred: boolean;
  title: string;
  startedAt: Date | null;
  durationSeconds: number | null;
  hostEmail: string | null;
  attendees: Attendee[];
  /** Null once the retention purge has removed it. */
  text: string | null;
  hasSpeakers: boolean;
  hasTimestamps: boolean;
  url: string | null;
  purgeAfter: Date;
  purgedAt: Date | null;
  createdAt: Date;
}

export interface TranscriptRow {
  id: string;
  source: TranscriptOrigin;
  connection_id: string | null;
  external_id: string;
  call_id: string;
  is_preferred: boolean;
  title: string;
  started_at: Date | null;
  duration_seconds: number | null;
  host_email: string | null;
  attendees: Attendee[];
  text: string | null;
  has_speakers: boolean;
  has_timestamps: boolean;
  url: string | null;
  purge_after: Date;
  purged_at: Date | null;
  created_at: Date;
}

export const transcriptFromRow = (r: TranscriptRow): StoredTranscript => ({
  id: r.id,
  source: r.source,
  connectionId: r.connection_id,
  externalId: r.external_id,
  callId: r.call_id,
  isPreferred: r.is_preferred,
  title: r.title,
  startedAt: r.started_at,
  durationSeconds: r.duration_seconds,
  hostEmail: r.host_email,
  attendees: r.attendees,
  text: r.text,
  hasSpeakers: r.has_speakers,
  hasTimestamps: r.has_timestamps,
  url: r.url,
  purgeAfter: r.purge_after,
  purgedAt: r.purged_at,
  createdAt: r.created_at,
});

export const SUGGESTION_TYPES = ['code_change', 'task', 'client_followup', 'note'] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];

export const SUGGESTION_LABEL: Record<SuggestionType, string> = {
  code_change: 'Code change',
  task: 'Task',
  client_followup: 'Follow-up',
  note: 'Note',
};

export interface CallMatch {
  projectId: string;
  projectName: string;
  confidence: number;
  state: 'matched' | 'candidate';
  source: 'model' | 'rules' | 'person';
  decidedBy: string | null;
  evidence: { quote?: string; at?: string | null; hints?: string[] };
}

export interface CallSuggestion {
  id: string;
  callId: string;
  projectId: string;
  version: number;
  position: number;
  type: SuggestionType;
  draftedType: SuggestionType | null;
  typeNote: string | null;
  title: string;
  detail: string;
  draft: string | null;
  quote: string;
  quoteAt: string | null;
  repo: string | null;
  brief: string | null;
  recommendationId: string | null;
}

export interface SuggestionRow {
  id: string;
  call_id: string;
  project_id: string;
  version: number;
  position: number;
  type: SuggestionType;
  drafted_type: SuggestionType | null;
  type_note: string | null;
  title: string;
  detail: string;
  draft: string | null;
  quote: string;
  quote_at: string | null;
  repo: string | null;
  brief: string | null;
  recommendation_id: string | null;
}

export const suggestionFromRow = (r: SuggestionRow): CallSuggestion => ({
  id: r.id,
  callId: r.call_id,
  projectId: r.project_id,
  version: r.version,
  position: r.position,
  type: r.type,
  draftedType: r.drafted_type,
  typeNote: r.type_note,
  title: r.title,
  detail: r.detail,
  draft: r.draft,
  quote: r.quote,
  quoteAt: r.quote_at,
  repo: r.repo,
  brief: r.brief,
  recommendationId: r.recommendation_id,
});

export const minutes = (seconds: number | null): string | null =>
  seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min`;
