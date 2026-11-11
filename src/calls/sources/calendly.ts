import { createHmac, randomBytes } from 'node:crypto';
import type { Attendee, NormalizedTranscript } from '../types.js';
import type { Listing, SourceOptions, TranscriptSource, WebhookNotice } from './source.js';
import { MAX_PAGES, SourceApiError, asDate, asEmail, asRecord, asText, requestJson, safeEqual } from './source.js';

/**
 * Calendly Notetaker, built from Calendly's published API reference
 * (https://developer.calendly.com/openapi/calendly-api.yaml, read 2026-11-11):
 *
 *   GET    /users/me                                   whose token this is
 *   GET    /meeting_recaps?start_time=…                recaps for meetings that ended after a time
 *   GET    /meeting_recaps/{uuid}                      one recap: name, times, attendees, status
 *   GET    /meeting_recaps/{uuid}/transcript           plain text, one "Speaker: words" line per turn
 *   POST   /webhook_subscriptions, DELETE …/{uuid}     meeting_recap.created, .updated and .deleted
 *
 * A personal access token needs the scopes `meeting_recaps:read`, `users:read` and
 * `webhooks:write`, and the plan has to include Notetaker.
 */
export const CALENDLY_API_URL = 'https://api.calendly.com';

/** Calendly's own example allows three minutes between signing and receipt. */
const TOLERANCE_SECONDS = 3 * 60;
const EVENTS = ['meeting_recap.created', 'meeting_recap.updated', 'meeting_recap.deleted'];
const UUID_AT_END = /\/([A-Za-z0-9-]{8,})\/?$/;

const lastSegment = (uri: unknown): string | null => {
  const text = asText(uri);
  return text ? (UUID_AT_END.exec(text)?.[1] ?? null) : null;
};

/** Calendly sends each turn as `Speaker: words` on its own line, with no timestamps. */
export function normalizeCalendlyText(raw: string): { text: string; hasSpeakers: boolean } {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const labelled = lines.filter((line) => /^[^:]{1,60}: \S/.test(line)).length;
  return { text: lines.join('\n'), hasSpeakers: lines.length > 0 && labelled / lines.length >= 0.6 };
}

function attendeesOf(value: unknown): { attendees: Attendee[]; hostEmail: string | null } {
  const attendees: Attendee[] = [];
  let hostEmail: string | null = null;
  for (const raw of Array.isArray(value) ? value : []) {
    const a = asRecord(raw);
    const email = asEmail(a.user_email);
    const name = asText(a.user_name);
    if (!email && !name) continue;
    // Calendly does not say who is outside the organisation; the host is the one person known to be inside it.
    attendees.push({ name, email, external: a.host === true ? false : null });
    if (a.host === true && email && !hostEmail) hostEmail = email;
  }
  return { attendees, hostEmail };
}

export function normalizeCalendlyRecap(recap: unknown, transcriptText: string): NormalizedTranscript | null {
  const r = asRecord(recap);
  const id = lastSegment(r.uri);
  if (!id) return null;
  const { text, hasSpeakers } = normalizeCalendlyText(transcriptText);
  if (!text) return null;
  const { attendees, hostEmail } = attendeesOf(r.attendees);
  const start = asDate(r.start_time);
  const end = asDate(r.end_time);
  return {
    source: 'calendly',
    externalId: id,
    title: asText(r.name) ?? 'Untitled call',
    startedAt: start,
    durationSeconds: start && end && end.getTime() > start.getTime() ? Math.round((end.getTime() - start.getTime()) / 1000) : null,
    hostEmail,
    attendees,
    text,
    hasSpeakers,
    hasTimestamps: false,
    url: asText(r.app_url),
  };
}

