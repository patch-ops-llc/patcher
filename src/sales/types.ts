import type { RoomChange } from '../dealroom/plan.js';
import type { RoomStatus } from '../dealroom/service.js';

/** What kind of conversation a call was (design 6.1). The two sales types start the proposal pipeline. */
export const CALL_TYPES = ['sales_discovery', 'sales_followup', 'client_delivery', 'internal', 'other'] as const;
export type CallType = (typeof CALL_TYPES)[number];

export const CALL_TYPE_LABEL: Record<CallType, string> = {
  sales_discovery: 'Sales: discovery',
  sales_followup: 'Sales: follow-up',
  client_delivery: 'Client delivery',
  internal: 'Internal',
  other: 'Other',
};

export const isCallType = (value: unknown): value is CallType => typeof value === 'string' && (CALL_TYPES as readonly string[]).includes(value);
export const isSalesType = (value: unknown): boolean => value === 'sales_discovery' || value === 'sales_followup';

export const SALES_CARRIER = 'sales_call';
export const PROPOSAL_KIND = 'proposal';
/** Publishing a draft room, and writing to a room that is live or holds a person's edits. Its own kind, so the owner can say who may. */
export const DEALROOM_KIND = 'dealroom_publish';

export type PenguinReason = 'host' | 'attendee' | 'flagged';

export interface Contact {
  name: string;
  role: string;
  email: string | null;
}

