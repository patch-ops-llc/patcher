import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createServiceAdapter, externalRefFor } from '../src/dealroom/adapter.js';
import { prepareFiles } from '../src/dealroom/files.js';
import { parseRoomOrigin } from '../src/dealroom/origin.js';
import { planWrite } from '../src/dealroom/plan.js';
import type { RoomFile } from '../src/dealroom/service.js';
import { DealRoomServiceError, createDealRoomService } from '../src/dealroom/service.js';
import { FakeDealRoom, ROOM_ORIGIN, ROOM_TOKEN } from './fixtures/dealroom.js';

/**
 * The deal room's service API client, the write plan and the adapter over them, against a
 * stand-in built from the API's contract. The real deal room was never called by these
 * tests or by anything else in this phase.
 */
const PROPOSAL = ['# Order sync for Larkfield', '', '## Summary', '', 'A sync into billing.', '', '## Scope', '', '- The sync', '- The dashboard'].join('\n');
const DEAL = { id: '0b1c2d3e-0000-4000-8000-000000000001', company: 'Larkfield Outfitters', dealRoomSlug: null as string | null };
const FACTS = { proposalVersion: 'v1', proposalUpdatedAt: '2026-11-10' };

function setup() {
  const room = new FakeDealRoom();
  const service = createDealRoomService({ token: ROOM_TOKEN, fetch: room.fetch });
  return { room, service, adapter: createServiceAdapter(service) };
}

const prepared = (content = PROPOSAL) => prepareFiles({ title: 'Order sync for Larkfield', contentMd: content });
const sent = (room: FakeDealRoom) => room.calls.map((c) => `${c.method} ${c.path}`);
const audience = (members = 0, invites = 0, domains = 0) => ({ members, invites, domains });

async function refusal(run: () => Promise<unknown>): Promise<DealRoomServiceError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof DealRoomServiceError) return err;
    throw err;
  }
  throw new Error('expected the call to be refused');
}

describe('the deal room address', () => {
  it('is a plain https origin and nothing more', () => {
    expect(parseRoomOrigin(' https://Dealroom.Example/ ')).toEqual({ ok: true, origin: 'https://dealroom.example' });
    expect(parseRoomOrigin('https://dealroom.example:8443')).toEqual({ ok: true, origin: 'https://dealroom.example:8443' });
    for (const bad of [
      'http://dealroom.example',
      'https://someone:secret@dealroom.example',
      'https://dealroom.example/api/service',
      'https://dealroom.example?x=1',
      'https://dealroom.example#frag',
      'ftp://dealroom.example',
      'dealroom.example',
      'javascript:alert(1)',
      '',
    ]) {
      expect(parseRoomOrigin(bad).ok, bad).toBe(false);
    }
  });

  it('lets http through for this machine only, and only when asked', () => {
    expect(parseRoomOrigin('http://localhost:3000').ok).toBe(false);
    expect(parseRoomOrigin('http://localhost:3000', { allowLocalHttp: true })).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(parseRoomOrigin('http://127.0.0.1:3000', { allowLocalHttp: true }).ok).toBe(true);
    expect(parseRoomOrigin('http://dealroom.example', { allowLocalHttp: true }).ok).toBe(false);
  });
});

