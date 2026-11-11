import { createHash } from 'node:crypto';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Enqueuer } from '../queue/queue.js';
import type { PreferredCopy } from '../settings/settings.js';
import { getSetting } from '../settings/settings.js';
import { closeSalesRecommendations, forgetCallQuotes } from '../sales/store.js';
import { closeCallRecommendations } from './store.js';
import type { Attendee, CallRow, NormalizedTranscript, TranscriptOrigin, TranscriptRow } from './types.js';

/**
 * Where a transcript enters Patcher, whichever way it came (webhook, poll or upload). It is
 * dropped if it is already here, attached to the call it is a second recording of, or made
 * into a new call that is analysed once the settle time has passed (design 5.1).
 */
export interface IngestDeps {
  pool: Pool;
  queue: Enqueuer;
}

export type IngestOutcome =
  | { outcome: 'new_call'; callId: string; transcriptId: string }
  /** A second recording of a call that is already here. Linked, and not analysed again. */
  | { outcome: 'grouped'; callId: string; transcriptId: string }
  | { outcome: 'duplicate'; callId: string }
  | { outcome: 'empty' };

/** One ingest at a time, so two recordings of one call arriving together end up in one call. */
const INGEST_LOCK = 4_170_002;
const MIN_WORDS = 5;

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The same words hash the same, whatever the spacing, casing or line breaks. */
export function contentHash(text: string): string {
  return createHash('sha256').update(fold(text)).digest('hex');
}

interface Shape {
  title: string;
  startedAt: Date | null;
  durationSeconds: number | null;
  hostEmail?: string | null;
  attendees: Attendee[];
}

const DEFAULT_LENGTH_MS = 30 * 60_000;
const START_SLACK_MS = 20 * 60_000;

function timesOverlap(a: Shape, b: Shape): boolean {
  if (!a.startedAt || !b.startedAt) return false;
  const aStart = a.startedAt.getTime();
  const bStart = b.startedAt.getTime();
  // One tool reports the scheduled time and the other the moment recording began.
  if (Math.abs(aStart - bStart) <= START_SLACK_MS) return true;
  const aLength = (a.durationSeconds ?? 0) * 1000 || DEFAULT_LENGTH_MS;
  const bLength = (b.durationSeconds ?? 0) * 1000 || DEFAULT_LENGTH_MS;
  const shared = Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart);
  return shared >= Math.min(aLength, bLength) / 2;
}

/** Share of the smaller set that is also in the other: one tool often lists more invitees than the other. */
function overlap(a: Set<string>, b: Set<string>): number | null {
  if (!a.size || !b.size) return null;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

const emails = (shape: Shape, except: Set<string> = new Set()): Set<string> =>
  new Set(shape.attendees.flatMap((a) => (a.email && !except.has(a.email.toLowerCase()) ? [a.email.toLowerCase()] : [])));
const names = (shape: Shape): Set<string> => new Set(shape.attendees.flatMap((a) => (a.name ? [fold(a.name)] : [])));

/**
 * Whether two transcripts are recordings of one call: the times overlap and the attendees
 * largely match. Where a source gives no attendees, the same title at the same time counts.
 */
export function sameCall(a: Shape, b: Shape): boolean {
  if (!timesOverlap(a, b)) return false;
  // Back-to-back calls share their host and nothing else, so the guests decide where both sides list any.
  const hosts = new Set([a.hostEmail, b.hostEmail].flatMap((h) => (h ? [h.toLowerCase()] : [])));
  const byGuest = hosts.size ? overlap(emails(a, hosts), emails(b, hosts)) : null;
  if (byGuest !== null) return byGuest >= 0.5;
  const byEmail = overlap(emails(a), emails(b));
  if (byEmail !== null) return byEmail >= 0.5;
  const byName = overlap(names(a), names(b));
  if (byName !== null) return byName >= 0.5;
  const title = fold(a.title);
  return title.length >= 4 && title === fold(b.title);
}

interface Copy {
  id: string;
  source: TranscriptOrigin;
  hasSpeakers: boolean;
  length: number;
  createdAt: Date;
}

/** Which copy is analysed (design 5.1). The default is the one with speaker labels, then the longer. */
export function pickPreferred(copies: Copy[], preference: PreferredCopy): string | null {
  const usable = copies.filter((c) => c.length > 0);
  if (!usable.length) return null;
  const rank = (c: Copy): number[] => [
    preference === 'calendly' || preference === 'fathom' ? (c.source === preference ? 1 : 0) : 0,
    preference === 'longest' ? 0 : c.hasSpeakers ? 1 : 0,
    c.length,
    -c.createdAt.getTime(),
  ];
  return usable.reduce((best, c) => {
    const [a, b] = [rank(c), rank(best)];
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]! ? c : best;
    return best;
  }).id;
}

