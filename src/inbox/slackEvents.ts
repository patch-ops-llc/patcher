import type { CaptureDeps, CaptureOutcome, CapturedMessage, MessageRef } from './capture.js';
import { applyDelete, applyEdit, permalink, receiveCaptured, slackTime, touchEvents } from './capture.js';
import type { RawSlackMessage, ReaderChannel } from './reader.js';
import { countDrop, workspaceByTeam } from './store.js';
import type { ChannelType, Workspace } from './types.js';

const TS = /^\d{9,11}\.\d{1,6}$/;
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const ts = (value: unknown): string | null => (typeof value === 'string' && TS.test(value) ? value : null);

/** Subtypes that are still a person saying something. Every other subtype is a system line or a bot. */
const SPOKEN = new Set(['file_share', 'thread_broadcast', 'me_message']);
const BOT = new Set(['bot_message', 'bot_add', 'bot_remove']);

export type FromSlack =
  | { kind: 'message'; message: CapturedMessage }
  | { kind: 'edit'; ref: MessageRef; text: string }
  | { kind: 'delete'; ref: MessageRef }
  | { kind: 'ignore' };

type WorkspaceRef = Pick<Workspace, 'id' | 'teamId' | 'domain' | 'readerUserId'>;

/**
 * Turns a message as Slack gives it, in an event or in channel history, into the one shape
 * the pipeline takes. Nothing is decided here beyond what kind of thing it is; the filter
 * in `receiveCaptured` decides whether it is read.
 */
export function fromSlackMessage(workspace: WorkspaceRef, channel: ReaderChannel, raw: RawSlackMessage & { message?: unknown; previous_message?: unknown; deleted_ts?: unknown }): FromSlack {
  const subtype = str(raw.subtype);
  if (subtype === 'message_deleted') {
    const deleted = ts(raw.deleted_ts) ?? ts((raw.previous_message as RawSlackMessage | undefined)?.ts);
    return deleted ? { kind: 'delete', ref: { workspaceId: workspace.id, channelId: channel.id, ts: deleted } } : { kind: 'ignore' };
  }
  if (subtype === 'message_changed') {
    const inner = raw.message as RawSlackMessage | undefined;
    const edited = ts(inner?.ts);
    // A thread's first message is "changed" whenever a reply is added; only a change of text matters.
    const before = str((raw.previous_message as RawSlackMessage | undefined)?.text);
    const text = str(inner?.text);
    if (!edited || text === null || text === before) return { kind: 'ignore' };
    if (str(inner?.subtype) === 'tombstone') return { kind: 'delete', ref: { workspaceId: workspace.id, channelId: channel.id, ts: edited } };
    return { kind: 'edit', ref: { workspaceId: workspace.id, channelId: channel.id, ts: edited }, text };
  }
  const at = ts(raw.ts);
  if (!at) return { kind: 'ignore' };
  const sender = str(raw.user);
  const text = str(raw.text) ?? '';
  const origin = subtype && BOT.has(subtype) ? 'bot' : str(raw.bot_id) ? 'bot' : subtype && !SPOKEN.has(subtype) ? 'system' : sender ? 'person' : 'system';
  const threadTs = ts(raw.thread_ts);
  const own = origin === 'person' && sender === workspace.readerUserId;
  return {
    kind: 'message',
    message: {
      workspaceId: workspace.id,
      source: 'api',
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      ts: at,
      threadTs,
      senderId: sender,
      senderName: null,
      text: text.slice(0, 100_000),
      link: permalink({ domain: workspace.domain, teamId: workspace.teamId, channelId: channel.id, ts: at, threadTs }),
      own,
      mentionsReader: !own && workspace.readerUserId !== null && text.includes(`<@${workspace.readerUserId}>`),
      origin,
      sentAt: slackTime(at),
    },
  };
}

const CHANNEL_TYPES: Record<string, ChannelType> = { channel: 'channel', group: 'group', im: 'im', mpim: 'mpim' };

export type EventOutcome = CaptureOutcome | 'no_workspace' | 'edited' | 'deleted' | 'ignored';

/**
 * A `message` event from the hub app (design 8.6, "Receive"). It runs in the public service,
 * inside the three seconds Slack allows, and stores the message only if the filter lets it
 * through. The event itself is not stored. A retry from Slack is a no-op because a message
 * is unique by its channel and timestamp, and an edit or a deletion can be applied twice.
 */
export async function receiveSlackMessageEvent(deps: CaptureDeps, input: { teamId: string; body: Record<string, unknown> }): Promise<EventOutcome> {
  const event = input.body.event as (RawSlackMessage & Record<string, unknown>) | undefined;
  const channelId = str(event?.channel);
  if (!event || !channelId) return 'ignored';
  const workspace = await workspaceByTeam(deps.pool, input.teamId);
  if (!workspace || workspace.readMode !== 'api') return 'no_workspace';

  // Slack names the installation an event is visible to. Anything not delivered for the
  // connected reader is left alone, so a second person's grant can never widen what is read.
  const authorizations = Array.isArray(input.body.authorizations) ? (input.body.authorizations as Record<string, unknown>[]) : [];
  const forReader = workspace.readerUserId !== null && authorizations.some((a) => a.user_id === workspace.readerUserId && a.is_bot !== true);
  if (!forReader) {
    await countDrop(deps.pool, workspace.id, 'not_reader');
    return 'not_reader';
  }
  await touchEvents(deps.pool, workspace.id);

  const channel: ReaderChannel = { id: channelId, name: null, type: CHANNEL_TYPES[str(event.channel_type) ?? ''] ?? 'unknown' };
  const converted = fromSlackMessage(workspace, channel, event);
  switch (converted.kind) {
    case 'message':
      return receiveCaptured(deps, converted.message);
    case 'edit':
      return (await applyEdit(deps, converted.ref, converted.text)) ? 'edited' : 'ignored';
    case 'delete':
      return (await applyDelete(deps, converted.ref)) ? 'deleted' : 'ignored';
    default:
      return 'ignored';
  }
}