describe('the service API client', () => {
  it('sends the token as a bearer header to the service routes, and never follows a redirect', async () => {
    const { room, service } = setup();
    const { room: created, created: isNew } = await service.findOrCreate(ROOM_ORIGIN, { externalRef: 'patcher:deal:1', clientName: 'Larkfield Outfitters' });
    expect(isNew).toBe(true);
    expect(created).toMatchObject({ slug: 'larkfield-outfitters', status: 'DRAFT', externalRef: 'patcher:deal:1', memberCount: 0, pendingInviteCount: 0, allowedEmailDomains: 0 });
    await service.get(ROOM_ORIGIN, created.id);
    await service.content(ROOM_ORIGIN, created.id, { bodies: true });
    await service.list(ROOM_ORIGIN, { externalRef: 'patcher:deal:1' });

    expect(sent(room)).toEqual([
      'POST /api/service/deals',
      `GET /api/service/deals/${created.id}`,
      `GET /api/service/deals/${created.id}/content?include=body`,
      'GET /api/service/deals?externalRef=patcher%3Adeal%3A1',
    ]);
    expect(room.calls.every((c) => c.authorized && c.redirect === 'manual')).toBe(true);
    // The token is in the header only: never in a path or a body.
    expect(JSON.stringify(room.calls)).not.toContain(ROOM_TOKEN);
  });

  it('refuses a short token before it is ever used', () => {
    expect(() => createDealRoomService({ token: 'too-short' })).toThrow(/too short/);
  });

  it('sends nothing to an address that is not a plain https origin, or for an id that is not one', async () => {
    const { room, service } = setup();
    for (const origin of ['http://dealroom.example', 'https://dealroom.example/elsewhere', 'https://user:pw@dealroom.example']) {
      expect((await refusal(() => service.get(origin, 'cmstandin0001'))).code).toBe('bad_request_local');
    }
    expect((await refusal(() => service.get(ROOM_ORIGIN, '../admin'))).code).toBe('bad_request_local');
    expect((await refusal(() => service.findOrCreate(ROOM_ORIGIN, { externalRef: 'has spaces', clientName: 'X' }))).code).toBe('bad_request_local');
    expect((await refusal(() => service.writeContent(ROOM_ORIGIN, 'cmstandin0001', { files: [], remove: [] }))).code).toBe('bad_request_local');
    expect(room.calls).toEqual([]);
  });

  it('puts confirmLive and a status in a request only when the caller asks for them', async () => {
    const { room, service } = setup();
    const { room: deal } = await service.findOrCreate(ROOM_ORIGIN, { externalRef: 'patcher:deal:1', clientName: 'Larkfield Outfitters', facts: FACTS });
    await service.update(ROOM_ORIGIN, deal.id, { facts: { proposalVersion: 'v2' } });
    await service.writeContent(ROOM_ORIGIN, deal.id, { files: [{ path: 'overview.md', body: 'Hello.' }], remove: [] });
    expect(room.confirmed()).toEqual([]);
    expect(room.statusChanges()).toEqual([]);
    expect(room.calls.some((c) => c.body !== undefined && 'confirmLive' in c.body)).toBe(false);

    expect((await service.update(ROOM_ORIGIN, deal.id, { publish: true })).status).toBe('ACTIVE');
    expect(room.calls.at(-1)!.body).toEqual({ status: 'ACTIVE' });

    // Live now: refused without the confirmation, taken with it.
    expect(await refusal(() => service.writeContent(ROOM_ORIGIN, deal.id, { files: [{ path: 'overview.md', body: 'Changed.' }], remove: [] }))).toMatchObject({ status: 409, code: 'deal_not_draft', details: { status: 'ACTIVE' } });
    expect((await refusal(() => service.update(ROOM_ORIGIN, deal.id, { facts: { proposalVersion: 'v3' } }))).code).toBe('deal_not_draft');
    expect(room.shown(deal.id, 'overview.md')).toBe('Hello.');
    const written = await service.writeContent(ROOM_ORIGIN, deal.id, { files: [{ path: 'overview.md', body: 'Changed.' }], remove: [], confirmLive: true });
    expect(written.written).toEqual(['overview.md']);
    expect(room.calls.at(-1)!.body).toEqual({ files: [{ path: 'overview.md', body: 'Changed.' }], remove: [], confirmLive: true });
    await service.update(ROOM_ORIGIN, deal.id, { facts: { proposalVersion: 'v3' }, confirmLive: true });
    expect(room.confirmed()).toHaveLength(2);
  });

  it('keeps counts and drops the names the API answers with', async () => {
    const { room, service } = setup();
    const seeded = room.seed({ slug: 'larkfield', clientName: 'Larkfield Outfitters', status: 'ACTIVE', memberCount: 3, pendingInviteCount: 1, allowedEmailDomains: ['larkfield.example', 'partner.example'] });
    room.personWrites(seeded.id, 'overview.md', 'Written by a person.');
    const deal = await service.get(ROOM_ORIGIN, seeded.id);
    expect(deal).toMatchObject({ memberCount: 3, pendingInviteCount: 1, allowedEmailDomains: 2 });
    const content = await service.content(ROOM_ORIGIN, seeded.id);
    expect(content.files).toEqual([{ path: 'overview.md', kind: 'markdown', stored: true, inRepository: false, updatedBy: 'person' }]);
    expect(JSON.stringify([deal, content])).not.toMatch(/larkfield\.example|partner\.example|pat\.editor|@/);
  });

  it('says in words what the deal room refused, by its code, without the token', async () => {
    const { room, service } = setup();
    room.token = `another-${ROOM_TOKEN}`;
    const unauthorized = await refusal(() => service.list(ROOM_ORIGIN, {}));
    expect(unauthorized).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(unauthorized.message).toMatch(/DEALROOM_API_TOKEN on the worker must be the same value as OPS_BOT_TOKEN/);

    room.token = '';
    expect(await refusal(() => service.list(ROOM_ORIGIN, {}))).toMatchObject({ status: 503, code: 'not_configured', message: expect.stringMatching(/switched off/) });

    room.token = ROOM_TOKEN;
    expect(await refusal(() => service.get(ROOM_ORIGIN, 'cmnothere'))).toMatchObject({ status: 404, code: 'deal_not_found' });

    // An app that echoes the header back: the token is taken out of what is kept.
    room.failOn = { match: /^GET /, status: 422, body: { error: `Bad header "Bearer ${ROOM_TOKEN}".`, code: 'invalid_parameter', parameter: ROOM_TOKEN } };
    const echoed = await refusal(() => service.list(ROOM_ORIGIN, {}));
    expect(echoed.message).toBe('The deal room refused the request (invalid_parameter): Bad header "Bearer [token]".');
    expect(JSON.stringify([echoed.message, echoed.details])).not.toContain(ROOM_TOKEN);
  });

  it('treats a redirect, a page that is not the API, and a strange answer as failures', async () => {
    const { room, service } = setup();
    room.failOn = { match: /^GET /, status: 302, body: null };
    expect(await refusal(() => service.list(ROOM_ORIGIN, {}))).toMatchObject({ code: 'bad_response', message: expect.stringMatching(/redirect \(302\), which Patcher does not follow/) });
    room.failOn = { match: /^GET /, status: 404, body: { message: 'Not Found' } };
    expect((await refusal(() => service.list(ROOM_ORIGIN, {}))).message).toBe('The deal room answered 404 without a reason. Is the service API deployed at the address in Settings?');
    room.failOn = { match: /^GET /, status: 200, body: { deals: [{ id: 'x', slug: 'y' }] } };
    expect((await refusal(() => service.list(ROOM_ORIGIN, {}))).message).toMatch(/in a shape Patcher does not know/);

    const unreachable = createDealRoomService({ token: ROOM_TOKEN, fetch: () => Promise.reject(new Error(`connect failed with ${ROOM_TOKEN}`)) });
    const err = await refusal(() => unreachable.list(ROOM_ORIGIN, {}));
    expect(err).toMatchObject({ code: 'unreachable', message: 'The deal room could not be reached.' });
  });
});