function mergeAttendees(existing: Attendee[], incoming: Attendee[]): Attendee[] {
  const out = existing.map((a) => ({ ...a }));
  for (const next of incoming) {
    const same = out.find(
      (a) => (next.email && a.email?.toLowerCase() === next.email.toLowerCase()) || (!next.email && !a.email && a.name && next.name && fold(a.name) === fold(next.name)),
    );
    if (!same) {
      // A name without an address is the same person as an address with that name.
      const named = next.name ? out.find((a) => a.name && fold(a.name) === fold(next.name!) && (!a.email || !next.email)) : undefined;
      if (named) {
        named.email ??= next.email;
        named.external ??= next.external;
      } else {
        out.push({ ...next });
      }
      continue;
    }
    same.name ??= next.name;
    same.external ??= next.external;
  }
  return out.slice(0, 100);
}

async function repickPreferred(tx: Queryable, callId: string): Promise<string | null> {
  const preference = await getSetting(tx, 'calls.preferred_copy');
  const { rows } = await tx.query<{ id: string; source: TranscriptOrigin; has_speakers: boolean; length: number; created_at: Date }>(
    `SELECT id, source, has_speakers, coalesce(length(text), 0) AS length, created_at FROM transcripts WHERE call_id = $1`,
    [callId],
  );
  const preferred = pickPreferred(
    rows.map((r) => ({ id: r.id, source: r.source, hasSpeakers: r.has_speakers, length: r.length, createdAt: r.created_at })),
    preference,
  );
  await tx.query('UPDATE transcripts SET is_preferred = (id = $2) WHERE call_id = $1', [callId, preferred]);
  return preferred;
}

