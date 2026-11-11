import { createHmac } from 'node:crypto';
import type { Attendee, NormalizedTranscript } from '../types.js';
import type { Listing, SourceOptions, TranscriptSource, WebhookNotice } from './source.js';
import { MAX_PAGES, SourceApiError, asDate, asEmail, asRecord, asText, requestJson, safeEqual } from './source.js';

/**
 * Fathom's external API, built from its published OpenAPI document
 * (https://developers.fathom.ai/api-reference/openapi.json, read 2026-11-11):
 *
 *   GET    /meetings?created_after=…&cursor=…     what the key's owner can see
 *   GET    /recordings/{id}/transcript            speaker, text and HH:MM:SS per line
 *   POST   /webhooks, DELETE /webhooks/{id}       "new meeting content ready"
 *
 * A key is one person's and sees what that person sees. There is no endpoint that says whose
 * key it is, so the owner's name is whatever was typed when it was connected.
 */
export const FATHOM_API_URL = 'https://api.fathom.ai/external/v1';

/** Fathom signs within five minutes of sending. */
const TOLERANCE_SECONDS = 5 * 60;

const TEAM_TRIGGERS = ['my_recordings', 'my_shared_with_team_recordings', 'shared_team_recordings'];
const PERSONAL_TRIGGERS = ['my_recordings', 'my_shared_with_team_recordings'];
/** Works on every plan. The other kinds need a Fathom Team plan. */
const BASIC_TRIGGERS = ['my_recordings'];

interface TranscriptItem {
  speaker?: { display_name?: unknown; matched_calendar_invitee_email?: unknown };
  text?: unknown;
  timestamp?: unknown;
}

const seconds = (from: Date | null, to: Date | null): number | null =>
  from && to && to.getTime() > from.getTime() ? Math.round((to.getTime() - from.getTime()) / 1000) : null;

function transcriptText(items: unknown): { text: string; hasTimestamps: boolean } {
  const lines: string[] = [];
  let stamped = 0;
  for (const raw of Array.isArray(items) ? (items as TranscriptItem[]) : []) {
    const words = asText(raw.text);
    if (!words) continue;
    const speaker = asText(raw.speaker?.display_name) ?? 'Speaker';
    const at = typeof raw.timestamp === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(raw.timestamp) ? raw.timestamp : null;
    if (at) stamped += 1;
    lines.push(`${at ? `[${at}] ` : ''}${speaker}: ${words.replace(/\s+/g, ' ')}`);
  }
  return { text: lines.join('\n'), hasTimestamps: lines.length > 0 && stamped === lines.length };
}

/** A Fathom meeting object, as the listing and the webhook both send it, in the shared shape. */
export function normalizeFathomMeeting(meeting: unknown, transcript: unknown): NormalizedTranscript | null {
  const m = asRecord(meeting);
  const id = typeof m.recording_id === 'number' || typeof m.recording_id === 'string' ? String(m.recording_id) : null;
  if (!id) return null;
  const { text, hasTimestamps } = transcriptText(transcript);
  if (!text) return null;

  const recorder = asRecord(m.recorded_by);
  const hostEmail = asEmail(recorder.email);
  const attendees: Attendee[] = [];
  for (const raw of Array.isArray(m.calendar_invitees) ? m.calendar_invitees : []) {
    const invitee = asRecord(raw);
    const email = asEmail(invitee.email);
    const name = asText(invitee.name) ?? asText(invitee.matched_speaker_display_name);
    if (!email && !name) continue;
    attendees.push({ name, email, external: typeof invitee.is_external === 'boolean' ? invitee.is_external : null });
  }
  if (hostEmail && !attendees.some((a) => a.email === hostEmail)) {
    attendees.unshift({ name: asText(recorder.name), email: hostEmail, external: false });
  }

  const started = asDate(m.recording_start_time) ?? asDate(m.scheduled_start_time) ?? asDate(m.created_at);
  return {
    source: 'fathom',
    externalId: id,
    title: asText(m.meeting_title) ?? asText(m.title) ?? 'Untitled call',
    startedAt: started,
    durationSeconds:
      seconds(asDate(m.recording_start_time), asDate(m.recording_end_time)) ??
      seconds(asDate(m.scheduled_start_time), asDate(m.scheduled_end_time)),
    hostEmail,
    attendees,
    text,
    hasSpeakers: true,
    hasTimestamps,
    url: asText(m.share_url) ?? asText(m.url),
  };
}

