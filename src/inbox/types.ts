/**
 * The Slack reader (design section 8). Where a message came from is recorded on it and
 * nowhere else matters: after capture, a message from the hub app's events, from forwarded
 * mail or from the browser companion goes through the same steps.
 */
export const SOURCES = ['api', 'companion_page', 'companion_notification', 'email'] as const;
export type Source = (typeof SOURCES)[number];

export const READ_MODES = ['api', 'companion', 'email_only', 'connect'] as const;
export type ReadMode = (typeof READ_MODES)[number];

/** What the companion sends for a workspace: direct messages and mentions only, or every message it receives. */
export const CAPTURE_LEVELS = ['notifications', 'page'] as const;
export type CaptureLevel = (typeof CAPTURE_LEVELS)[number];

export const CHANNEL_TYPES = ['channel', 'group', 'im', 'mpim', 'unknown'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const RULES = ['include', 'exclude', 'digest_only', 'urgent'] as const;
export type Rule = (typeof RULES)[number];

export const RULE_LABEL: Record<Rule, string> = {
  include: 'Read',
  exclude: 'Leave out',
  digest_only: 'Digest only',
  urgent: 'Always urgent',
};

export const INBOX_CARRIER = 'slack_item';
export const INBOX_SOURCE = 'slack_bundle';

/** Why the code filter left a message out. Counted per workspace and day; nothing else is kept. */
export const DROP_REASONS = {
  off: 'The Slack reader is switched off',
  workspace_off: 'The workspace is switched off',
  disconnected: 'The workspace is disconnected',
  not_reader: 'The event was not delivered for the connected reader',
  system: 'A join, leave, topic or other system message',
  bot: 'Posted by a bot or an integration',
  patcher_channel: "One of Patcher's own channels",
  excluded: 'The channel is left out by a rule',
  not_included: 'The channel has no rule, and channels without one are left out',
  dm_off: 'Direct messages are not read for this workspace',
  empty: 'No text (a file or an image only)',
  duplicate: 'Already captured',
  covered_by_api: 'Mail about a workspace that is read through the app',
  companion_off: 'Sent by the browser companion for a workspace it is not switched on for',
  above_level: 'Sent by the browser companion, but neither a direct message nor a mention, in a workspace set to those only',
} as const;
export type DropReason = keyof typeof DROP_REASONS;

export const LABELS = ['none', 'fyi', 'reply', 'task', 'escalate'] as const;
export type Label = (typeof LABELS)[number];
export const URGENCIES = ['now', 'today', 'later'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const DISMISS_REASONS = {
  not_relevant: 'Not relevant',
  already_handled: 'Already handled',
  wrong_channel: 'Wrong channel',
} as const;
export type DismissReason = keyof typeof DISMISS_REASONS;
export const isDismissReason = (value: unknown): value is DismissReason => typeof value === 'string' && Object.hasOwn(DISMISS_REASONS, value);

export interface Workspace {
  id: string;
  teamId: string | null;
  domain: string | null;
  name: string;
  enabled: boolean;
  readMode: ReadMode;
  /** Whether the browser companion may capture this workspace, and how much of it. */
  companionEnabled: boolean;
  captureLevel: CaptureLevel;
  readDms: boolean;
  channelDefault: 'include' | 'exclude';
  projectId: string | null;
  readerUserId: string | null;
  hasToken: boolean;
  status: 'new' | 'connected' | 'disconnected';
  statusDetail: string | null;
  lastMessageAt: Date | null;
  lastEventAt: Date | null;
}

export interface WorkspaceRow {
  id: string;
  team_id: string | null;
  domain: string | null;
  name: string;
  enabled: boolean;
  read_mode: ReadMode;
  companion_enabled: boolean;
  capture_level: CaptureLevel;
  read_dms: boolean;
  channel_default: 'include' | 'exclude';
  project_id: string | null;
  reader_user_id: string | null;
  user_token_ct: string | null;
  status: Workspace['status'];
  status_detail: string | null;
  last_message_at: Date | null;
  last_event_at: Date | null;
}

export const workspaceFromRow = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  teamId: r.team_id,
  domain: r.domain,
  name: r.name,
  enabled: r.enabled,
  readMode: r.read_mode,
  companionEnabled: r.companion_enabled,
  captureLevel: r.capture_level,
  readDms: r.read_dms,
  channelDefault: r.channel_default,
  projectId: r.project_id,
  readerUserId: r.reader_user_id,
  hasToken: r.user_token_ct !== null,
  status: r.status,
  statusDetail: r.status_detail,
  lastMessageAt: r.last_message_at,
  lastEventAt: r.last_event_at,
});

export interface ChannelRule {
  id: string;
  workspaceId: string;
  channelId: string | null;
  channelName: string | null;
  rule: Rule;
  projectId: string | null;
}

export interface ChannelRuleRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  channel_name: string | null;
  rule: Rule;
  project_id: string | null;
}

export const ruleFromRow = (r: ChannelRuleRow): ChannelRule => ({
  id: r.id,
  workspaceId: r.workspace_id,
  channelId: r.channel_id,
  channelName: r.channel_name,
  rule: r.rule,
  projectId: r.project_id,
});

export type BundleStatus = 'open' | 'reading' | 'held' | 'dropped' | 'fyi' | 'recommended' | 'unanalysed' | 'handled' | 'failed';

