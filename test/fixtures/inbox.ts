import type { Pool } from '../../src/db/pool.js';
import type { RawSlackMessage, ReaderChannel, ReaderGrant, ReaderIdentity, SlackReader, SlackReaderOAuth } from '../../src/inbox/reader.js';
import { READER_SCOPES, ReaderOAuthError } from '../../src/inbox/reader.js';
import type { CapturedMessage } from '../../src/inbox/capture.js';
import { SlackApiError } from '../../src/slack/client.js';
import { HUB, OWNER } from '../helpers.js';
import { testSecrets } from './calls.js';

/**
 * A made-up Slack for the reader tests: one hub workspace, two client workspaces, and
 * people who do not exist. Nothing here was copied from a real workspace or a real mail.
 */
export const DANA = 'U0DANA';
export const SAM = 'U0SAM';
export const PORTAL_CHANNEL = 'C0PORTAL';
export const GENERAL_CHANNEL = 'C0GENERAL';
export const DM_CHANNEL = 'D0DANA';
export const READER_TOKEN = 'xoxp-made-up-reader-token';
export const MAIL_SECRET = 'made-up-mail-password';

export const ASK = 'Can you confirm the invoice export goes live on Friday?';
export const OUTAGE = 'The portal login has been down since nine and customers are calling us.';
export const CHANGE = 'Please rename the Export button on the reports page to Download CSV.';

/** Stands in for Slack as the reader sees it. It records every call and never reaches a network. */
export class FakeReader implements SlackReader {
  calls: { method: string; args: unknown[] }[] = [];
  who: ReaderIdentity = { teamId: HUB, userId: OWNER, teamName: 'PatchOps', domain: 'patchops' };
  channels: ReaderChannel[] = [];
  /** Newest first, as Slack returns history. */
  messages = new Map<string, RawSlackMessage[]>();
  threads = new Map<string, RawSlackMessage[]>();
  names = new Map<string, string>([
    [DANA, 'Dana Reyes'],
    [SAM, 'Sam Okafor'],
  ]);
  channelNames = new Map<string, string>([
    [PORTAL_CHANNEL, 'project-portal'],
    [GENERAL_CHANNEL, 'general'],
  ]);
  revoked = false;
  failNext: SlackApiError | undefined;

  fail(code: string, retryAfterSeconds?: number): void {
    this.failNext = new SlackApiError('test', code, retryAfterSeconds === undefined ? undefined : { retryAfterSeconds });
  }

  private record(method: string, ...args: unknown[]): void {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.calls.push({ method, args });
  }

  of(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  async identity(): Promise<ReaderIdentity> {
    await Promise.resolve();
    this.record('identity');
    return this.who;
  }
  async conversations(cursor: string | null): Promise<{ channels: ReaderChannel[]; next: string | null }> {
    await Promise.resolve();
    this.record('conversations', cursor);
    return { channels: this.channels, next: null };
  }
  async history(channelId: string, input: { oldest: string; cursor: string | null }): Promise<{ messages: RawSlackMessage[]; next: string | null }> {
    await Promise.resolve();
    this.record('history', channelId, input);
    return { messages: (this.messages.get(channelId) ?? []).filter((m) => String(m.ts) > input.oldest), next: null };
  }
  async replies(channelId: string, threadTs: string): Promise<RawSlackMessage[]> {
    await Promise.resolve();
    this.record('replies', channelId, threadTs);
    return this.threads.get(`${channelId}:${threadTs}`) ?? [];
  }
  async userName(userId: string): Promise<string | null> {
    await Promise.resolve();
    this.record('userName', userId);
    return this.names.get(userId) ?? null;
  }
  async channel(channelId: string): Promise<ReaderChannel | null> {
    await Promise.resolve();
    this.record('channel', channelId);
    const name = this.channelNames.get(channelId);
    return name ? { id: channelId, name, type: 'channel' } : null;
  }
  async revoke(): Promise<void> {
    await Promise.resolve();
    this.record('revoke');
    this.revoked = true;
  }
}

/** Stands in for Slack's OAuth: returns whatever grant the test sets and remembers what was given back. */
export class StubReaderOAuth implements SlackReaderOAuth {
  grant: ReaderGrant | null = { teamId: HUB, teamName: 'PatchOps', userId: OWNER, scopes: [...READER_SCOPES], token: READER_TOKEN };
  lastState = '';
  revoked: string[] = [];

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    this.lastState = input.state;
    return `https://slack.test/oauth/v2/authorize?state=${input.state}`;
  }
  exchange(): Promise<ReaderGrant> {
    return this.grant ? Promise.resolve(this.grant) : Promise.reject(new ReaderOAuthError('refused'));
  }
  revoke(token: string): Promise<void> {
    this.revoked.push(token);
    return Promise.resolve();
  }
}

