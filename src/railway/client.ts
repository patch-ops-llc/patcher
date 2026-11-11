import type { Logger } from '../log.js';
import type { ReadQueryName } from './queries.js';
import { READ_QUERIES } from './queries.js';

export const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2';

export class RailwayApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** What the collectors need: run one of the fixed read queries. Tests pass a fixture reader. */
export interface RailwayReader {
  query<T>(name: ReadQueryName, variables?: Record<string, unknown>): Promise<T>;
}

export interface RailwayClientOptions {
  token: string;
  log: Logger;
  endpoint?: string;
  fetch?: typeof fetch;
  /** Stop before the hourly allowance is gone, so other users of the token keep working. */
  reserveRequests?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 30_000;

/**
 * Read-only client for Railway's public GraphQL API. It can send only the queries in
 * `READ_QUERIES`; there is no method that takes query text.
 */
export function createRailwayClient(options: RailwayClientOptions): RailwayReader {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? RAILWAY_ENDPOINT;
  const reserve = options.reserveRequests ?? 250;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let remaining: number | undefined;
  let resetAt: number | undefined;

  const attempt = async <T>(name: ReadQueryName, variables: Record<string, unknown>): Promise<T> => {
    if (remaining !== undefined && remaining <= reserve && resetAt !== undefined && Date.now() < resetAt) {
      throw new RailwayApiError(
        `Railway's hourly request allowance is nearly used up (${remaining} left); stopped to leave the rest.`,
        false,
      );
    }
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
          'user-agent': 'patcher-audit',
        },
        body: JSON.stringify({ query: READ_QUERIES[name], variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RailwayApiError(`Railway did not answer (${err instanceof Error ? err.name : 'error'})`, true);
    }

    const left = Number(response.headers.get('x-ratelimit-remaining'));
    if (response.headers.has('x-ratelimit-remaining') && Number.isFinite(left)) remaining = left;
    const reset = Date.parse(response.headers.get('x-ratelimit-reset') ?? '');
    if (Number.isFinite(reset)) resetAt = reset;

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000;
      if (waitMs > MAX_WAIT_MS) throw new RailwayApiError('Railway rate limit reached', false);
      await sleep(waitMs);
      throw new RailwayApiError('Railway rate limit reached', true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RailwayApiError(`Railway refused the token (HTTP ${response.status})`, false);
    }
    if (response.status >= 500) throw new RailwayApiError(`Railway returned HTTP ${response.status}`, true);

    let body: { data?: T | null; errors?: { message?: string }[] };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new RailwayApiError(`Railway returned HTTP ${response.status} without JSON`, response.status >= 500);
    }
    if (body.errors?.length || body.data === null || body.data === undefined) {
      const message = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new RailwayApiError(`Railway: ${message.slice(0, 200)}`, false);
    }
    return body.data;
  };

  return {
    async query<T>(name: ReadQueryName, variables: Record<string, unknown> = {}): Promise<T> {
      let last: unknown;
      for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
        try {
          return await attempt<T>(name, variables);
        } catch (err) {
          last = err;
          if (!(err instanceof RailwayApiError) || !err.retryable || i === MAX_ATTEMPTS) break;
          options.log.debug('railway query retry', { query: name, attempt: i, reason: err.message });
          await sleep(500 * 2 ** (i - 1));
        }
      }
      throw last;
    },
  };
}
