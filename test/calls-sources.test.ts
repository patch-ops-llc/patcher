import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCalendlySource, normalizeCalendlyRecap } from '../src/calls/sources/calendly.js';
import { createFathomSource, normalizeFathomMeeting } from '../src/calls/sources/fathom.js';
import { SourceApiError } from '../src/calls/sources/source.js';

/** A signing secret in Fathom's shape, assembled here so no secret-looking literal is in the repository. */
const MADE_UP_SECRET = `whsec_${Buffer.from('made-up-signing-secret').toString('base64')}`;

/**
 * The real adapters against a stand-in for `fetch`. Nothing here reaches Calendly or
 * Fathom; the request and response shapes are the ones in their published API documents.
 * Keys, secrets, people and calls are made up.
 */
const KEY = 'made-up-key-for-tests';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (seen: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function stubFetch(route: Route): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const doFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Seen = {
      method: init?.method ?? 'GET',
      url: new URL(input instanceof Request ? input.url : input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    seen.push(call);
    const answer = route(call) ?? { status: 404, body: { message: 'no such route in this test' } };
    return Promise.resolve(
      new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: answer.headers ?? {} }),
    );
  }) as typeof fetch;
  return { fetch: doFetch, seen };
}

const RECEIVED = new Date('2026-11-10T12:00:00Z');
const stamp = (offsetSeconds = 0): string => String(Math.floor(RECEIVED.getTime() / 1000) + offsetSeconds);