export interface Deal {
  id: string;
  company: string;
  domain: string | null;
  contacts: Contact[];
  /** Null: the rule could not be tested and nobody has said. */
  isPenguin: boolean | null;
  penguinReason: PenguinReason | null;
  penguinSetBy: string | null;
  dealRoomSlug: string | null;
  dealRoomRef: string | null;
  dealRoomSkipped: boolean;
  stage: 'open' | 'proposal_final' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

export interface DealRow {
  id: string;
  company: string;
  domain: string | null;
  contacts: Contact[];
  is_penguin: boolean | null;
  penguin_reason: PenguinReason | null;
  penguin_set_by: string | null;
  deal_room_slug: string | null;
  deal_room_ref: string | null;
  deal_room_skipped: boolean;
  stage: Deal['stage'];
  created_at: Date;
  updated_at: Date;
}

export const dealFromRow = (r: DealRow): Deal => ({
  id: r.id,
  company: r.company,
  domain: r.domain,
  contacts: r.contacts,
  isPenguin: r.is_penguin,
  penguinReason: r.penguin_reason,
  penguinSetBy: r.penguin_set_by,
  dealRoomSlug: r.deal_room_slug,
  dealRoomRef: r.deal_room_ref,
  dealRoomSkipped: r.deal_room_skipped,
  stage: r.stage,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** One thing the call established, with the words of the call that show it. */
export interface Quoted {
  text: string;
  quote: string;
  /** Where in the call the words were said, when the transcript has timestamps. */
  at: string | null;
}

export interface BriefPerson {
  name: string;
  role: string;
  side: 'prospect' | 'us' | 'unknown';
  quote: string;
  at: string | null;
}

/** The deal brief of design 6.2, after code has checked every quote against the transcript. */
export interface Brief {
  company: Quoted | null;
  people: BriefPerson[];
  problem: Quoted | null;
  outcome: Quoted | null;
  scope: Quoted[];
  constraints: Quoted[];
  timeline: Quoted | null;
  budget: Quoted | null;
  objections: Quoted[];
  nextSteps: Quoted[];
}

export const EMPTY_BRIEF: Brief = {
  company: null,
  people: [],
  problem: null,
  outcome: null,
  scope: [],
  constraints: [],
  timeline: null,
  budget: null,
  objections: [],
  nextSteps: [],
};

/** One line of the Investment section, priced by code from the rate card. */
export interface LineItem {
  key: string;
  name: string;
  unit: string;
  /** Null: the call did not say how many. */
  quantity: number | null;
  /** Null: the rate card has no price for this service. */
  unitPriceCents: number | null;
  /** Null whenever the quantity or the price is not known. */
  totalCents: number | null;
  basis: string;
}

export type ProposalStatus = 'draft' | 'superseded' | 'final' | 'dismissed';

export interface Proposal {
  id: string;
  dealId: string;
  callId: string | null;
  version: number;
  status: ProposalStatus;
  title: string;
  summary: string;
  brief: Brief;
  contentMd: string;
  contentHash: string;
  gaps: string[];
  flags: string[];
  lineItems: LineItem[];
  hasPdf: boolean;
  createdBy: string;
  note: string | null;
  finalizedBy: string | null;
  finalizedAt: Date | null;
  createdAt: Date;
}

export interface ProposalRow {
  id: string;
  deal_id: string;
  call_id: string | null;
  version: number;
  status: ProposalStatus;
  title: string;
  summary: string;
  brief: Partial<Brief>;
  content_md: string;
  content_hash: string;
  gaps: string[];
  flags: string[];
  line_items: LineItem[];
  has_pdf: boolean;
  created_by: string;
  note: string | null;
  finalized_by: string | null;
  finalized_at: Date | null;
  created_at: Date;
}

/** Every column but the PDF bytes, which are read only by the route that serves them. */
export const PROPOSAL_COLUMNS = `id, deal_id, call_id, version, status, title, summary, brief, content_md, content_hash, gaps, flags,
  line_items, (pdf IS NOT NULL) AS has_pdf, created_by, note, finalized_by, finalized_at, created_at`;

export const proposalFromRow = (r: ProposalRow): Proposal => ({
  id: r.id,
  dealId: r.deal_id,
  callId: r.call_id,
  version: r.version,
  status: r.status,
  title: r.title,
  summary: r.summary,
  brief: { ...EMPTY_BRIEF, ...r.brief },
  contentMd: r.content_md,
  contentHash: r.content_hash,
  gaps: r.gaps,
  flags: r.flags,
  lineItems: r.line_items,
  hasPdf: r.has_pdf,
  createdBy: r.created_by,
  note: r.note,
  finalizedBy: r.finalized_by,
  finalizedAt: r.finalized_at,
  createdAt: r.created_at,
});

export type SalesState = 'asked' | 'drafting' | 'drafted' | 'held' | 'failed' | 'declined';
export type SalesStep = 'classify' | 'draft';

export interface SalesCall {
  callId: string;
  state: SalesState;
  detail: string | null;
  holdReason: string | null;
  heldStep: SalesStep | null;
  dealId: string | null;
  version: number;
  decidedBy: string | null;
  note: string | null;
  requestedBy: string | null;
  slackTeam: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  postedAt: Date | null;
  postError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesCallRow {
  call_id: string;
  state: SalesState;
  detail: string | null;
  hold_reason: string | null;
  held_step: SalesStep | null;
  deal_id: string | null;
  version: number;
  decided_by: string | null;
  note: string | null;
  requested_by: string | null;
  slack_team: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: Date | null;
  post_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export const salesCallFromRow = (r: SalesCallRow): SalesCall => ({
  callId: r.call_id,
  state: r.state,
  detail: r.detail,
  holdReason: r.hold_reason,
  heldStep: r.held_step,
  dealId: r.deal_id,
  version: r.version,
  decidedBy: r.decided_by,
  note: r.note,
  requestedBy: r.requested_by,
  slackTeam: r.slack_team,
  slackChannel: r.slack_channel,
  slackTs: r.slack_ts,
  postedAt: r.posted_at,
  postError: r.post_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface CatalogItem {
  id: string;
  key: string;
  name: string;
  description: string;
  unit: string;
  unitPriceCents: number | null;
  active: boolean;
}

export type DealRoomRoute = 'pull_request' | 'api';
/**
 * prepared, pr_open, merged, closed: the pull request route. On the service API route:
 * draft_written (in a draft room, which clients cannot open), held (approved, and waiting in
 * Patcher because the room is live or holds a person's edits), published (the room is live
 * with this content), closed (the room is gone). failed: either route.
 */
export type DealRoomStatus = 'prepared' | 'pr_open' | 'draft_written' | 'held' | 'published' | 'merged' | 'closed' | 'failed';

/** What the deal room said about a room when Patcher last read it. Counts only: no names, no addresses. */
export interface RoomSnapshot {
  status: RoomStatus;
  slug: string;
  members: number;
  invites: number;
  domains: number;
}

/** Why approved files are waiting in Patcher, and what a person is asked to confirm. */
export interface RoomHold {
  /** live: the room is not a draft. edited: a person's text in the room would be replaced or removed. */
  reasons: ('live' | 'edited')[];
  planHash: string;
  replaces: string[];
  removes: string[];
}

export interface DealRoomUpdate {
  id: string;
  dealId: string;
  proposalId: string;
  route: DealRoomRoute;
  repo: string | null;
  slug: string;
  files: { path: string; hash: string }[];
  manualSteps: string[];
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  headSha: string | null;
  status: DealRoomStatus;
  error: string | null;
  recommendationId: string | null;
  /** The service API route: the address, the room, and what the write did or would do. */
  origin: string | null;
  roomId: string | null;
  roomUrl: string | null;
  room: RoomSnapshot | null;
  hold: RoomHold | null;
  changes: RoomChange[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DealRoomUpdateRow {
  id: string;
  deal_id: string;
  proposal_id: string;
  route: DealRoomRoute;
  repo: string | null;
  slug: string;
  files: { path: string; hash: string }[];
  manual_steps: string[];
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  head_sha: string | null;
  status: DealRoomStatus;
  error: string | null;
  recommendation_id: string | null;
  origin: string | null;
  room_id: string | null;
  room_url: string | null;
  room: RoomSnapshot | null;
  hold: RoomHold | null;
  changes: RoomChange[] | null;
  created_at: Date;
  updated_at: Date;
}

export const updateFromRow = (r: DealRoomUpdateRow): DealRoomUpdate => ({
  id: r.id,
  dealId: r.deal_id,
  proposalId: r.proposal_id,
  route: r.route,
  repo: r.repo,
  slug: r.slug,
  files: r.files,
  manualSteps: r.manual_steps,
  branch: r.branch,
  prUrl: r.pr_url,
  prNumber: r.pr_number,
  headSha: r.head_sha,
  status: r.status,
  error: r.error,
  recommendationId: r.recommendation_id,
  origin: r.origin,
  roomId: r.room_id,
  roomUrl: r.room_url,
  room: r.room,
  hold: r.hold,
  changes: r.changes ?? [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A deal's slug in the deal room: the app's URL segment and its content folder. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
