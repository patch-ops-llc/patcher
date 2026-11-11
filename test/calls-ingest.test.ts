import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectionError,
  addConnection,
  handleWebhook,
  listConnections,
  pollConnection,
  removeConnection,
  requestRemoval,
  retryConnection,
  setupConnection,
  sourceHealth,
  storeDelivery,
} from '../src/calls/connections.js';
import { ingestTranscript, normalizeUpload, pickPreferred, purgeTranscripts, removeTranscript, sameCall } from '../src/calls/ingest.js';
import { SourceApiError } from '../src/calls/sources/source.js';
import { getCall, listCalls, listTranscripts } from '../src/calls/store.js';
import { setSetting } from '../src/settings/settings.js';
import { createApp } from '../src/web/app.js';
import { runSchedule, scheduleHandlers } from '../src/worker/handlers.js';
import { ACME_TEXT, FakeSource, HOST, people, testSecrets, transcript } from './fixtures/calls.js';
import type { Harness } from './helpers.js';
import { OWNER, auditActions, harness, resetDb, routeTo, seedPeople, testIntegrations, testPool, webDeps } from './helpers.js';

/**
 * Ingestion against stand-ins for Calendly and Fathom (`FakeSource`). The real adapters'
 * requests and signatures are covered in calls-sources.test.ts, also without a network.
 */
const pool = testPool();
const PUBLIC_URL = 'https://patcher.example';
const secrets = testSecrets();

let h: Harness;
let fathom: FakeSource;
let calendly: FakeSource;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'errors', 'C0ERRORS');
  fathom = new FakeSource('fathom');
  calendly = new FakeSource('calendly');
  h = harness(pool, {
    integrations: testIntegrations({ transcripts: { calendly, fathom } }),
    secrets: secrets.box,
    appBaseUrl: PUBLIC_URL,
  });
});
afterAll(() => pool.end());

const calendlyCopy = (overrides = {}) =>
  transcript({
    source: 'calendly',
    externalId: 'recap-1',
    // Calendly reports the scheduled time and gives no timestamps or outside/inside flags.
    startedAt: new Date('2026-11-09T16:00:00Z'),
    durationSeconds: 30 * 60,
    attendees: [
      { ...people.host, external: false },
      { ...people.dana, external: null },
    ],
    text: 'Morgan Host: Thanks for joining the weekly sync.\nDana Client: Can we get a CSV export on the reports page?',
    hasTimestamps: false,
    ...overrides,
  });

const fathomCopy = (overrides = {}) =>
  transcript({ source: 'fathom', externalId: 'rec-1', startedAt: new Date('2026-11-09T16:02:00Z'), ...overrides });

async function connect(source: 'calendly' | 'fathom', owner: string, key: string, scope = 'personal', importDays = 0): Promise<string> {
  const id = await addConnection(h, { source, owner, scope, sealedKey: secrets.seal(key), importDays }, OWNER);
  expect(await setupConnection(h.worker, id)).toBe('connected');
  h.queue.clear();
  return id;
}

const connection = async (id: string) => (await listConnections(pool)).find((c) => c.id === id);