describe('Fathom adapter', () => {
  const meeting = {
    title: 'Acme weekly sync',
    meeting_title: 'Acme weekly sync',
    recording_id: 4711,
    url: 'https://fathom.example/calls/4711',
    share_url: 'https://fathom.example/share/abc',
    created_at: '2026-11-09T16:40:00Z',
    scheduled_start_time: '2026-11-09T16:00:00Z',
    scheduled_end_time: '2026-11-09T16:30:00Z',
    recording_start_time: '2026-11-09T16:01:00Z',
    recording_end_time: '2026-11-09T16:33:00Z',
    recorded_by: { name: 'Morgan Host', email: 'Morgan@Agency.example' },
    calendar_invitees: [
      { name: 'Dana Client', email: 'dana@acme.example', is_external: true },
      { name: 'Riley Teammate', email: 'riley@agency.example', is_external: false },
    ],
  };
  const lines = [
    { speaker: { display_name: 'Morgan Host' }, text: 'Thanks for joining the weekly sync.', timestamp: '00:00:05' },
    { speaker: { display_name: 'Dana Client' }, text: 'Can we get a CSV export\n on the reports page?', timestamp: '00:01:12' },
  ];

  it('reduces a meeting and its transcript to the shared shape', () => {
    expect(normalizeFathomMeeting(meeting, lines)).toEqual({
      source: 'fathom',
      externalId: '4711',
      title: 'Acme weekly sync',
      startedAt: new Date('2026-11-09T16:01:00Z'),
      durationSeconds: 32 * 60,
      hostEmail: 'morgan@agency.example',
      attendees: [
        { name: 'Morgan Host', email: 'morgan@agency.example', external: false },
        { name: 'Dana Client', email: 'dana@acme.example', external: true },
        { name: 'Riley Teammate', email: 'riley@agency.example', external: false },
      ],
      text: '[00:00:05] Morgan Host: Thanks for joining the weekly sync.\n[00:01:12] Dana Client: Can we get a CSV export on the reports page?',
      hasSpeakers: true,
      hasTimestamps: true,
      url: 'https://fathom.example/share/abc',
    });
    expect(normalizeFathomMeeting(meeting, [])).toBeNull();
    expect(normalizeFathomMeeting({ title: 'no id' }, lines)).toBeNull();
  });

  it('sends the key in a header, lists every page since the watermark and fetches a transcript per recording', async () => {
    const { fetch, seen } = stubFetch(({ url }) => {
      if (url.pathname.endsWith('/meetings')) {
        return url.searchParams.get('cursor')
          ? { body: { items: [{ ...meeting, recording_id: 4712 }], next_cursor: null } }
          : { body: { items: [meeting], next_cursor: 'page-2' } };
      }
      if (url.pathname.endsWith('/recordings/4711/transcript')) return { body: { transcript: lines } };
      return undefined;
    });
    const source = createFathomSource({ fetch, baseUrl: 'https://fathom.test/external/v1' });
    const since = new Date('2026-11-08T00:00:00Z');

    const listed = await source.listSince(KEY, since);
    expect(listed.map((l) => l.externalId)).toEqual(['4711', '4712']);
    expect(seen[0]!.url.searchParams.get('created_after')).toBe(since.toISOString());
    expect(seen.every((s) => s.headers['x-api-key'] === KEY)).toBe(true);
    // The key is never part of an address.
    expect(seen.some((s) => s.url.toString().includes(KEY))).toBe(false);

    const fetched = await source.fetchTranscript(KEY, listed[0]!);
    expect(fetched).toMatchObject({ externalId: '4711', title: 'Acme weekly sync', hostEmail: 'morgan@agency.example', hasTimestamps: true });
    // Not finished, or no longer shared with the key's owner: nothing, without an error.
    expect(await source.fetchTranscript(KEY, listed[1]!)).toBeNull();
    expect(await source.fetchTranscript(KEY, { externalId: '../meetings', ready: true })).toBeNull();
  });

  it('registers one webhook with the transcript included, and falls back to own recordings without a Team plan', async () => {
    const posted: unknown[] = [];
    const { fetch } = stubFetch(({ method, url, body }) => {
      if (method !== 'POST' || !url.pathname.endsWith('/webhooks')) return undefined;
      posted.push(body);
      const triggers = (body as { triggered_for: string[] }).triggered_for;
      if (triggers.includes('shared_team_recordings')) return { status: 403, body: { message: 'Team plan required' } };
      return { status: 201, body: { id: 'hook-1', secret: MADE_UP_SECRET } };
    });
    const source = createFathomSource({ fetch });
    const created = await source.createWebhook(KEY, {
      url: 'https://patcher.example/webhooks/fathom/token',
      account: { user: null, organization: null, label: null },
      scope: 'team',
    });
    expect(created).toMatchObject({ ref: 'hook-1', secret: MADE_UP_SECRET });
    expect(created.note).toContain('Team plan');
    expect(posted).toEqual([
      expect.objectContaining({ destination_url: 'https://patcher.example/webhooks/fathom/token', include_transcript: true, triggered_for: ['my_recordings', 'my_shared_with_team_recordings', 'shared_team_recordings'] }),
      expect.objectContaining({ triggered_for: ['my_recordings'], include_summary: false }),
    ]);
  });

  it('says so when the key is refused, without the key in the message', async () => {
    const { fetch } = stubFetch(() => ({ status: 401, body: { message: 'Invalid API key' } }));
    const source = createFathomSource({ fetch });
    const err = await source.identify(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceApiError);
    expect((err as SourceApiError).keyRejected).toBe(true);
    expect((err as SourceApiError).message).toBe('Fathom: Invalid API key (HTTP 401)');
    expect((err as SourceApiError).message).not.toContain(KEY);
  });

  it('reports a provider that does not answer as worth another try', async () => {
    const source = createFathomSource({ fetch: (() => Promise.reject(new TypeError('fetch failed'))) });
    const err = (await source.listSince(KEY, new Date()).catch((e: unknown) => e)) as SourceApiError;
    expect(err).toMatchObject({ status: 0, keyRejected: false });
  });

  describe('webhook signature', () => {
    const source = createFathomSource({ fetch: stubFetch(() => undefined).fetch });
    const secretBytes = Buffer.from('made-up-signing-secret');
    const secret = `whsec_${secretBytes.toString('base64')}`;
    const rawBody = JSON.stringify({ ...meeting, transcript: lines });
    const sign = (id: string, ts: string, body: string, key = secretBytes) => `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
    const delivery = (overrides: Record<string, string | undefined> = {}, body = rawBody) => ({
      headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': stamp(), 'webhook-signature': sign('msg_1', stamp(), rawBody), ...overrides },
      rawBody: body,
      secret,
      receivedAt: RECEIVED,
    });

    it('accepts a delivery signed with the webhook secret', () => {
      expect(source.verifyWebhook(delivery())).toEqual({ ok: true });
      // Several signatures can be sent during a secret rotation; one good one is enough.
      expect(source.verifyWebhook(delivery({ 'webhook-signature': `v1,AAAA ${sign('msg_1', stamp(), rawBody)}` }))).toEqual({ ok: true });
    });

    it('refuses a changed body, another secret, an old timestamp and missing headers', () => {
      expect(source.verifyWebhook(delivery({}, rawBody.replace('Acme', 'Other')))).toEqual({ ok: false, reason: 'bad_signature' });
      expect(source.verifyWebhook(delivery({ 'webhook-signature': sign('msg_1', stamp(), rawBody, Buffer.from('another-secret')) }))).toEqual({ ok: false, reason: 'bad_signature' });
      expect(source.verifyWebhook(delivery({ 'webhook-id': 'msg_2' }))).toEqual({ ok: false, reason: 'bad_signature' });
      const old = stamp(-6 * 60);
      expect(source.verifyWebhook(delivery({ 'webhook-timestamp': old, 'webhook-signature': sign('msg_1', old, rawBody) }))).toEqual({ ok: false, reason: 'stale_timestamp' });
      expect(source.verifyWebhook(delivery({ 'webhook-signature': undefined }))).toEqual({ ok: false, reason: 'missing_headers' });
      expect(source.verifyWebhook({ ...delivery(), secret: 'whsec_' })).toEqual({ ok: false, reason: 'no_secret' });
    });

    it('reads the transcript out of a verified delivery', () => {
      const notice = source.readWebhook(rawBody);
      expect(notice).toMatchObject({ kind: 'ready', listing: { externalId: '4711' }, transcript: { title: 'Acme weekly sync', source: 'fathom' } });
      expect(source.readWebhook('not json')).toEqual({ kind: 'ignored', reason: 'not_json' });
      expect(source.readWebhook('{"title":"x"}')).toEqual({ kind: 'ignored', reason: 'no_recording_id' });
    });
  });
});

describe('Calendly adapter', () => {
  const USER = 'https://api.calendly.com/users/user-uuid-0001';
  const ORG = 'https://api.calendly.com/organizations/org-uuid-0001';
  const RECAP_ID = 'recap-uuid-0001';
  const recap = {
    uri: `https://api.calendly.com/meeting_recaps/${RECAP_ID}`,
    name: 'Acme weekly sync',
    status: 'available',
    start_time: '2026-11-09T16:00:00Z',
    end_time: '2026-11-09T16:32:00Z',
    app_url: 'https://calendly.example/app/recaps/recap-uuid-0001',
    attendees: [
      { user_name: 'Morgan Host', user_email: 'morgan@agency.example', host: true },
      { user_name: 'Dana Client', user_email: 'dana@acme.example', host: false },
    ],
  };
  const text = 'Morgan Host: Thanks for joining the weekly sync.\r\nDana Client: Can we get a CSV export on the reports page?\n\n';

  it('reduces a recap and its transcript to the shared shape', () => {
    expect(normalizeCalendlyRecap(recap, text)).toEqual({
      source: 'calendly',
      externalId: RECAP_ID,
      title: 'Acme weekly sync',
      startedAt: new Date('2026-11-09T16:00:00Z'),
      durationSeconds: 32 * 60,
      hostEmail: 'morgan@agency.example',
      attendees: [
        { name: 'Morgan Host', email: 'morgan@agency.example', external: false },
        { name: 'Dana Client', email: 'dana@acme.example', external: null },
      ],
      text: 'Morgan Host: Thanks for joining the weekly sync.\nDana Client: Can we get a CSV export on the reports page?',
      hasSpeakers: true,
      hasTimestamps: false,
      url: 'https://calendly.example/app/recaps/recap-uuid-0001',
    });
    expect(normalizeCalendlyRecap(recap, '   ')).toBeNull();
  });

  it('checks the token against the account and the recaps, and returns whose it is', async () => {
    const { fetch, seen } = stubFetch(({ url }) => {
      if (url.pathname === '/users/me') return { body: { resource: { uri: USER, current_organization: ORG, email: 'morgan@agency.example', name: 'Morgan Host' } } };
      if (url.pathname === '/meeting_recaps') return { body: { collection: [], pagination: {} } };
      return undefined;
    });
    const source = createCalendlySource({ fetch });
    expect(await source.identify(KEY)).toEqual({ user: USER, organization: ORG, label: 'morgan@agency.example' });
    expect(seen.map((s) => s.url.pathname)).toEqual(['/users/me', '/meeting_recaps']);
    expect(seen.every((s) => s.headers.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('fails the check, with the reason, when the plan has no Notetaker or a scope is missing', async () => {
    const { fetch } = stubFetch(({ url }) => {
      if (url.pathname === '/users/me') return { body: { resource: { uri: USER, current_organization: ORG } } };
      return { status: 403, body: { title: 'Permission Denied', message: 'This token is missing the scope meeting_recaps:read' } };
    });
    const err = (await createCalendlySource({ fetch }).identify(KEY).catch((e: unknown) => e)) as SourceApiError;
    expect(err).toBeInstanceOf(SourceApiError);
    expect(err.keyRejected).toBe(false);
    expect(err.message).toBe('Calendly: This token is missing the scope meeting_recaps:read (HTTP 403)');
  });

  it('subscribes to the recap events for the user with a signing key of its own choosing', async () => {
    const { fetch, seen } = stubFetch(({ method, url }) =>
      method === 'POST' && url.pathname === '/webhook_subscriptions'
        ? { status: 201, body: { resource: { uri: 'https://api.calendly.com/webhook_subscriptions/sub-uuid-0001' } } }
        : undefined,
    );
    const source = createCalendlySource({ fetch });
    const created = await source.createWebhook(KEY, {
      url: 'https://patcher.example/webhooks/calendly/token',
      account: { user: USER, organization: ORG, label: null },
      scope: 'personal',
    });
    const sent = seen[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      url: 'https://patcher.example/webhooks/calendly/token',
      events: ['meeting_recap.created', 'meeting_recap.updated', 'meeting_recap.deleted'],
      organization: ORG,
      user: USER,
      scope: 'user',
    });
    expect(created.ref).toBe('https://api.calendly.com/webhook_subscriptions/sub-uuid-0001');
    expect(created.secret).toBe(sent.signing_key);
    expect(created.secret.length).toBeGreaterThanOrEqual(40);

    seen.length = 0;
    await source.deleteWebhook(KEY, created.ref);
    // Already gone at Calendly counts as removed.
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual(['DELETE /webhook_subscriptions/sub-uuid-0001']);
  });

  it('lists recaps since the watermark across pages and fetches a transcript only once the recap is available', async () => {
    let status = 'processing';
    const { fetch, seen } = stubFetch(({ url }) => {
      if (url.pathname === '/meeting_recaps') {
        return url.searchParams.get('page_token')
          ? { body: { collection: [{ uri: 'https://api.calendly.com/meeting_recaps/recap-uuid-0002' }], pagination: { next_page_token: null } } }
          : { body: { collection: [recap], pagination: { next_page_token: 'next' } } };
      }
      if (url.pathname === `/meeting_recaps/${RECAP_ID}`) return { body: { resource: { ...recap, status } } };
      if (url.pathname === `/meeting_recaps/${RECAP_ID}/transcript`) return { body: { resource: { text } } };
      return undefined;
    });
    const source = createCalendlySource({ fetch });
    const since = new Date('2026-11-08T00:00:00Z');
    const listed = await source.listSince(KEY, since);
    expect(listed.map((l) => l.externalId)).toEqual([RECAP_ID, 'recap-uuid-0002']);
    expect(seen[0]!.url.searchParams.get('start_time')).toBe(since.toISOString());

    expect(await source.fetchTranscript(KEY, listed[0]!)).toBeNull();
    status = 'available';
    expect(await source.fetchTranscript(KEY, listed[0]!)).toMatchObject({ externalId: RECAP_ID, hostEmail: 'morgan@agency.example', hasSpeakers: true });
    expect(await source.fetchTranscript(KEY, listed[1]!)).toBeNull();
  });

  describe('webhook signature', () => {
    const source = createCalendlySource({ fetch: stubFetch(() => undefined).fetch });
    const secret = 'made-up-signing-secret-for-calendly';
    const rawBody = JSON.stringify({ event: 'meeting_recap.created', payload: { recap: { uri: recap.uri } } });
    const header = (ts: string, body = rawBody, key = secret) => `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;
    const delivery = (signature: string | undefined, body = rawBody) => ({
      headers: { 'calendly-webhook-signature': signature },
      rawBody: body,
      secret,
      receivedAt: RECEIVED,
    });

    it('accepts a delivery signed with the signing key', () => {
      expect(source.verifyWebhook(delivery(header(stamp())))).toEqual({ ok: true });
    });

    it('refuses a changed body, another key, an old timestamp and a missing or malformed header', () => {
      expect(source.verifyWebhook(delivery(header(stamp()), rawBody.replace('created', 'deleted')))).toEqual({ ok: false, reason: 'bad_signature' });
      expect(source.verifyWebhook(delivery(header(stamp(), rawBody, 'another-key')))).toEqual({ ok: false, reason: 'bad_signature' });
      expect(source.verifyWebhook(delivery(header(stamp(-4 * 60))))).toEqual({ ok: false, reason: 'stale_timestamp' });
      expect(source.verifyWebhook(delivery(undefined))).toEqual({ ok: false, reason: 'missing_headers' });
      expect(source.verifyWebhook(delivery(`t=${stamp()}`))).toEqual({ ok: false, reason: 'missing_headers' });
      expect(source.verifyWebhook(delivery(`t=${stamp()},v1=not-hex`))).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('reads which recap a delivery is about, and that one was deleted', () => {
      expect(source.readWebhook(rawBody)).toEqual({ kind: 'ready', listing: { externalId: RECAP_ID, ready: true } });
      expect(source.readWebhook(rawBody.replace('created', 'deleted'))).toEqual({ kind: 'deleted', externalId: RECAP_ID });
      expect(source.readWebhook(JSON.stringify({ event: 'invitee.created', payload: {} }))).toEqual({ kind: 'ignored', reason: 'other_event' });
      expect(source.readWebhook(JSON.stringify({ event: 'meeting_recap.created', payload: {} }))).toEqual({ kind: 'ignored', reason: 'no_recap' });
    });
  });
});