export function createFathomSource(options: SourceOptions = {}): TranscriptSource {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? FATHOM_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;

  const call = (key: string, path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<unknown> =>
    requestJson('fathom', doFetch, { url: `${baseUrl}${path}`, method, headers: { 'x-api-key': key }, body, timeoutMs });

  const register = async (key: string, url: string, triggers: string[]): Promise<{ ref: string; secret: string }> => {
    const created = asRecord(
      await call(key, '/webhooks', 'POST', {
        destination_url: url,
        triggered_for: triggers,
        include_transcript: true,
        include_summary: false,
        include_action_items: false,
        include_crm_matches: false,
      }),
    );
    const ref = asText(created.id);
    const secret = asText(created.secret);
    if (!ref || !secret) throw new SourceApiError('fathom', 'Fathom: the webhook was created without an id or a secret', 200);
    return { ref, secret };
  };

  return {
    vendor: 'fathom',

    async identify(key) {
      // The cheapest request that needs a working key: a listing that starts now, so it is empty.
      await call(key, `/meetings?created_after=${encodeURIComponent(new Date().toISOString())}`);
      return { user: null, organization: null, label: null };
    },

    async createWebhook(key, input) {
      const wanted = input.scope === 'team' ? TEAM_TRIGGERS : PERSONAL_TRIGGERS;
      try {
        return await register(key, input.url, wanted);
      } catch (err) {
        // The team kinds need a Fathom Team plan. Without one, the owner's own recordings still arrive.
        if (!(err instanceof SourceApiError) || ![400, 403, 422].includes(err.status)) throw err;
        const basic = await register(key, input.url, BASIC_TRIGGERS);
        return {
          ...basic,
          note: "Fathom refused the team recording kinds (they need a Team plan), so the webhook covers this person's own recordings. The poll still collects everything the key can see.",
        };
      }
    },

    async deleteWebhook(key, ref) {
      try {
        await call(key, `/webhooks/${encodeURIComponent(ref)}`, 'DELETE');
      } catch (err) {
        if (err instanceof SourceApiError && err.status === 404) return;
        throw err;
      }
    },

    verifyWebhook({ headers, rawBody, secret, receivedAt }) {
      const id = headers['webhook-id'];
      const timestamp = headers['webhook-timestamp'];
      const signatures = headers['webhook-signature'];
      if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing_headers' };
      const sent = Number(timestamp);
      if (!Number.isFinite(sent) || Math.abs(receivedAt.getTime() / 1000 - sent) > TOLERANCE_SECONDS) {
        return { ok: false, reason: 'stale_timestamp' };
      }
      const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      if (!key.length) return { ok: false, reason: 'no_secret' };
      const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
      // The header can carry several signatures, each written `v1,<base64>`, separated by spaces.
      const matches = signatures
        .split(' ')
        .map((entry) => entry.split(','))
        .some(([version, value]) => version === 'v1' && value !== undefined && safeEqual(Buffer.from(value, 'base64'), expected));
      return matches ? { ok: true } : { ok: false, reason: 'bad_signature' };
    },

    readWebhook(rawBody): WebhookNotice {
      let meeting: unknown;
      try {
        meeting = JSON.parse(rawBody);
      } catch {
        return { kind: 'ignored', reason: 'not_json' };
      }
      const m = asRecord(meeting);
      const id = typeof m.recording_id === 'number' || typeof m.recording_id === 'string' ? String(m.recording_id) : null;
      if (!id) return { kind: 'ignored', reason: 'no_recording_id' };
      const transcript = normalizeFathomMeeting(m, m.transcript);
      return { kind: 'ready', listing: { externalId: id, ready: true, meta: meeting }, ...(transcript ? { transcript } : {}) };
    },

    async listSince(key, since) {
      const out: Listing[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ created_after: since.toISOString() });
        if (cursor) query.set('cursor', cursor);
        const body = asRecord(await call(key, `/meetings?${query.toString()}`));
        for (const item of Array.isArray(body.items) ? body.items : []) {
          const m = asRecord(item);
          if (typeof m.recording_id !== 'number' && typeof m.recording_id !== 'string') continue;
          // The transcript is asked for per recording, so a listing is small and cheap.
          const { transcript: _transcript, ...meta } = m;
          out.push({ externalId: String(m.recording_id), ready: true, meta });
        }
        cursor = asText(body.next_cursor);
        if (!cursor) break;
      }
      return out;
    },

    async fetchTranscript(key, listing) {
      if (!/^[A-Za-z0-9_-]+$/.test(listing.externalId)) return null;
      let body: unknown;
      try {
        body = await call(key, `/recordings/${listing.externalId}/transcript`);
      } catch (err) {
        // Not finished yet, or no longer shared with this key's owner.
        if (err instanceof SourceApiError && err.status === 404) return null;
        throw err;
      }
      return normalizeFathomMeeting({ recording_id: listing.externalId, ...asRecord(listing.meta) }, asRecord(body).transcript);
    },
  };
}
