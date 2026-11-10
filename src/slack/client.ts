import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from '@slack/web-api';
import type { SlackChannel } from '../settings/routes.js';

/** A Block Kit payload. Built only in `messages.ts`; opaque everywhere else. */
export type SlackBlock = Record<string, unknown>;
export type SlackView = Record<string, unknown>;

export interface SlackMessage {
  /** Plain-text fallback, used for notifications and by clients that cannot show blocks. */
  text: string;
  blocks?: SlackBlock[];
}

/**
 * Everything the bot does in Slack. The worker holds the full client; the public service
 * uses `openView` only, because a modal must open within three seconds of the click.
 */
export interface SlackClient {
  postMessage(input: SlackMessage & { channel: string; threadTs?: string }): Promise<{ ts: string }>;
  updateMessage(input: SlackMessage & { channel: string; ts: string }): Promise<void>;
  openView(input: { triggerId: string; view: SlackView }): Promise<void>;
  publishHome(input: { userId: string; view: SlackView }): Promise<void>;
  listChannels(): Promise<SlackChannel[]>;
  /** Replies privately to whoever clicked, through the response URL Slack sent with the click. */
  respond(responseUrl: string, text: string): Promise<void>;
}

// Errors that will not go away on a retry: the fix is a setting, an invite or a credential.
const PERMANENT = new Set([
  'not_in_channel',
  'channel_not_found',
  'is_archived',
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'missing_scope',
  'no_permission',
  'restricted_action',
  'message_not_found',
  'cant_update_message',
  'edit_window_closed',
  'expired_trigger_id',
  'invalid_trigger_id',
  'invalid_blocks',
  'invalid_arguments',
  'not_configured',
]);

export class SlackApiError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly method: string,
    readonly code: string,
    options?: { retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(`Slack ${method} failed: ${code}`, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'SlackApiError';
    this.retryable = !PERMANENT.has(code);
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
  readonly retryAfterSeconds: number | undefined;
}

function toSlackApiError(method: string, err: unknown): SlackApiError {
  if (err instanceof SlackApiError) return err;
  if (err instanceof WebAPIPlatformError) return new SlackApiError(method, err.data.error, { cause: err });
  if (err instanceof WebAPIRateLimitedError) {
    return new SlackApiError(method, 'rate_limited', { retryAfterSeconds: err.retryAfter, cause: err });
  }
  if (err instanceof WebAPIHTTPError) return new SlackApiError(method, `http_${err.statusCode}`, { cause: err });
  if (err instanceof WebAPIRequestError) return new SlackApiError(method, 'request_failed', { cause: err });
  return new SlackApiError(method, 'unknown_error', { cause: err });
}

export interface SlackClientOptions {
  token: string;
  /** Development and test only. */
  apiUrl?: string | undefined;
  timeoutMs?: number;
}

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const web = new WebClient(options.token, {
    ...(options.apiUrl ? { slackApiUrl: options.apiUrl } : {}),
    // The job queue owns retries and backoff, so the client reports failure straight away.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: options.timeoutMs ?? 10_000,
  });

  const call = async <T>(method: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toSlackApiError(method, err);
    }
  };

  // Response URLs are issued by Slack; refuse anything else so a job payload cannot aim the
  // worker at another host. The override host is allowed only when one is configured.
  const allowedResponseHosts = new Set(['hooks.slack.com']);
  if (options.apiUrl) allowedResponseHosts.add(new URL(options.apiUrl).host);

  return {
    postMessage: (input) =>
      call('chat.postMessage', async () => {
        const res = await web.chat.postMessage({
          channel: input.channel,
          text: input.text,
          ...(input.blocks ? { blocks: input.blocks as never } : {}),
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!res.ts) throw new SlackApiError('chat.postMessage', 'no_ts_returned');
        return { ts: res.ts };
      }),

    updateMessage: (input) =>
      call('chat.update', async () => {
        await web.chat.update({
          channel: input.channel,
          ts: input.ts,
          text: input.text,
          blocks: (input.blocks ?? []) as never,
        });
      }),

    openView: (input) =>
      call('views.open', async () => {
        await web.views.open({ trigger_id: input.triggerId, view: input.view as never });
      }),

    publishHome: (input) =>
      call('views.publish', async () => {
        await web.views.publish({ user_id: input.userId, view: input.view as never });
      }),

    listChannels: () =>
      call('conversations.list', async () => {
        const out: SlackChannel[] = [];
        let cursor: string | undefined;
        do {
          const res = await web.conversations.list({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          for (const c of res.channels ?? []) {
            if (!c.id || !c.name) continue;
            out.push({
              channelId: c.id,
              name: c.name,
              isPrivate: Boolean(c.is_private),
              isMember: Boolean(c.is_member),
            });
          }
          cursor = res.response_metadata?.next_cursor || undefined;
        } while (cursor);
        return out;
      }),

    respond: (responseUrl, text) =>
      call('response_url', async () => {
        const url = new URL(responseUrl);
        if (!allowedResponseHosts.has(url.host)) throw new SlackApiError('response_url', 'invalid_arguments');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        // A used-up or expired response URL answers 404; there is nobody left to tell.
        if (res.status === 404) return;
        if (!res.ok) throw new SlackApiError('response_url', `http_${res.status}`);
      }),
  };
}

/** Stands in when no bot token is set: every call fails with a permanent, named error. */
export function unconfiguredSlackClient(): SlackClient {
  const fail = (method: string) => () => Promise.reject(new SlackApiError(method, 'not_configured'));
  return {
    postMessage: fail('chat.postMessage'),
    updateMessage: fail('chat.update'),
    openView: fail('views.open'),
    publishHome: fail('views.publish'),
    listChannels: fail('conversations.list'),
    respond: fail('response_url'),
  };
}