/** The hub workspace, connected for reading, with a token only the test worker can open. */
export async function connectHub(pool: Pool, overrides: { enabled?: boolean; status?: string; channelDefault?: string; readDms?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO slack_workspaces (team_id, domain, name, enabled, read_mode, read_dms, channel_default, reader_user_id, user_token_ct, status)
     VALUES ($1, 'patchops', 'PatchOps', $2, 'api', $3, $4, $5, $6, $7) RETURNING id`,
    [HUB, overrides.enabled ?? true, overrides.readDms ?? true, overrides.channelDefault ?? 'include', OWNER, testSecrets().seal(READER_TOKEN), overrides.status ?? 'connected'],
  );
  return rows[0]!.id;
}

/** A client workspace known only from forwarded mail. */
export async function mailWorkspace(pool: Pool, domain: string, name: string, enabled = true): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO slack_workspaces (domain, name, enabled, read_mode, status) VALUES ($1, $2, $3, 'email_only', 'new') RETURNING id`,
    [domain, name, enabled],
  );
  return rows[0]!.id;
}

let clock = 1_800_000_000;
/** A Slack timestamp later than every one given before. */
export const nextTs = (): string => `${++clock}.000100`;
/** A Slack timestamp for "now", so that stored times are recent. */
export const nowTs = (offsetSeconds = 0): string => `${Math.floor(Date.now() / 1000) + offsetSeconds}.${String(++clock % 1_000_000).padStart(6, '0')}`;

/** The body of a `message` event as Slack delivers it for the reader's authorisation. */
export function messageEvent(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}): Record<string, unknown> {
  const ts = (overrides.ts as string | undefined) ?? nowTs();
  return {
    type: 'event_callback',
    team_id: HUB,
    event_id: `Ev${ts.replace('.', '')}`,
    authorizations: [{ team_id: HUB, user_id: OWNER, is_bot: false }],
    event: { type: 'message', channel: PORTAL_CHANNEL, channel_type: 'channel', user: DANA, text: ASK, ts, ...overrides },
    ...envelope,
  };
}

/** A captured message, as any capture source hands it to the pipeline. */
export function captured(workspaceId: string, overrides: Partial<CapturedMessage> = {}): CapturedMessage {
  const ts = overrides.ts === undefined ? nowTs() : overrides.ts;
  return {
    workspaceId,
    source: 'api',
    channelId: PORTAL_CHANNEL,
    channelName: null,
    channelType: 'channel',
    ts,
    threadTs: null,
    senderId: DANA,
    senderName: null,
    text: ASK,
    link: `https://patchops.slack.com/archives/${PORTAL_CHANNEL}/p${(ts ?? '0.0').replace('.', '')}`,
    own: false,
    mentionsReader: false,
    origin: 'person',
    sentAt: new Date(),
    ...overrides,
  };
}

/**
 * A notification mail as the inbound mail service posts it. Slack does not publish the
 * layout of its notification mail, so this is an invented one that has the two things the
 * parser relies on: a workspace address and a link to the message.
 */
export function notificationMail(token: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MessageID: `mail-${++clock}`,
    From: 'Slack <notification@slack.com>',
    FromFull: { Email: 'notification@slack.com', Name: 'Slack' },
    To: `inbox+${token}@inbound.example.com`,
    OriginalRecipient: `inbox+${token}@inbound.example.com`,
    MailboxHash: token,
    Subject: '[Slack] New message from Dana Reyes in #project-portal',
    Date: new Date().toUTCString(),
    TextBody: [
      'Dana Reyes',
      ASK,
      '',
      'View in Slack: https://acme-co.slack.com/x-p123-456-abcdef/archives/C0ACMEPORTAL/p1800000000000200?thread_ts=1800000000.000100&cid=C0ACMEPORTAL',
      '',
      "You're receiving this email because you have notifications turned on.",
      'Unsubscribe: https://acme-co.slack.com/x-p123-456-abcdef/account/notifications',
    ].join('\n'),
    HtmlBody: '',
    ...overrides,
  };
}

export const triageAnswer = (overrides: Record<string, unknown> = {}) => ({
  label: 'reply',
  urgency: 'today',
  addressed: false,
  project: 'P1',
  quote: ASK,
  reason: 'A question about a release date is waiting for an answer.',
  ...overrides,
});

export const recommendAnswer = (overrides: Record<string, unknown> = {}) => ({
  summary: 'Dana asks whether the invoice export goes live on Friday',
  action: 'reply',
  task_title: 'Confirm the invoice export release date',
  draft_reply: 'Yes, the invoice export is on track for Friday. I will confirm once it is live.',
  quote: ASK,
  ...overrides,
});