export function createCalendlySource(options: SourceOptions = {}): TranscriptSource {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? CALENDLY_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;

  const call = (key: string, path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<unknown> =>
    requestJson('calendly', doFetch, { url: `${baseUrl}${path}`, method, headers: { authorization: `Bearer ${key}` }, body, timeoutMs });

  return {
    vendor: 'calendly',

    async identify(key) {
      const me = asRecord(asRecord(await call(key, '/users/me')).resource);
      const user = asText(me.uri);
      const organization = asText(me.current_organization);
      if (!user || !organization) throw new SourceApiError('calendly', 'Calendly: the account has no user or organization reference', 200);
      // One page of recaps: this is what fails when the plan has no Notetaker or the scope is missing.
      await call(key, `/meeting_recaps?count=1&start_time=${encodeURIComponent(new Date().toISOString())}`);
      return { user, organization, label: asText(me.email) ?? asText(me.name) };
    },

    async createWebhook(key, input) {
      // The signing key is ours to choose. Calendly signs every delivery with it.
      const secret = randomBytes(32).toString('base64url');
      const created = asRecord(
        asRecord(
          await call(key, '/webhook_subscriptions', 'POST', {
            url: input.url,
            events: EVENTS,
            organization: input.account.organization,
            user: input.account.user,
            scope: 'user',
            signing_key: secret,
          }),
        ).resource,
      );
      const ref = asText(created.uri);
      if (!ref) throw new SourceApiError('calendly', 'Calendly: the webhook subscription was created without a reference', 200);
      return { ref, secret };
    },

    async deleteWebhook(key, ref) {
      const uuid = lastSegment(ref);
      if (!uuid) return;
      try {
        await call(key, `/webhook_subscriptions/${encodeURIComponent(uuid)}`, 'DELETE');
      } catch (err) {
        if (err instanceof SourceApiError && err.status === 404) return;
        throw err;
      }
    },

    verifyWebhook({ headers, rawBody, secret, receivedAt }) {
      const header = headers['calendly-webhook-signature'];
      if (!header) return { ok: false, reason: 'missing_headers' };
      const parts = new Map(
        header.split(',').map((part) => {
          const at = part.indexOf('=');
          return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
        }),
      );
      const timestamp = parts.get('t');
      const signature = parts.get('v1');
      if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };
      const sent = Number(timestamp);
      if (!Number.isFinite(sent) || Math.abs(receivedAt.getTime() / 1000 - sent) > TOLERANCE_SECONDS) {
        return { ok: false, reason: 'stale_timestamp' };
      }
      const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
      return /^[0-9a-f]+$/i.test(signature) && safeEqual(Buffer.from(signature, 'hex'), expected)
        ? { ok: true }
        : { ok: false, reason: 'bad_signature' };
    },

    readWebhook(rawBody): WebhookNotice {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return { kind: 'ignored', reason: 'not_json' };
      }
      const event = asText(asRecord(body).event);
      const externalId = lastSegment(asRecord(asRecord(asRecord(body).payload).recap).uri);
      if (!event?.startsWith('meeting_recap.')) return { kind: 'ignored', reason: 'other_event' };
      if (!externalId) return { kind: 'ignored', reason: 'no_recap' };
      if (event === 'meeting_recap.deleted') return { kind: 'deleted', externalId };
      // The payload carries the summary but not the transcript, which is fetched with the token.
      return { kind: 'ready', listing: { externalId, ready: true } };
    },

    async listSince(key, since) {
      const out: Listing[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ start_time: since.toISOString(), count: '50' });
        if (pageToken) query.set('page_token', pageToken);
        const body = asRecord(await call(key, `/meeting_recaps?${query.toString()}`));
        for (const item of Array.isArray(body.collection) ? body.collection : []) {
          const externalId = lastSegment(asRecord(item).uri);
          if (externalId) out.push({ externalId, ready: true, meta: item });
        }
        pageToken = asText(asRecord(body.pagination).next_page_token);
        if (!pageToken) break;
      }
      return out;
    },

    async fetchTranscript(key, listing) {
      if (!/^[A-Za-z0-9-]+$/.test(listing.externalId)) return null;
      const path = `/meeting_recaps/${listing.externalId}`;
      let recap: Record<string, unknown>;
      let transcript: Record<string, unknown>;
      try {
        // Asked for again even when the listing had it: a webhook only names the recap.
        recap = asRecord(asRecord(await call(key, path)).resource);
        if (asText(recap.status)?.toLowerCase() !== 'available') return null;
        transcript = asRecord(asRecord(await call(key, `${path}/transcript`)).resource);
      } catch (err) {
        if (err instanceof SourceApiError && err.status === 404) return null;
        throw err;
      }
      return normalizeCalendlyRecap(recap, asText(transcript.text) ?? '');
    },
  };
}
