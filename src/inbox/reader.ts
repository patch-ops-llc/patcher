import { WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError, WebAPIRequestError, WebClient } from '@slack/web-api';
import { SlackApiError } from '../slack/client.js';
import type { ChannelType } from './types.js';

/**
 * Reading the PatchOps workspace as its owner (design 8.1 and 12.1). The owner authorises
 * the hub app once with user scopes; Slack then sends the app the messages he can see, and
 * this client uses his token for the few things events do not carry: names, the earlier
 * messages of a thread, and history after a gap. Every scope is a read scope. Nothing here
 * can post, edit or delete.
 */
export const READER_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'team:read',
] as const;

const HISTORY_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history'];

/** A message as Slack's Events API and `conversations.history` both give it. */
export interface RawSlackMessage {
  ts?: unknown;
  thread_ts?: unknown;
  user?: unknown;
  text?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
  reply_count?: unknown;
  latest_reply?: unknown;
}

export interface ReaderChannel {
  id: string;
  name: string | null;
  type: ChannelType;
}

export interface ReaderIdentity {
  teamId: string;
  userId: string;
  teamName: string | null;
  /** "patchops" in patchops.slack.com. */
  domain: string | null;
}

/** What the worker does in Slack with the reader's token. Tests substitute a recorder. */
export interface SlackReader {
  identity(): Promise<ReaderIdentity>;
  conversations(cursor: string | null, limit: number): Promise<{ channels: ReaderChannel[]; next: string | null }>;
  history(channelId: string, input: { oldest: string; cursor: string | null }): Promise<{ messages: RawSlackMessage[]; next: string | null }>;
  /** A thread's messages, oldest first, the first one included. */
  replies(channelId: string, threadTs: string, limit: number): Promise<RawSlackMessage[]>;
  userName(userId: string): Promise<string | null>;
  channel(channelId: string): Promise<ReaderChannel | null>;
  revoke(): Promise<void>;
}

export type SlackReaderFactory = (token: string) => SlackReader;

/** Codes that mean the token is gone for good: the owner has to connect again. */
export const TOKEN_GONE = new Set(['token_revoked', 'invalid_auth', 'account_inactive', 'token_expired', 'not_authed']);
export const tokenGone = (err: unknown): err is SlackApiError => err instanceof SlackApiError && TOKEN_GONE.has(err.code);

function toError(method: string, err: unknown): SlackApiError {
  if (err instanceof SlackApiError) return err;
  if (err instanceof WebAPIPlatformError) return new SlackApiError(method, err.data.error, { cause: err });
  if (err instanceof WebAPIRateLimitedError) return new SlackApiError(method, 'rate_limited', { retryAfterSeconds: err.retryAfter, cause: err });
  if (err instanceof WebAPIHTTPError) return new SlackApiError(method, `http_${err.statusCode}`, { cause: err });
  if (err instanceof WebAPIRequestError) return new SlackApiError(method, 'request_failed', { cause: err });
  return new SlackApiError(method, 'unknown_error', { cause: err });
}

const channelType = (c: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean }): ChannelType =>
  c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private || c.is_group ? 'group' : 'channel';