describe('grouping and duplicates', () => {
  it('stores a new transcript as a call and asks for it to be analysed after the settle time', async () => {
    const result = await ingestTranscript(h, fathomCopy(), null);
    expect(result.outcome).toBe('new_call');
    const callId = (result as { callId: string }).callId;
    expect(await getCall(pool, callId)).toMatchObject({ title: 'Acme weekly sync', status: 'received', hostEmail: HOST, durationSeconds: 32 * 60 });
    expect(await listTranscripts(pool, callId)).toMatchObject([{ source: 'fathom', isPreferred: true, text: ACME_TEXT, hasSpeakers: true }]);
    expect(h.queue.jobs).toMatchObject([{ name: 'calls.analyze', data: { callId }, options: { startAfter: 600 } }]);
    expect(await auditActions(pool)).toEqual(['call.receive']);
  });

  it('links a second recording of the same call from the other tool, and analyses the call once', async () => {
    const first = await ingestTranscript(h, calendlyCopy(), null);
    const second = await ingestTranscript(h, fathomCopy(), null);
    expect(first.outcome).toBe('new_call');
    expect(second).toMatchObject({ outcome: 'grouped', callId: (first as { callId: string }).callId });

    const calls = await listCalls(pool);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sources.sort()).toEqual(['calendly', 'fathom']);
    // One analysis job for the call, not one per recording.
    expect(h.queue.of('calls.analyze')).toHaveLength(1);

    // Both have speaker labels, so the longer one is the copy that is analysed.
    const copies = await listTranscripts(pool, calls[0]!.id);
    expect(copies.map((c) => [c.source, c.isPreferred])).toEqual([
      ['fathom', true],
      ['calendly', false],
    ]);
    // What each tool knew about the attendees is merged.
    expect(calls[0]!.attendees).toEqual([people.host, people.dana, people.sam]);
    expect(await auditActions(pool)).toEqual(['call.receive', 'call.copy']);
  });

  it('follows the preferred-copy setting', async () => {
    await setSetting(pool, 'calls.preferred_copy', 'calendly', OWNER);
    const first = await ingestTranscript(h, fathomCopy(), null);
    await ingestTranscript(h, calendlyCopy(), null);
    const copies = await listTranscripts(pool, (first as { callId: string }).callId);
    expect(copies.find((c) => c.isPreferred)!.source).toBe('calendly');
  });

  it('keeps the copy that was analysed once the call has been analysed', async () => {
    const first = await ingestTranscript(h, calendlyCopy(), null);
    const callId = (first as { callId: string }).callId;
    await pool.query(`UPDATE calls SET status = 'matched' WHERE id = $1`, [callId]);
    expect((await ingestTranscript(h, fathomCopy(), null)).outcome).toBe('grouped');
    const copies = await listTranscripts(pool, callId);
    expect(copies.find((c) => c.isPreferred)!.source).toBe('calendly');
    expect(h.queue.of('calls.analyze')).toHaveLength(1);
  });

  it('ignores the same recording arriving again, by webhook and by poll, or with the same words', async () => {
    const first = await ingestTranscript(h, fathomCopy(), null);
    expect(await ingestTranscript(h, fathomCopy(), null)).toEqual({ outcome: 'duplicate', callId: (first as { callId: string }).callId });
    // Shared from a teammate's Fathom under another id: the same words are the same recording.
    const again = fathomCopy({ externalId: 'rec-shared', text: ACME_TEXT.replace(/\n/g, '  \n').toUpperCase() });
    expect((await ingestTranscript(h, again, null)).outcome).toBe('duplicate');
    expect(await listCalls(pool)).toHaveLength(1);
  });

  it('keeps calls apart when the time or the people differ', async () => {
    await ingestTranscript(h, fathomCopy(), null);
    const laterSameDay = fathomCopy({ externalId: 'rec-2', startedAt: new Date('2026-11-09T19:00:00Z'), text: `${ACME_TEXT}\n[00:08:00] Dana Client: One more thing for later.` });
    const otherPeople = calendlyCopy({ externalId: 'recap-2', title: 'Intro chat', attendees: [people.host, people.kit], text: 'Morgan Host: Hello, nice to meet you today.\nKit Stranger: Likewise, thanks for the time.' });
    expect((await ingestTranscript(h, laterSameDay, null)).outcome).toBe('new_call');
    expect((await ingestTranscript(h, otherPeople, null)).outcome).toBe('new_call');
    expect(await listCalls(pool)).toHaveLength(3);
  });

  it('does not store a transcript with next to nothing in it', async () => {
    expect(await ingestTranscript(h, fathomCopy({ text: 'Hello there.' }), null)).toEqual({ outcome: 'empty' });
    expect(await listCalls(pool)).toHaveLength(0);
  });

  it('decides sameness by overlap in time and attendees', () => {
    const base = { title: 'Acme weekly sync', startedAt: new Date('2026-11-09T16:00:00Z'), durationSeconds: 1800, attendees: [people.host, people.dana] };
    expect(sameCall(base, { ...base, startedAt: new Date('2026-11-09T16:12:00Z'), attendees: [people.dana, people.sam, people.host] })).toBe(true);
    expect(sameCall(base, { ...base, startedAt: new Date('2026-11-09T17:30:00Z') })).toBe(false);
    expect(sameCall(base, { ...base, attendees: [people.kit, people.teammate] })).toBe(false);
    // No attendee lists at all: the same title at the same time.
    expect(sameCall({ ...base, attendees: [] }, { ...base, attendees: [] })).toBe(true);
    expect(sameCall({ ...base, attendees: [] }, { ...base, attendees: [], title: 'Another call' })).toBe(false);
    expect(sameCall({ ...base, startedAt: null }, base)).toBe(false);
    // Two short calls back to back share only their host.
    const hosted = { ...base, hostEmail: HOST, durationSeconds: 900 };
    expect(sameCall(hosted, { ...hosted, startedAt: new Date('2026-11-09T16:15:00Z'), attendees: [people.host, people.kit] })).toBe(false);
    expect(sameCall(hosted, { ...hosted, startedAt: new Date('2026-11-09T16:03:00Z'), attendees: [people.host, people.dana, people.sam] })).toBe(true);
    // One tool lists only the host: the host and the time are what there is to go on.
    expect(sameCall(hosted, { ...hosted, attendees: [people.host] })).toBe(true);
  });

  it('picks the preferred copy by the setting', () => {
    const at = new Date('2026-11-09T17:00:00Z');
    const copies = [
      { id: 'a', source: 'calendly' as const, hasSpeakers: false, length: 900, createdAt: at },
      { id: 'b', source: 'fathom' as const, hasSpeakers: true, length: 500, createdAt: at },
    ];
    expect(pickPreferred(copies, 'speakers')).toBe('b');
    expect(pickPreferred(copies, 'longest')).toBe('a');
    expect(pickPreferred(copies, 'calendly')).toBe('a');
    expect(pickPreferred(copies, 'fathom')).toBe('b');
    expect(pickPreferred([{ ...copies[0]!, length: 0 }], 'speakers')).toBeNull();
  });
});

