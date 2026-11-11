import { timingSafeEqual } from 'node:crypto';
import type { NormalizedTranscript, Vendor } from '../types.js';

/**
 * One adapter per vendor (design 5.1). The three things the design names are here: verify a
 * webhook, fetch one transcript, list what is new since a watermark. The rest is what
 * connecting an account needs: check the key, and register or remove the webhook.
 *
 * An adapter holds no key. Every call is given the key it should use, because Fathom keys
 * are per person and there can be several.
 */
export interface TranscriptSource {
  readonly vendor: Vendor;
  /** Checks that the key works and says whose account it is. */
  identify(key: string): Promise<SourceAccount>;
  createWebhook(key: string, input: { url: string; account: SourceAccount; scope: 'personal' | 'team' }): Promise<CreatedWebhook>;
  deleteWebhook(key: string, ref: string): Promise<void>;
  verifyWebhook(input: WebhookDelivery): WebhookCheck;
  /** What a verified delivery says happened. */
  readWebhook(rawBody: string): WebhookNotice;
  /** Recordings created or finished since `since`, newest or oldest first as the vendor returns them. */
  listSince(key: string, since: Date): Promise<Listing[]>;
  /** The transcript for one listed recording. Null when the vendor has not finished it yet. */
  fetchTranscript(key: string, listing: Listing): Promise<NormalizedTranscript | null>;
}

export interface CreatedWebhook {
  /** The vendor's id for the webhook, kept so it can be removed. */
  ref: string;
  secret: string;
  /** Anything the owner should know about what the webhook covers. */
  note?: string;
}

export interface SourceAccount {
  /** The vendor's reference for the user, where it has one (Calendly: the user URI). */
  user: string | null;
  organization: string | null;
  /** A name or address the vendor returned for the account, for the UI. */
  label: string | null;
}

export interface WebhookDelivery {
  /** Header names in lower case. */
  headers: Record<string, string | undefined>;
  rawBody: string;
  secret: string;
  /** When the public service received it. The signed timestamp is compared with this, not with now. */
  receivedAt: Date;
}

export type WebhookCheck = { ok: true } | { ok: false; reason: string };

export type WebhookNotice =
  | { kind: 'ready'; listing: Listing; transcript?: NormalizedTranscript }
  | { kind: 'deleted'; externalId: string }
  | { kind: 'ignored'; reason: string };

export interface Listing {
  externalId: string;
  /** False while the vendor is still processing the recording. */
  ready: boolean;
  /** What the listing already said about the recording, in the vendor's own shape. */
  meta?: unknown;
}

export class SourceApiError extends Error {
  constructor(
    readonly vendor: Vendor,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SourceApiError';
  }

  /** The key itself was refused: its owner was deactivated, or it was revoked. */
  get keyRejected(): boolean {
    return this.status === 401;
  }
}

export interface SourceOptions {
  baseUrl?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const NAME: Record<Vendor, string> = { calendly: 'Calendly', fathom: 'Fathom' };

/** One JSON request. The key goes in a header and never in a message or a log line. */
export async function requestJson(
  vendor: Vendor,
  doFetch: typeof fetch,
  input: { url: string; method?: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(input.url, {
      method: input.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'patcher-calls',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    throw new SourceApiError(vendor, `${NAME[vendor]} did not answer (${err instanceof Error ? err.name : 'error'})`, 0);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const said = [fields.message, fields.error, fields.title].find((v): v is string => typeof v === 'string') ?? 'request failed';
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new SourceApiError(
      vendor,
      `${NAME[vendor]}: ${said.replace(/\s+/g, ' ').slice(0, 160)} (HTTP ${response.status})`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return body;
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const asText = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
export const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
};
export const asEmail = (value: unknown): string | null => {
  const text = asText(value)?.toLowerCase();
  return text && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
};

/** The most pages one listing will read, so a vendor that keeps returning a cursor cannot loop a job. */
export const MAX_PAGES = 20;