/** What the triage step said, after the checks. Stored on the bundle; the message text is not. */
export interface TriageResult {
  label: Label;
  urgency: Urgency;
  addressed: boolean;
  /** One short line from the model on why, shown in the triage log. */
  reason: string;
  /** Whether the words the model quoted are in the messages. */
  grounded: boolean;
}

export interface Bundle {
  id: string;
  workspaceId: string;
  channelKey: string;
  channelId: string | null;
  channelName: string | null;
  channelType: ChannelType;
  threadTs: string | null;
  source: Source;
  status: BundleStatus;
  statusDetail: string | null;
  holdReason: string | null;
  heldStep: 'triage' | 'recommend' | null;
  openedAt: Date;
  settleAt: Date;
  firstAt: Date | null;
  lastAt: Date | null;
  messageCount: number;
  addressed: boolean;
  triage: TriageResult | null;
  senderName: string | null;
  summary: string | null;
  suggestion: string | null;
  draft: string | null;
  quote: string | null;
  link: string | null;
  projectId: string | null;
  urgent: boolean;
  delivery: 'now' | 'digest' | null;
  recommendationId: string | null;
  digestId: string | null;
  digestPosition: number | null;
  slackTeam: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  postedAt: Date | null;
  postError: string | null;
  createdAt: Date;
}

export interface BundleRow {
  id: string;
  workspace_id: string;
  channel_key: string;
  channel_id: string | null;
  channel_name: string | null;
  channel_type: ChannelType;
  thread_ts: string | null;
  source: Source;
  status: BundleStatus;
  status_detail: string | null;
  hold_reason: string | null;
  held_step: 'triage' | 'recommend' | null;
  opened_at: Date;
  settle_at: Date;
  first_at: Date | null;
  last_at: Date | null;
  message_count: number;
  addressed: boolean;
  triage: TriageResult | null;
  sender_name: string | null;
  summary: string | null;
  suggestion: string | null;
  draft: string | null;
  quote: string | null;
  link: string | null;
  project_id: string | null;
  urgent: boolean;
  delivery: 'now' | 'digest' | null;
  recommendation_id: string | null;
  digest_id: string | null;
  digest_position: number | null;
  slack_team: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: Date | null;
  post_error: string | null;
  created_at: Date;
}

export const bundleFromRow = (r: BundleRow): Bundle => ({
  id: r.id,
  workspaceId: r.workspace_id,
  channelKey: r.channel_key,
  channelId: r.channel_id,
  channelName: r.channel_name,
  channelType: r.channel_type,
  threadTs: r.thread_ts,
  source: r.source,
  status: r.status,
  statusDetail: r.status_detail,
  holdReason: r.hold_reason,
  heldStep: r.held_step,
  openedAt: r.opened_at,
  settleAt: r.settle_at,
  firstAt: r.first_at,
  lastAt: r.last_at,
  messageCount: r.message_count,
  addressed: r.addressed,
  triage: r.triage,
  senderName: r.sender_name,
  summary: r.summary,
  suggestion: r.suggestion,
  draft: r.draft,
  quote: r.quote,
  link: r.link,
  projectId: r.project_id,
  urgent: r.urgent,
  delivery: r.delivery,
  recommendationId: r.recommendation_id,
  digestId: r.digest_id,
  digestPosition: r.digest_position,
  slackTeam: r.slack_team,
  slackChannel: r.slack_channel,
  slackTs: r.slack_ts,
  postedAt: r.posted_at,
  postError: r.post_error,
  createdAt: r.created_at,
});

/** A stored message as the pipeline reads it. `text` is null once retention has removed it. */
export interface StoredMessage {
  id: string;
  ts: string | null;
  threadTs: string | null;
  senderId: string | null;
  senderName: string | null;
  text: string | null;
  link: string | null;
  mentionsReader: boolean;
  sentAt: Date;
}

export interface Digest {
  id: string;
  trigger: string;
  stats: { workspaces: number; messages: number; items: number };
  slackTeam: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  postedAt: Date | null;
  postError: string | null;
  createdAt: Date;
}

export interface DigestRow {
  id: string;
  trigger: string;
  stats: Partial<Digest['stats']>;
  slack_team: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  posted_at: Date | null;
  post_error: string | null;
  created_at: Date;
}

export const digestFromRow = (r: DigestRow): Digest => ({
  id: r.id,
  trigger: r.trigger,
  stats: { workspaces: r.stats.workspaces ?? 0, messages: r.stats.messages ?? 0, items: r.stats.items ?? 0 },
  slackTeam: r.slack_team,
  slackChannel: r.slack_channel,
  slackTs: r.slack_ts,
  postedAt: r.posted_at,
  postError: r.post_error,
  createdAt: r.created_at,
});

/** "#project-portal", "a direct message" or "a group message": how a conversation is named to a person. */
export function channelLabel(bundle: Pick<Bundle, 'channelType' | 'channelName' | 'channelId'>): string {
  if (bundle.channelType === 'im') return 'DM';
  if (bundle.channelType === 'mpim') return 'group DM';
  if (bundle.channelName) return `#${bundle.channelName.replace(/^#/, '')}`;
  return bundle.channelId ?? 'a conversation';
}