describe('deletion at the source and retention', () => {
  it('removes one copy and analyses the other when a recording is deleted at its source', async () => {
    const first = await ingestTranscript(h, calendlyCopy(), null);
    const callId = (first as { callId: string }).callId;
    await ingestTranscript(h, fathomCopy(), null);
    expect(await removeTranscript(h, 'fathom', 'rec-1')).toBe('removed');
    expect(await listTranscripts(pool, callId)).toMatchObject([{ source: 'calendly', isPreferred: true }]);
    expect((await getCall(pool, callId))!.status).toBe('received');
    expect(await removeTranscript(h, 'fathom', 'rec-1')).toBe('not_found');
  });

  it('marks the call deleted when its last copy is deleted, and redraws its message', async () => {
    const first = await ingestTranscript(h, fathomCopy(), null);
    const callId = (first as { callId: string }).callId;
    h.queue.clear();
    await removeTranscript(h, 'fathom', 'rec-1');
    expect(await getCall(pool, callId)).toMatchObject({ status: 'deleted', summary: null });
    expect(await listTranscripts(pool, callId)).toEqual([]);
    expect(h.queue.of('calls.post')).toEqual([{ callId }]);
  });

  it('removes transcript text past its retention and keeps the call', async () => {
    const first = await ingestTranscript(h, fathomCopy(), null);
    const callId = (first as { callId: string }).callId;
    expect(await purgeTranscripts(pool)).toBe('0 transcripts purged');
    await pool.query(`UPDATE transcripts SET purge_after = now() - interval '1 day'`);
    await runSchedule(h.worker, scheduleHandlers, { key: 'retention.purge', trigger: 'schedule' });
    const [copy] = await listTranscripts(pool, callId);
    expect(copy).toMatchObject({ text: null, title: 'Acme weekly sync' });
    expect(copy!.purgedAt).toBeInstanceOf(Date);
    const run = await pool.query<{ summary: string; ok: boolean }>(`SELECT summary, ok FROM runs WHERE pipeline = 'retention.purge'`);
    expect(run.rows).toEqual([{ summary: '1 transcript purged, 0 Slack messages cleared', ok: true }]);
  });
});