async function insertTranscript(tx: Queryable, t: NormalizedTranscript, callId: string, connectionId: string | null, hash: string, retentionDays: number): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO transcripts
       (source, connection_id, external_id, call_id, title, started_at, duration_seconds, host_email, attendees, text,
        has_speakers, has_timestamps, content_hash, url, purge_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now() + make_interval(days => $15))
     RETURNING id`,
    [
      t.source,
      connectionId,
      t.externalId,
      callId,
      t.title.slice(0, 300),
      t.startedAt,
      t.durationSeconds,
      t.hostEmail,
      JSON.stringify(t.attendees.slice(0, 100)),
      t.text,
      t.hasSpeakers,
      t.hasTimestamps,
      hash,
      t.url,
      retentionDays,
    ],
  );
  return rows[0]!.id;
}

export async function ingestTranscript(deps: IngestDeps, transcript: NormalizedTranscript, connectionId: string | null): Promise<IngestOutcome> {
  const text = transcript.text.trim();
  if (text.split(/\s+/).length < MIN_WORDS) return { outcome: 'empty' };
  const t = { ...transcript, text, title: transcript.title.trim() || 'Untitled call' };
  const hash = contentHash(text);

  return withTx(deps.pool, async (tx): Promise<IngestOutcome> => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK]);
    const known = await tx.query<{ call_id: string }>(
      `SELECT call_id FROM transcripts WHERE (source = $1 AND external_id = $2) OR content_hash = $3 LIMIT 1`,
      [t.source, t.externalId, hash],
    );
    if (known.rows[0]) return { outcome: 'duplicate', callId: known.rows[0].call_id };

    const [retentionDays, settleMinutes] = await Promise.all([getSetting(tx, 'calls.retention_days'), getSetting(tx, 'calls.settle_minutes')]);

    if (t.startedAt) {
      const near = await tx.query<CallRow>(
        `SELECT * FROM calls
          WHERE status <> 'deleted' AND started_at BETWEEN $1::timestamptz - interval '6 hours' AND $1::timestamptz + interval '6 hours'
          ORDER BY created_at
          FOR UPDATE`,
        [t.startedAt],
      );
      const twin = near.rows.find((c) =>
        sameCall(t, { title: c.title, startedAt: c.started_at, durationSeconds: c.duration_seconds, hostEmail: c.host_email, attendees: c.attendees }),
      );
      if (twin) {
        const transcriptId = await insertTranscript(tx, t, twin.id, connectionId, hash, retentionDays);
        // Once a call has been analysed, the copy that was analysed stays the preferred one.
        if (twin.status === 'received') await repickPreferred(tx, twin.id);
        await tx.query(
          `UPDATE calls SET attendees = $2, host_email = coalesce(host_email, $3), duration_seconds = coalesce(duration_seconds, $4), updated_at = now()
            WHERE id = $1`,
          [twin.id, JSON.stringify(mergeAttendees(twin.attendees, t.attendees)), t.hostEmail, t.durationSeconds],
        );
        await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'call.copy', target: twin.id, after: { source: t.source, transcriptId } });
        return { outcome: 'grouped', callId: twin.id, transcriptId };
      }
    }

    const call = await tx.query<{ id: string }>(
      `INSERT INTO calls (title, started_at, duration_seconds, host_email, attendees, analyze_after)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))
       RETURNING id`,
      [t.title.slice(0, 300), t.startedAt, t.durationSeconds, t.hostEmail, JSON.stringify(t.attendees.slice(0, 100)), settleMinutes],
    );
    const callId = call.rows[0]!.id;
    const transcriptId = await insertTranscript(tx, t, callId, connectionId, hash, retentionDays);
    await tx.query('UPDATE transcripts SET is_preferred = true WHERE id = $1', [transcriptId]);
    await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'call.receive', target: callId, after: { source: t.source, transcriptId } });
    await deps.queue.enqueue('calls.analyze', { callId }, { tx, startAfter: settleMinutes * 60 });
    return { outcome: 'new_call', callId, transcriptId };
  });
}

/** Whether a recording is already here, so a poll does not fetch its transcript again. */
export async function isKnown(db: Queryable, source: TranscriptOrigin, externalId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM transcripts WHERE source = $1 AND external_id = $2', [source, externalId]);
  return Boolean(rowCount);
}

const REMOVED = 'Removed: the recording was deleted at its source.';

/**
 * The recording was deleted at its source, so Patcher deletes its copy (design 5.1). When it
 * was the call's only copy, what was drawn from it and not yet acted on goes too.
 */
export async function removeTranscript(deps: IngestDeps, source: TranscriptOrigin, externalId: string): Promise<'removed' | 'not_found'> {
  return withTx(deps.pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK]);
    const { rows } = await tx.query<Pick<TranscriptRow, 'id' | 'call_id' | 'is_preferred'>>(
      'DELETE FROM transcripts WHERE source = $1 AND external_id = $2 RETURNING id, call_id, is_preferred',
      [source, externalId],
    );
    const gone = rows[0];
    if (!gone) return 'not_found';
    const call = await tx.query<Pick<CallRow, 'status'>>('SELECT status FROM calls WHERE id = $1 FOR UPDATE', [gone.call_id]);
    const left = await tx.query('SELECT 1 FROM transcripts WHERE call_id = $1 AND text IS NOT NULL LIMIT 1', [gone.call_id]);
    if (left.rowCount) {
      if (gone.is_preferred) await repickPreferred(tx, gone.call_id);
    } else {
      await closeCallRecommendations(tx, gone.call_id, { reason: REMOVED, actor: SYSTEM_ACTOR, blankEvidence: true });
      // Only what a person approved stays, because it was acted on: the agent, task or draft exists.
      await tx.query(
        `DELETE FROM call_suggestions s
          WHERE s.call_id = $1 AND NOT EXISTS (
            SELECT 1 FROM recommendations r WHERE r.id = s.recommendation_id AND r.status IN ('approved', 'executing', 'done', 'failed'))`,
        [gone.call_id],
      );
      await tx.query('DELETE FROM call_analyses WHERE call_id = $1', [gone.call_id]);
      // The same for what the sales pipeline drew from the call.
      await closeSalesRecommendations(tx, gone.call_id, { reason: REMOVED, actor: SYSTEM_ACTOR });
      await forgetCallQuotes(tx, gone.call_id);
      const sales = await tx.query('SELECT 1 FROM sales_calls WHERE call_id = $1', [gone.call_id]);
      if (sales.rowCount) await deps.queue.enqueue('sales.post', { callId: gone.call_id }, { tx });
      await tx.query(
        `UPDATE calls SET status = 'deleted', status_detail = $2, summary = NULL, hold_reason = NULL, updated_at = now() WHERE id = $1`,
        [gone.call_id, REMOVED],
      );
      if (call.rows[0] && call.rows[0].status !== 'deleted') await deps.queue.enqueue('calls.post', { callId: gone.call_id }, { tx });
    }
    await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'call.copy.delete', target: gone.call_id, after: { source, lastCopy: !left.rowCount } });
    return 'removed';
  });
}

/** The `retention.purge` schedule: transcript text past its retention is removed; the call's record stays. */
export async function purgeTranscripts(db: Queryable): Promise<string> {
  const { rowCount } = await db.query(
    `UPDATE transcripts SET text = NULL, purged_at = now() WHERE text IS NOT NULL AND purge_after < now()`,
  );
  return `${rowCount ?? 0} transcript${rowCount === 1 ? '' : 's'} purged`;
}

const STAMP = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+/;

/** A transcript pasted into the UI, in whatever shape the tool that made it wrote. */
export function normalizeUpload(input: { title: string; startedAt: Date | null; text: string }): NormalizedTranscript {
  const lines = input.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean);
  const stamped = lines.filter((line) => STAMP.test(line)).length;
  const labelled = lines.filter((line) => /^[^:]{1,60}: \S/.test(line.replace(STAMP, ''))).length;
  const text = lines.join('\n');
  return {
    source: 'upload',
    externalId: contentHash(text).slice(0, 32),
    title: input.title.trim() || 'Uploaded call',
    startedAt: input.startedAt,
    durationSeconds: null,
    hostEmail: null,
    attendees: [],
    text,
    hasSpeakers: lines.length > 0 && labelled / lines.length >= 0.6,
    hasTimestamps: lines.length > 0 && stamped / lines.length >= 0.6,
    url: null,
  };
}