describe('the service API client over a real connection', () => {
  /** The stand-in behind a local HTTP server, so the client's own `fetch` is the one that runs. */
  async function served() {
    const seen: { where: string; authorization: string | undefined }[] = [];
    const elsewhere = createServer((req, res) => {
      seen.push({ where: 'elsewhere', authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"deals":[]}');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    const away = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;

    const state: { room?: FakeDealRoom; redirect: boolean } = { redirect: false };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (state.redirect) {
          res.writeHead(307, { location: `${away}${req.url ?? ''}` }).end();
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
        const room = state.room!;
        void room.fetch(`${room.origin}${req.url ?? ''}`, { method: req.method, headers, ...(body ? { body } : {}) }).then(async (answer) => {
          res.writeHead(answer.status, { 'content-type': 'application/json' }).end(await answer.text());
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const room = (state.room = new FakeDealRoom(origin));
    const close = () => Promise.all([server, elsewhere].map((s) => new Promise((resolve) => s.close(resolve))));
    return { room, origin, seen, close, redirectNow: () => (state.redirect = true) };
  }

  it('creates, writes and publishes over HTTP, and does not carry the token along a redirect', async () => {
    const { room, origin, seen, close, redirectNow } = await served();
    try {
      // Plain http is for this machine only, and only outside production.
      expect((await refusal(() => createDealRoomService({ token: ROOM_TOKEN }).list(origin, {}))).code).toBe('bad_request_local');

      const service = createDealRoomService({ token: ROOM_TOKEN, allowLocalHttp: true });
      const adapter = createServiceAdapter(service);
      const found = await adapter.findDeal(origin, DEAL, FACTS);
      const written = await adapter.publish(origin, found, prepared(), { version: 1, facts: FACTS, confirm: null });
      expect(written).toMatchObject({ outcome: 'written', live: false });
      expect(room.only()).toMatchObject({ status: 'DRAFT', proposalVersion: 'v1' });
      expect(room.paths(found.room.id)).toEqual(['overview.md', 'proposal/01-summary.md', 'proposal/02-scope.md']);
      expect(room.calls.every((c) => c.authorized)).toBe(true);
      expect(await adapter.activate(origin, found.room.id)).toMatchObject({ changed: true, room: { status: 'ACTIVE' } });

      const wrong = createDealRoomService({ token: `wrong-${ROOM_TOKEN}`, allowLocalHttp: true });
      expect((await refusal(() => wrong.list(origin, {}))).code).toBe('unauthorized');

      redirectNow();
      const redirected = await refusal(() => service.get(origin, found.room.id));
      expect(redirected).toMatchObject({ status: 307, code: 'bad_response' });
      expect(redirected.message).not.toContain('127.0.0.1');
      // The other server was never asked anything, with or without the token.
      expect(seen).toEqual([]);
    } finally {
      await close();
    }
  });

  it('gives up on an address nothing answers at, without saying more than that', async () => {
    const { origin, close } = await served();
    await close();
    const service = createDealRoomService({ token: ROOM_TOKEN, allowLocalHttp: true, timeoutMs: 2000 });
    expect(await refusal(() => service.list(origin, {}))).toMatchObject({ status: 0, code: 'unreachable', message: 'The deal room could not be reached.' });
  });
});

describe('the write plan', () => {
  const files = prepared().files;
  const file = (path: string, overrides: Partial<RoomFile> = {}): RoomFile => ({ path, kind: path.endsWith('.json') ? 'json' : 'markdown', stored: true, inRepository: false, updatedBy: 'service', body: 'Old text.', ...overrides });

  it('adds every file to an empty room', () => {
    const plan = planWrite(files, []);
    expect(plan.files.map((f) => f.path)).toEqual(['overview.md', 'proposal/01-summary.md', 'proposal/02-scope.md']);
    expect(plan).toMatchObject({ remove: [], personEdits: [], leftAlone: [], repositoryStale: [], problems: [] });
    expect(plan.changes.every((c) => c.change === 'add' && c.by === null)).toBe(true);
  });

  it('sends nothing that is already there, replaces its own earlier files, and removes its own stale ones', () => {
    const plan = planWrite(files, [
      file('overview.md', { body: files[0]!.content }),
      file('proposal/01-summary.md'),
      file('proposal/03-pricing.md'),
      file('proposal/03-pricing.json', { body: '{}' }),
      file('proposal/02-scope.json', { body: '{}' }),
    ]);
    expect(plan.files.map((f) => f.path)).toEqual(['proposal/01-summary.md', 'proposal/02-scope.md']);
    // The visual goes with its section, and stays with a section that stays.
    expect(plan.remove).toEqual(['proposal/03-pricing.md', 'proposal/03-pricing.json']);
    expect(plan.personEdits).toEqual([]);
    expect(Object.fromEntries(plan.changes.map((c) => [c.path, c.change]))).toEqual({
      'overview.md': 'same',
      'proposal/01-summary.md': 'replace',
      'proposal/02-scope.json': 'keep',
      'proposal/02-scope.md': 'add',
      'proposal/03-pricing.json': 'remove',
      'proposal/03-pricing.md': 'remove',
    });
  });

  it('leaves a person\'s overview alone, and names every other file of a person it would replace or remove', () => {
    const plan = planWrite(files, [file('overview.md', { updatedBy: 'person' }), file('proposal/01-summary.md', { updatedBy: 'person' }), file('proposal/04-terms.md', { updatedBy: null })]);
    expect(plan.leftAlone).toEqual(['overview.md']);
    expect(plan.files.map((f) => f.path)).toEqual(['proposal/01-summary.md', 'proposal/02-scope.md']);
    // A stored file whose author is gone counts as a person's.
    expect(plan.personEdits).toEqual(['proposal/01-summary.md', 'proposal/04-terms.md']);
    expect(plan.remove).toEqual(['proposal/04-terms.md']);
  });

  it('cannot remove a section that lives in the repository, and stops when it would clash with a new one', () => {
    const fromRepo = { stored: false, inRepository: true, updatedBy: null };
    const kept = planWrite(files, [file('proposal/03-pricing.md', fromRepo)]);
    expect(kept).toMatchObject({ remove: [], repositoryStale: ['proposal/03-pricing.md'], problems: [] });

    const clash = planWrite(files, [file('proposal/05-scope.md', fromRepo)]);
    expect(clash.problems).toEqual([
      'Two section files would share the name "scope": proposal/05-scope.md, which is in the deal room repository, and proposal/02-scope.md. Delete the older file in the repository, or rename the section in the proposal.',
    ]);
  });

  it('has a hash that changes with what would be sent and whose text it replaces', () => {
    const empty = planWrite(files, []);
    expect(planWrite(files, []).hash).toBe(empty.hash);
    expect(planWrite(files, [file('proposal/01-summary.md', { updatedBy: 'person' })]).hash).not.toBe(empty.hash);
    expect(planWrite(files, [file('proposal/01-summary.md', { updatedBy: 'person' })]).hash).not.toBe(planWrite(files, [file('proposal/01-summary.md')]).hash);
  });
});

describe('the service API adapter', () => {
  it('creates a draft room under Patcher\'s reference, and finds the same room the next time', async () => {
    const { room, adapter } = setup();
    const first = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    expect(first).toMatchObject({ created: true, linked: false, room: { status: 'DRAFT', externalRef: externalRefFor(DEAL.id), slug: 'larkfield-outfitters', proposalVersion: 'v1' } });
    expect(room.calls[0]!.body).toEqual({ externalRef: `patcher:deal:${DEAL.id}`, clientName: 'Larkfield Outfitters', proposalVersion: 'v1', proposalUpdatedAt: '2026-11-10' });

    const again = await adapter.findDeal(ROOM_ORIGIN, { ...DEAL, company: 'Larkfield Outfitters Ltd' }, { proposalVersion: 'v2' });
    expect(again).toMatchObject({ created: false, linked: false, room: { id: first.room.id, clientName: 'Larkfield Outfitters', proposalVersion: 'v1' } });
    expect(room.deals.size).toBe(1);
  });

  it('writes a new draft in one request, sets the facts, and never asks for a status or confirmLive', async () => {
    const { room, adapter } = setup();
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    const result = await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm: null });
    expect(result).toMatchObject({ outcome: 'written', live: false, written: ['overview.md', 'proposal/01-summary.md', 'proposal/02-scope.md'], removed: [] });
    expect(sent(room)).toEqual(['POST /api/service/deals', `GET /api/service/deals/${found.room.id}/content?include=body`, `PUT /api/service/deals/${found.room.id}/content`]);
    expect(room.confirmed()).toEqual([]);
    expect(room.statusChanges()).toEqual([]);
    expect(room.only().status).toBe('DRAFT');
    expect(room.shown(found.room.id, 'proposal/01-summary.md')).toBe('---\ntitle: Summary\n---\n\nA sync into billing.\n');
    if (result.outcome !== 'written') throw new Error('not written');
    expect(result.manualSteps.join(' ')).toMatch(/new draft with no members, invites or client domains/);
  });

  it('writes the next version over its own files, removes a section that is gone, and sends nothing that is unchanged', async () => {
    const { room, adapter } = setup();
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm: null });
    const next = await adapter.findDeal(ROOM_ORIGIN, DEAL, { proposalVersion: 'v2', proposalUpdatedAt: '2026-11-12' });
    const v2 = prepared(['# Order sync for Larkfield', '', '## Summary', '', 'A sync into billing.', '', '## Timeline', '', 'Six weeks.'].join('\n'));
    const result = await adapter.publish(ROOM_ORIGIN, next, v2, { version: 2, facts: { proposalVersion: 'v2', proposalUpdatedAt: '2026-11-12' }, confirm: null });
    expect(result).toMatchObject({ outcome: 'written', written: ['proposal/02-timeline.md'], removed: ['proposal/02-scope.md'] });
    expect(room.calls.filter((c) => c.method === 'PUT').at(-1)!.body).toEqual({ files: [{ path: 'proposal/02-timeline.md', body: '---\ntitle: Timeline\n---\n\nSix weeks.\n' }], remove: ['proposal/02-scope.md'] });
    expect(room.only()).toMatchObject({ proposalVersion: 'v2', proposalUpdatedAt: '2026-11-12', status: 'DRAFT' });
    expect(room.paths(found.room.id)).toEqual(['overview.md', 'proposal/01-summary.md', 'proposal/02-timeline.md']);
  });

  it('holds everything for a room that is not a draft, and writes with confirmLive only for the status and audience a person confirmed', async () => {
    const { room, adapter } = setup();
    const live = room.seed({ slug: 'larkfield', clientName: 'Larkfield Outfitters', status: 'ACTIVE', externalRef: externalRefFor(DEAL.id), memberCount: 2, allowedEmailDomains: ['larkfield.example'] });
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    expect(found).toMatchObject({ created: false, room: { status: 'ACTIVE' } });

    const held = await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm: null });
    expect(held).toMatchObject({ outcome: 'held', reasons: ['live'] });
    expect(room.writes().map((c) => c.method)).toEqual(['POST']);
    expect(room.paths(live.id)).toEqual([]);

    // A confirmation for another status, or for another audience, does not count.
    const plan = held.plan.hash;
    for (const confirm of [
      { status: 'DRAFT' as const, planHash: plan, audience: audience(2, 0, 1) },
      { status: 'CLOSED' as const, planHash: plan, audience: audience(2, 0, 1) },
      { status: 'ACTIVE' as const, planHash: plan, audience: audience(1, 0, 1) },
      { status: 'ACTIVE' as const, planHash: plan, audience: audience(2, 0, 0) },
    ]) {
      expect((await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm })).outcome).toBe('held');
    }
    expect(room.confirmed()).toEqual([]);

    const written = await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm: { status: 'ACTIVE', planHash: plan, audience: audience(2, 0, 1) } });
    expect(written).toMatchObject({ outcome: 'written', live: true, written: ['overview.md', 'proposal/01-summary.md', 'proposal/02-scope.md'] });
    // Both the content and the facts carried the confirmation; the status was never sent.
    expect(room.confirmed().map((c) => c.method)).toEqual(['PUT', 'PATCH']);
    expect(room.statusChanges()).toEqual([]);
    expect(room.only()).toMatchObject({ status: 'ACTIVE', proposalVersion: 'v1' });
  });

  it('holds a draft whose files a person edited until that plan is confirmed, and then sends no confirmLive', async () => {
    const { room, adapter } = setup();
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm: null });
    room.personWrites(found.room.id, 'proposal/01-summary.md', 'A person rewrote this.');
    room.personWrites(found.room.id, 'overview.md', 'A person wrote the overview.');

    const edited = prepared(PROPOSAL.replace('A sync into billing.', 'A sync into billing, in two phases.'));
    const held = await adapter.publish(ROOM_ORIGIN, found, edited, { version: 2, facts: FACTS, confirm: null });
    expect(held).toMatchObject({ outcome: 'held', reasons: ['edited'], plan: { personEdits: ['proposal/01-summary.md'], leftAlone: ['overview.md'] } });
    expect(room.shown(found.room.id, 'proposal/01-summary.md')).toBe('A person rewrote this.');

    // The person edits again after being asked: the confirmation was for another plan.
    room.personWrites(found.room.id, 'proposal/02-scope.md', 'Also rewritten.');
    const stale = await adapter.publish(ROOM_ORIGIN, found, edited, { version: 2, facts: FACTS, confirm: { status: 'DRAFT', planHash: held.plan.hash, audience: audience() } });
    expect(stale).toMatchObject({ outcome: 'held', reasons: ['edited'], plan: { personEdits: ['proposal/01-summary.md', 'proposal/02-scope.md'] } });

    const written = await adapter.publish(ROOM_ORIGIN, found, edited, { version: 2, facts: FACTS, confirm: { status: 'DRAFT', planHash: stale.plan.hash, audience: audience() } });
    expect(written).toMatchObject({ outcome: 'written', live: false, written: ['proposal/01-summary.md', 'proposal/02-scope.md'] });
    // The person's overview is still theirs.
    expect(room.shown(found.room.id, 'overview.md')).toBe('A person wrote the overview.');
    expect(room.confirmed()).toEqual([]);
  });

  it('writes nothing when a person publishes the room between the read and the write', async () => {
    const { room, adapter } = setup();
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    room.before = { match: /^PUT /, run: () => (room.only().status = 'ACTIVE') };
    const result = await adapter.publish(ROOM_ORIGIN, found, prepared(), { version: 1, facts: FACTS, confirm: null });
    expect(result).toMatchObject({ outcome: 'held', reasons: ['live'], room: { status: 'ACTIVE' } });
    expect(room.paths(found.room.id)).toEqual([]);
    expect(room.confirmed()).toEqual([]);
  });

  it('links a room a person made only when a person saved its slug on the deal and it has no reference', async () => {
    const { room, adapter } = setup();
    const handmade = room.seed({ slug: 'larkfield-outfitters', clientName: 'Larkfield', status: 'ACTIVE', memberCount: 4 });

    // No slug saved: the slug the app would pick is taken, and nothing is linked.
    const untold = await refusal(() => adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS));
    expect(untold.message).toMatch(/already has a room at "larkfield-outfitters" \(Larkfield Dealroom, ACTIVE\) that is not linked to this deal/);
    expect(untold.message).toMatch(/save "larkfield-outfitters" as the slug on the deal in Patcher/);
    expect(room.only().externalRef).toBeNull();

    const linked = await adapter.findDeal(ROOM_ORIGIN, { ...DEAL, dealRoomSlug: 'larkfield-outfitters' }, FACTS);
    expect(linked).toMatchObject({ created: false, linked: true, room: { id: handmade.id, status: 'ACTIVE', externalRef: externalRefFor(DEAL.id), proposalVersion: null } });
    // Linking sent the reference alone: no facts, no status, no confirmLive.
    expect(room.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { externalRef: externalRefFor(DEAL.id) } });
    expect(room.confirmed()).toEqual([]);
    expect(room.deals.size).toBe(1);
  });

  it('never takes over a room that belongs to another deal, and creates with the saved slug when it is free', async () => {
    const { room, adapter } = setup();
    room.seed({ slug: 'larkfield', clientName: 'Larkfield', externalRef: 'patcher:deal:someone-else' });
    const taken = await refusal(() => adapter.findDeal(ROOM_ORIGIN, { ...DEAL, dealRoomSlug: 'larkfield' }, FACTS));
    expect(taken.message).toBe('The room "larkfield" (Larkfield Dealroom, DRAFT) is linked to another deal, so nothing was written. Save a different slug on the deal in Patcher.');
    expect(room.bySlug('larkfield').externalRef).toBe('patcher:deal:someone-else');

    const made = await adapter.findDeal(ROOM_ORIGIN, { ...DEAL, dealRoomSlug: 'larkfield-2026' }, FACTS);
    expect(made).toMatchObject({ created: true, room: { slug: 'larkfield-2026', status: 'DRAFT' } });

    await expect(adapter.findDeal(ROOM_ORIGIN, { ...DEAL, id: '0b1c2d3e-0000-4000-8000-000000000002', dealRoomSlug: 'admin' }, FACTS)).rejects.toThrow(/one the deal room uses itself/);
    await expect(adapter.findDeal(ROOM_ORIGIN, { ...DEAL, id: '0b1c2d3e-0000-4000-8000-000000000002', dealRoomSlug: 'two--dashes' }, FACTS)).rejects.toThrow(/not one the deal room accepts/);
  });

  it('publishes a draft with the status alone, and changes nothing in a room that is not a draft', async () => {
    const { room, adapter } = setup();
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    const before = room.calls.length;
    expect(await adapter.activate(ROOM_ORIGIN, found.room.id)).toMatchObject({ changed: true, room: { status: 'ACTIVE' } });
    expect(room.calls.slice(before).map((c) => [c.method, c.body])).toEqual([
      ['GET', undefined],
      ['PATCH', { status: 'ACTIVE' }],
    ]);
    expect(await adapter.activate(ROOM_ORIGIN, found.room.id)).toMatchObject({ changed: false, room: { status: 'ACTIVE' } });
    room.only().status = 'CLOSED';
    expect(await adapter.activate(ROOM_ORIGIN, found.room.id)).toMatchObject({ changed: false, room: { status: 'CLOSED' } });
    expect(room.statusChanges()).toHaveLength(1);

    expect(await adapter.check(ROOM_ORIGIN, 'cmnothere')).toBeNull();
  });

  it('refuses files that failed their checks, before anything is read', async () => {
    const { room, adapter } = setup();
    const found = await adapter.findDeal(ROOM_ORIGIN, DEAL, FACTS);
    const before = room.calls.length;
    await expect(adapter.publish(ROOM_ORIGIN, found, prepared('# No sections here'), { version: 1, facts: FACTS, confirm: null })).rejects.toThrow(/were not written/);
    expect(room.calls).toHaveLength(before);
  });
});