describe('a transcript pasted into the UI', () => {
  it('keeps speakers and times where the pasted text has them', () => {
    const upload = normalizeUpload({ title: ' Acme weekly sync ', startedAt: null, text: `${ACME_TEXT.replace(/\n/g, '\r\n')}\r\n\r\n` });
    expect(upload).toMatchObject({ source: 'upload', title: 'Acme weekly sync', text: ACME_TEXT, hasSpeakers: true, hasTimestamps: true, attendees: [], hostEmail: null });
    expect(normalizeUpload({ title: '', startedAt: null, text: 'just some words\nwith no labels at all' })).toMatchObject({
      title: 'Uploaded call',
      hasSpeakers: false,
      hasTimestamps: false,
    });
    // The same words give the same id, so pasting twice does not make two calls.
    expect(normalizeUpload({ title: 'a', startedAt: null, text: ACME_TEXT }).externalId).toBe(upload.externalId);
  });
});

describe('connections', () => {
  it('checks a new key, registers its webhook and starts collecting', async () => {
    const id = await addConnection(h, { source: 'fathom', owner: 'Morgan', scope: 'team', sealedKey: secrets.seal('made-up-fathom-key-1'), importDays: 7 }, OWNER);
    expect(await connection(id)).toMatchObject({ status: 'pending', hasKey: true, hasWebhook: false, importDays: 7, scope: 'team' });
    expect(h.queue.of('calls.connection.setup')).toEqual([{ connectionId: id }]);
    h.queue.clear();

    expect(await setupConnection(h.worker, id)).toBe('connected');
    // The worker opened the sealed key and used it; the webhook points at a secret address on the public service.
    expect(fathom.keys).toEqual(['made-up-fathom-key-1']);
    expect(fathom.webhooks).toHaveLength(1);
    expect(fathom.webhooks[0]).toMatchObject({ key: 'made-up-fathom-key-1', scope: 'team' });
    expect(fathom.webhooks[0]!.url).toMatch(/^https:\/\/patcher\.example\/webhooks\/fathom\/[A-Za-z0-9_-]{43}$/);
    const after = (await connection(id))!;
    expect(after).toMatchObject({ status: 'connected', hasWebhook: true, webhookNote: null, lastError: null });
    expect(Date.now() - after.watermark!.getTime()).toBeGreaterThan(6.9 * 86_400_000);
    expect(h.queue.of('calls.poll')).toEqual([{ connectionId: id }]);

    // Neither the key nor the webhook secret nor the address token is stored in the clear.
    const stored = JSON.stringify((await pool.query('SELECT * FROM transcript_connections')).rows);
    expect(stored).not.toContain('made-up-fathom-key-1');
    expect(stored).not.toContain(fathom.webhooks[0]!.secret);
    expect(stored).not.toContain(fathom.webhooks[0]!.url.split('/').at(-1));
    const audit = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    expect(audit).not.toContain('made-up-fathom-key-1');

    // Running the setup again registers no second webhook.
    expect(await setupConnection(h.worker, id)).toBe('connected');
    expect(fathom.webhooks).toHaveLength(1);
  });

  it('collects by poll only when the public address is not one a vendor can reach', async () => {
    const local = harness(pool, { integrations: h.worker.integrations, secrets: secrets.box });
    const id = await addConnection(local, { source: 'calendly', owner: 'Morgan', scope: 'personal', sealedKey: secrets.seal('made-up-calendly-token'), importDays: 0 }, OWNER);
    expect(await setupConnection(local.worker, id)).toBe('connected');
    expect(calendly.webhooks).toEqual([]);
    expect(await connection(id)).toMatchObject({ status: 'connected', hasWebhook: false, accountLabel: 'Morgan Host' });
    expect((await connection(id))!.webhookNote).toContain('APP_BASE_URL on the worker is not a public https address');
  });

  it('stays connected, with a note, when the vendor will not register a webhook', async () => {
    calendly.webhookError = new SourceApiError('calendly', 'Calendly: Upgrade your plan to use webhooks (HTTP 403)', 403);
    const id = await addConnection(h, { source: 'calendly', owner: 'Morgan', scope: 'personal', sealedKey: secrets.seal('made-up-calendly-token'), importDays: 0 }, OWNER);
    expect(await setupConnection(h.worker, id)).toBe('connected');
    expect((await connection(id))!.webhookNote).toBe('No webhook: Calendly: Upgrade your plan to use webhooks (HTTP 403). The 15-minute poll collects calls instead.');
  });

  it('marks a connection whose key is refused, and lets it be tried again', async () => {
    fathom.rejectKey();
    const id = await addConnection(h, { source: 'fathom', owner: 'Riley', scope: 'personal', sealedKey: secrets.seal('made-up-dead-key'), importDays: 0 }, OWNER);
    expect(await setupConnection(h.worker, id)).toBe('disconnected');
    expect(await connection(id)).toMatchObject({ status: 'disconnected', lastError: 'The key was refused: the key was not accepted (HTTP 401)' });
    fathom.keyError = undefined;
    h.queue.clear();
    await retryConnection(h, id, OWNER);
    expect(h.queue.of('calls.connection.setup')).toEqual([{ connectionId: id }]);
    expect(await setupConnection(h.worker, id)).toBe('connected');
  });

  it('says what is missing when the worker cannot open stored keys', async () => {
    const noKey = harness(pool, { integrations: h.worker.integrations, secrets: null, appBaseUrl: PUBLIC_URL });
    const id = await addConnection(noKey, { source: 'fathom', owner: 'Morgan', scope: 'team', sealedKey: secrets.seal('made-up-fathom-key-1'), importDays: 0 }, OWNER);
    expect(await setupConnection(noKey.worker, id)).toBe('error');
    expect(await connection(id)).toMatchObject({ status: 'error', lastError: 'TOKEN_PRIVATE_KEY is not set on the worker, so stored keys cannot be read.' });
    expect(fathom.keys).toEqual([]);
  });

  it('refuses a second Calendly connection, an unknown source and too long an import', async () => {
    await connect('calendly', 'Morgan', 'made-up-calendly-token');
    const add = (source: string, importDays = 0, owner = 'Someone') =>
      addConnection(h, { source, owner, scope: 'personal', sealedKey: secrets.seal('made-up-key'), importDays }, OWNER);
    await expect(add('calendly')).rejects.toThrow('Calendly is already connected');
    await expect(add('zoom')).rejects.toBeInstanceOf(ConnectionError);
    await expect(add('fathom', 15)).rejects.toThrow('0 to 14 days');
    await expect(add('fathom', 0, '  ')).rejects.toThrow('Say whose key this is');
    // Fathom keys are per person: any number of them.
    await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    await connect('fathom', 'Riley', 'made-up-fathom-key-2');
    expect((await listConnections(pool)).map((c) => `${c.source}:${c.owner}:${c.scope}`)).toEqual(['calendly:Morgan:personal', 'fathom:Morgan:team', 'fathom:Riley:personal']);
    expect(await sourceHealth(pool)).toMatchObject({ calendly: { connected: 1 }, fathom: { connected: 2 } });
  });

  it('removes the webhook at the vendor and erases the key, keeping the calls', async () => {
    const id = await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    await ingestTranscript(h, fathomCopy(), id);
    await requestRemoval(h, id, OWNER);
    expect(h.queue.of('calls.connection.remove')).toEqual([{ connectionId: id, requestedBy: OWNER }]);
    expect(await removeConnection(h.worker, id, OWNER)).toBe(true);
    expect(fathom.deleted).toEqual(['hook-1']);
    expect(await listConnections(pool)).toEqual([]);
    const { rows } = await pool.query('SELECT secret_ciphertext, webhook_secret_ct, hook_token_hash, status FROM transcript_connections');
    expect(rows).toEqual([{ secret_ciphertext: null, webhook_secret_ct: null, hook_token_hash: null, status: 'disconnected' }]);
    expect(await listCalls(pool)).toHaveLength(1);
    expect(await auditActions(pool)).toContain('calls.connection.remove');
  });
});