export function createSlackReader(options: { token: string; apiUrl?: string | undefined; timeoutMs?: number }): SlackReader {
  const web = new WebClient(options.token, {
    ...(options.apiUrl ? { slackApiUrl: options.apiUrl } : {}),
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: options.timeoutMs ?? 10_000,
  });
  const call = async <T>(method: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toError(method, err);
    }
  };

  return {
    identity: () =>
      call('auth.test', async () => {
        const res = await web.auth.test();
        if (!res.team_id || !res.user_id) throw new SlackApiError('auth.test', 'no_identity_returned');
        const host = res.url ? new URL(res.url).hostname : '';
        const domain = /^([a-z0-9-]+)\.slack\.com$/.exec(host)?.[1] ?? null;
        return { teamId: res.team_id, userId: res.user_id, teamName: res.team ?? null, domain };
      }),

    conversations: (cursor, limit) =>
      call('users.conversations', async () => {
        const res = await web.users.conversations({
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: true,
          limit,
          ...(cursor ? { cursor } : {}),
        });
        const channels = (res.channels ?? []).flatMap((c) => (c.id ? [{ id: c.id, name: c.name ?? null, type: channelType(c) }] : []));
        return { channels, next: res.response_metadata?.next_cursor || null };
      }),

    history: (channelId, input) =>
      call('conversations.history', async () => {
        const res = await web.conversations.history({
          channel: channelId,
          oldest: input.oldest,
          limit: 200,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        return { messages: (res.messages ?? []), next: res.response_metadata?.next_cursor || null };
      }),

    replies: (channelId, threadTs, limit) =>
      call('conversations.replies', async () => {
        const res = await web.conversations.replies({ channel: channelId, ts: threadTs, limit });
        return (res.messages ?? []);
      }),

    userName: (userId) =>
      call('users.info', async () => {
        const res = await web.users.info({ user: userId });
        return res.user?.profile?.display_name || res.user?.real_name || res.user?.name || null;
      }),

    channel: (channelId) =>
      call('conversations.info', async () => {
        const res = await web.conversations.info({ channel: channelId });
        const c = res.channel;
        return c?.id ? { id: c.id, name: c.name ?? null, type: channelType(c) } : null;
      }),

    revoke: () =>
      call('auth.revoke', async () => {
        await web.auth.revoke();
      }),
  };
}

// Authorising the reader (public service) ---------------------------------------------------------

export interface ReaderGrant {
  teamId: string;
  teamName: string | null;
  userId: string;
  scopes: string[];
  token: string;
}

export interface SlackReaderOAuth {
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  /** Exchanges the code for the user's token. Throws `ReaderOAuthError` when Slack refuses. */
  exchange(input: { code: string; redirectUri: string }): Promise<ReaderGrant>;
  /** Gives back a token that will not be kept: it came for the wrong workspace or person. Never throws. */
  revoke(token: string): Promise<void>;
}

export class ReaderOAuthError extends Error {}

export const missingHistoryScopes = (scopes: string[]): string[] => HISTORY_SCOPES.filter((s) => !scopes.includes(s));

export function createSlackReaderOAuth(options: { clientId: string; clientSecret: string; teamId: string; baseUrl?: string | undefined }): SlackReaderOAuth {
  const base = (options.baseUrl ?? 'https://slack.com').replace(/\/+$/, '');
  return {
    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`${base}/oauth/v2/authorize`);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        user_scope: READER_SCOPES.join(','),
        redirect_uri: redirectUri,
        state,
        // A hint only. The workspace is checked on what Slack returns.
        team: options.teamId,
      }).toString();
      return url.toString();
    },

    async exchange({ code, redirectUri }) {
      let body: {
        ok?: boolean;
        error?: string;
        team?: { id?: string; name?: string };
        authed_user?: { id?: string; scope?: string; access_token?: string; token_type?: string };
      };
      try {
        const res = await fetch(`${base}/api/oauth.v2.access`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, code, redirect_uri: redirectUri }),
          signal: AbortSignal.timeout(10_000),
        });
        body = (await res.json()) as typeof body;
      } catch (err) {
        throw new ReaderOAuthError('Could not reach Slack to finish connecting', { cause: err });
      }
      const user = body.authed_user;
      if (!body.ok) throw new ReaderOAuthError(`Slack refused the code: ${body.error ?? 'unknown'}`);
      if (!body.team?.id || !user?.id || !user.access_token || user.token_type !== 'user') {
        throw new ReaderOAuthError('Slack did not return a user token');
      }
      return {
        teamId: body.team.id,
        teamName: body.team.name ?? null,
        userId: user.id,
        scopes: (user.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        token: user.access_token,
      };
    },

    async revoke(token) {
      try {
        await fetch(`${base}/api/auth.revoke`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Nothing more can be done from here; the owner can remove the authorisation in Slack.
      }
    },
  };
}