describe('the catch-up poll', () => {
  it('fetches what is new since the watermark with the connection\'s own key, and nothing twice', async () => {
    const morgan = await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    const riley = await connect('fathom', 'Riley', 'made-up-fathom-key-2');
    fathom.add(fathomCopy()).add(fathomCopy({ externalId: 'rec-processing' }), false);
    fathom.keys = [];
    const watermark = (await connection(morgan))!.watermark!;
    const now = new Date(watermark.getTime() + 15 * 60_000);

    expect(await pollConnection(h.worker, morgan, now)).toEqual({ outcome: 'polled', listed: 2, added: 1 });
    expect(fathom.fetched).toEqual(['rec-1']);
    // A recap can become available hours after its call: each poll looks a day behind its watermark.
    expect(fathom.sinceSeen[0]!.getTime()).toBe(watermark.getTime() - 24 * 3600_000);
    expect((await connection(morgan))!.watermark).toEqual(now);

    // The teammate's key sees the same shared recording. It is here already, so it is not fetched again.
    expect(await pollConnection(h.worker, riley, now)).toEqual({ outcome: 'polled', listed: 2, added: 0 });
    expect(fathom.fetched).toEqual(['rec-1']);
    expect(new Set(fathom.keys)).toEqual(new Set(['made-up-fathom-key-1', 'made-up-fathom-key-2']));
    expect(await listCalls(pool)).toHaveLength(1);
    expect((await listTranscripts(pool, (await listCalls(pool))[0]!.id))[0]!.connectionId).toBe(morgan);
  });

  it('disconnects only the connection whose key died, with one notice', async () => {
    const riley = await connect('fathom', 'Riley', 'made-up-fathom-key-2');
    const cal = await connect('calendly', 'Morgan', 'made-up-calendly-token');
    fathom.rejectKey();
    expect((await pollConnection(h.worker, riley)).outcome).toBe('disconnected');
    expect((await pollConnection(h.worker, riley)).outcome).toBe('skipped');
    expect(await connection(riley)).toMatchObject({ status: 'disconnected' });
    expect(await connection(cal)).toMatchObject({ status: 'connected' });
    const notices = h.slack.of('postMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ channel: 'C0ERRORS', text: `Fathom key for Riley stopped working, so its calls are not collected. Connect a new key in <${PUBLIC_URL}/settings#calls|Settings>.` });
    expect(await auditActions(pool)).toContain('calls.connection.disconnected');

    calendly.add(calendlyCopy());
    expect((await pollConnection(h.worker, cal)).added).toBe(1);
  });

  it('keeps its watermark when the vendor says to slow down, and records other failures', async () => {
    const id = await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    const before = (await connection(id))!.watermark;
    fathom.listError = new SourceApiError('fathom', 'Fathom: Too many requests (HTTP 429)', 429);
    expect((await pollConnection(h.worker, id)).outcome).toBe('rate_limited');
    expect((await connection(id))!.watermark).toEqual(before);

    fathom.listError = new SourceApiError('fathom', 'Fathom: Internal error (HTTP 500)', 500);
    await expect(pollConnection(h.worker, id)).rejects.toThrow('HTTP 500');
    expect(await connection(id)).toMatchObject({ status: 'connected', lastError: 'Fathom: Internal error (HTTP 500)' });
  });

  it('runs from the schedule: one job per working connection, and none while calls are off', async () => {
    const a = await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    const b = await connect('calendly', 'Morgan', 'made-up-calendly-token');
    await runSchedule(h.worker, scheduleHandlers, { key: 'transcripts.poll', trigger: 'schedule' });
    expect(h.queue.of('calls.poll').map((j) => j.connectionId).sort()).toEqual([a, b].sort());

    h.queue.clear();
    await setSetting(pool, 'calls.enabled', false, OWNER);
    await runSchedule(h.worker, scheduleHandlers, { key: 'transcripts.poll', trigger: 'schedule' });
    expect(h.queue.of('calls.poll')).toEqual([]);
    expect((await pollConnection(h.worker, a)).outcome).toBe('skipped');
    const { rows } = await pool.query<{ summary: string }>(`SELECT summary FROM runs WHERE pipeline = 'transcripts.poll' ORDER BY id`);
    expect(rows.map((r) => r.summary)).toEqual(['2 connections asked for new calls.', 'Skipped: calls are switched off.']);
  });
});

describe('completion webhooks', () => {
  const tokenOf = (source: FakeSource) => source.webhooks[0]!.url.split('/').at(-1)!;
  const fathomHeaders = (signature: string, id = 'msg_1') => ({ 'webhook-id': id, 'webhook-timestamp': '1700000000', 'webhook-signature': signature });
  const body = (kind: string, id: string, embed = false) => JSON.stringify({ kind, id, embed });
  const eventId = () => h.queue.of('calls.webhook').at(-1)!.webhookEventId;

  it('stores a delivery, verifies it in the worker and ingests the transcript it carries', async () => {
    const id = await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    fathom.add(fathomCopy());
    const delivery = { source: 'fathom', token: tokenOf(fathom), headers: fathomHeaders(fathom.webhooks[0]!.secret), rawBody: body('ready', 'rec-1', true) };
    expect(await storeDelivery(h, delivery)).toBe('stored');
    // Fathom retries with the same delivery id.
    expect(await storeDelivery(h, delivery)).toBe('duplicate');
    expect(h.queue.of('calls.webhook')).toHaveLength(1);

    fathom.keys = [];
    expect(await handleWebhook(h.worker, eventId())).toBe('ingested');
    // The transcript came in the delivery: no request to the vendor was needed.
    expect(fathom.fetched).toEqual([]);
    const calls = await listCalls(pool);
    expect(calls).toMatchObject([{ title: 'Acme weekly sync', status: 'received' }]);
    expect((await listTranscripts(pool, calls[0]!.id))[0]!.connectionId).toBe(id);

    // The stored delivery no longer holds the body, and a second run of the job does nothing.
    const stored = await pool.query<{ payload: Record<string, unknown>; processed_at: Date | null }>('SELECT payload, processed_at FROM webhook_events');
    expect(stored.rows[0]!.payload).toEqual({ connectionId: id, outcome: 'ingested' });
    expect(stored.rows[0]!.processed_at).toBeInstanceOf(Date);
    expect(await handleWebhook(h.worker, eventId())).toBe('already_done');
    expect(await listCalls(pool)).toHaveLength(1);
  });

  it('fetches the transcript with the connection\'s key when the delivery only names the recording', async () => {
    await connect('calendly', 'Morgan', 'made-up-calendly-token');
    calendly.add(calendlyCopy());
    calendly.keys = [];
    const headers = { 'calendly-webhook-signature': calendly.webhooks[0]!.secret };
    expect(await storeDelivery(h, { source: 'calendly', token: tokenOf(calendly), headers, rawBody: body('ready', 'recap-1') })).toBe('stored');
    expect(await handleWebhook(h.worker, eventId())).toBe('ingested');
    expect(calendly.fetched).toEqual(['recap-1']);
    expect(calendly.keys).toEqual(['made-up-calendly-token']);

    // Calendly sends no delivery id: the same body again is the same delivery, an updated one is not.
    expect(await storeDelivery(h, { source: 'calendly', token: tokenOf(calendly), headers, rawBody: body('ready', 'recap-1') })).toBe('duplicate');
    expect(await storeDelivery(h, { source: 'calendly', token: tokenOf(calendly), headers, rawBody: `${body('ready', 'recap-1')} ` })).toBe('stored');
    expect(await handleWebhook(h.worker, eventId())).toBe('duplicate');
    expect(calendly.fetched).toEqual(['recap-1']);

    // Not ready at the vendor yet: left for the poll.
    expect(await storeDelivery(h, { source: 'calendly', token: tokenOf(calendly), headers, rawBody: body('ready', 'recap-later') })).toBe('stored');
    expect(await handleWebhook(h.worker, eventId())).toBe('not_ready');
    expect(await listCalls(pool)).toHaveLength(1);
  });

  it('uses nothing from a delivery whose signature does not verify', async () => {
    await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    fathom.add(fathomCopy());
    expect(await storeDelivery(h, { source: 'fathom', token: tokenOf(fathom), headers: fathomHeaders('forged'), rawBody: body('ready', 'rec-1', true) })).toBe('stored');
    expect(await handleWebhook(h.worker, eventId())).toBe('rejected');
    expect(await listCalls(pool)).toEqual([]);
    const stored = await pool.query<{ payload: Record<string, unknown> }>('SELECT payload FROM webhook_events');
    expect(stored.rows[0]!.payload).toMatchObject({ outcome: 'rejected', detail: 'bad_signature' });
    expect(JSON.stringify(stored.rows[0]!.payload)).not.toContain('rec-1');
  });

  it('refuses an address it never gave out, a delivery without a signature, and anything for a removed connection', async () => {
    const id = await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    const good = { source: 'fathom', token: tokenOf(fathom), headers: fathomHeaders(fathom.webhooks[0]!.secret), rawBody: body('ready', 'rec-1') };
    expect(await storeDelivery(h, { ...good, token: 'A'.repeat(43) })).toBe('unknown');
    expect(await storeDelivery(h, { ...good, token: 'short' })).toBe('unknown');
    expect(await storeDelivery(h, { ...good, source: 'calendly' })).toBe('unknown');
    expect(await storeDelivery(h, { ...good, source: 'zoom' })).toBe('unknown');
    expect(await storeDelivery(h, { ...good, headers: { 'webhook-id': 'msg_1' } })).toBe('unsigned');
    expect(h.queue.of('calls.webhook')).toEqual([]);

    await setSetting(pool, 'calls.enabled', false, OWNER);
    expect(await storeDelivery(h, good)).toBe('off');
    await setSetting(pool, 'calls.enabled', true, OWNER);

    await removeConnection(h.worker, id, OWNER);
    expect(await storeDelivery(h, good)).toBe('unknown');
    expect(await pool.query('SELECT 1 FROM webhook_events')).toMatchObject({ rowCount: 0 });
  });

  it('deletes its copy when the vendor says the recording was deleted', async () => {
    await connect('calendly', 'Morgan', 'made-up-calendly-token');
    await ingestTranscript(h, calendlyCopy(), null);
    const headers = { 'calendly-webhook-signature': calendly.webhooks[0]!.secret };
    await storeDelivery(h, { source: 'calendly', token: tokenOf(calendly), headers, rawBody: body('deleted', 'recap-1') });
    expect(await handleWebhook(h.worker, eventId())).toBe('deleted');
    expect(await listCalls(pool)).toMatchObject([{ status: 'deleted' }]);
    expect((await pool.query('SELECT 1 FROM transcripts')).rowCount).toBe(0);
  });

  it('takes deliveries over HTTP on the public service: acknowledged at once, without a session', async () => {
    await connect('fathom', 'Morgan', 'made-up-fathom-key-1', 'team');
    fathom.add(fathomCopy());
    const app = createApp(webDeps(h));
    const path = `/webhooks/fathom/${tokenOf(fathom)}`;
    const send = (to: string, signature?: string) => {
      const req = request(app).post(to).set('content-type', 'application/json').set('webhook-id', 'msg_9').set('webhook-timestamp', '1700000000');
      if (signature) req.set('Webhook-Signature', signature);
      return req.send(body('ready', 'rec-1', true));
    };
    await send(path, fathom.webhooks[0]!.secret).expect(200, { ok: true });
    await send(path, fathom.webhooks[0]!.secret).expect(200, { ok: true });
    await send(`/webhooks/fathom/${'B'.repeat(43)}`, fathom.webhooks[0]!.secret).expect(404);
    await send(path).expect(400);
    expect(h.queue.of('calls.webhook')).toHaveLength(1);

    // The body is stored byte for byte, which is what the signature is over.
    const stored = await pool.query<{ payload: { body: string } }>('SELECT payload FROM webhook_events');
    expect(stored.rows[0]!.payload.body).toBe(body('ready', 'rec-1', true));
    expect(await handleWebhook(h.worker, eventId())).toBe('ingested');

    const health = await request(app).get('/health').expect(200);
    expect((health.body as { callSources: unknown }).callSources).toMatchObject({ fathom: { connected: 1 }, calendly: { connected: 0, lastOkAt: null } });
  });
});
