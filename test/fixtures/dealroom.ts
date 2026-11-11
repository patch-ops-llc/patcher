/**
 * A stand-in for the deal room's service API, written from its contract (the six routes
 * under `/api/service/deals`, their bearer auth, their shapes and their error codes). It
 * keeps deals and content in memory and records every request. Nothing here is the real
 * deal room: the company, the address and the token are made up.
 *
 * It follows the contract's rules that matter to the adapter:
 *   - every request needs the bearer token (401 `unauthorized`), or 503 `not_configured`;
 *   - create is find-or-create by `externalRef`, always a DRAFT, and a repeat applies nothing;
 *   - a taken slug is refused with `slug_taken` and the existing deal, never suffixed;
 *   - facts and content on a deal that is not a DRAFT need `confirmLive: true`
 *     (409 `deal_not_draft`); setting `externalRef` alone and publishing alone do not;
 *   - the only status change is DRAFT to ACTIVE;
 *   - content is one all-or-nothing batch with the contract's path rules.
 *
 * Anything else answers 404 with no code, so a request the client should not make fails.
 */
export const ROOM_ORIGIN = 'https://dealroom.example';
/** Made up for the tests. It opens nothing. */
export const ROOM_TOKEN = 'stand-in-dealroom-token-0123456789abcdef';

export type FakeStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';

export interface FakeDeal {
  id: string;
  slug: string;
  externalRef: string | null;
  name: string;
  clientName: string;
  status: FakeStatus;
  proposalVersion: string | null;
  proposalUpdatedAt: string | null;
  partnerName: string | null;
  partnerLogoUrl: string | null;
  kickoffTarget: string | null;
  goLiveTarget: string | null;
  investment: string | null;
  allowedEmailDomains: string[];
  hiddenPages: string[];
  memberCount: number;
  pendingInviteCount: number;
  createdAt: string;
}

interface Stored {
  body: string;
  updatedAt: string;
  by: 'service' | 'person' | null;
}

export interface RoomCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  /** Whether the request carried the right bearer token. The token itself is not kept. */
  authorized: boolean;
  redirect: string | undefined;
}

const RESERVED = ['new', 'admin', 'api', 'login', 'signup', 'account', 'invite', 'auth'];
const SLUG = /^(?=.{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const FIXED_PATHS = ['overview.md', 'team.md', 'architecture.json', 'why-not-hubspot.md', 'maintenance.json', 'security.md', 'questions.md'];
const SECTION = /^proposal\/\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*)\.(md|json)$/;
const FACTS = ['name', 'clientName', 'proposalVersion', 'proposalUpdatedAt', 'partnerName', 'partnerLogoUrl', 'kickoffTarget', 'goLiveTarget', 'investment'] as const;
type Fact = (typeof FACTS)[number];
const LIMITS: Record<Fact, number> = { name: 200, clientName: 200, proposalVersion: 40, proposalUpdatedAt: 10, partnerName: 200, partnerLogoUrl: 500, kickoffTarget: 200, goLiveTarget: 200, investment: 200 };

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export class FakeDealRoom {
  calls: RoomCall[] = [];
  deals = new Map<string, FakeDeal>();
  /** Content the app's database holds, per deal and path. */
  stored = new Map<string, Map<string, Stored>>();
  /** Content files in the app's repository, per deal and path. */
  repository = new Map<string, Map<string, string>>();
  /** The token the app was given. Empty: the service API is switched off (503). */
  token: string = ROOM_TOKEN;
  /** Fails the next request whose method and path match, once. */
  failOn: { match: RegExp; status: number; body: unknown } | undefined;
  /** Runs once, just before the next request that matches is handled: something a person did meanwhile. */
  before: { match: RegExp; run: () => void } | undefined;
  private counter = 0;
  private clock = Date.parse('2026-11-11T09:00:00.000Z');

  constructor(readonly origin = ROOM_ORIGIN) {}

  /** Requests that could change something. */
  writes(): RoomCall[] {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  /** Every request body that carried `confirmLive: true`. */
  confirmed(): RoomCall[] {
    return this.calls.filter((c) => c.body?.confirmLive === true);
  }

  /** Every request that asked for a status. */
  statusChanges(): RoomCall[] {
    return this.calls.filter((c) => c.body !== undefined && 'status' in c.body);
  }

  only(): FakeDeal {
    if (this.deals.size !== 1) throw new Error(`expected one deal in the stand-in, found ${this.deals.size}`);
    return [...this.deals.values()][0]!;
  }

  bySlug(slug: string): FakeDeal {
    const found = [...this.deals.values()].find((d) => d.slug === slug);
    if (!found) throw new Error(`no deal "${slug}" in the stand-in`);
    return found;
  }

  /** A room a person made in the deal room admin. */
  seed(input: Partial<FakeDeal> & { slug: string; clientName: string }): FakeDeal {
    const deal = this.blank({ ...input, name: input.name ?? `${input.clientName} Dealroom` });
    this.deals.set(deal.id, deal);
    return deal;
  }

  /** What a person saved in Deal Admin. */
  personWrites(dealId: string, path: string, body: string): void {
    this.contentOf(dealId).set(path, { body, updatedAt: this.now(), by: 'person' });
  }

  /** A content file that lives in the app's repository. */
  inRepository(dealId: string, path: string, body: string): void {
    const files = this.repository.get(dealId) ?? new Map<string, string>();
    files.set(path, body);
    this.repository.set(dealId, files);
  }

  /** The text the room shows at a path: stored content first, then the repository's. */
  shown(dealId: string, path: string): string | undefined {
    return this.contentOf(dealId).get(path)?.body ?? this.repository.get(dealId)?.get(path);
  }

  paths(dealId: string): string[] {
    return [...new Set([...this.contentOf(dealId).keys(), ...(this.repository.get(dealId)?.keys() ?? [])])].sort();
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private blank(input: Partial<FakeDeal> & { slug: string; clientName: string; name: string }): FakeDeal {
    return {
      id: `cmstandin${String(++this.counter).padStart(4, '0')}`,
      externalRef: null,
      status: 'DRAFT',
      proposalVersion: null,
      proposalUpdatedAt: null,
      partnerName: null,
      partnerLogoUrl: null,
      kickoffTarget: null,
      goLiveTarget: null,
      investment: null,
      allowedEmailDomains: [],
      hiddenPages: [],
      memberCount: 0,
      pendingInviteCount: 0,
      createdAt: this.now(),
      ...input,
    };
  }

  private contentOf(dealId: string): Map<string, Stored> {
    const found = this.stored.get(dealId) ?? new Map<string, Stored>();
    this.stored.set(dealId, found);
    return found;
  }

  private json(deal: FakeDeal) {
    return { ...deal, url: `${this.origin}/deals/${deal.slug}` };
  }

  private fact(field: Fact, value: unknown): string | null {
    const required = field === 'name' || field === 'clientName';
    if (value === null || value === '') {
      if (required) throw new Refusal(422, 'invalid_field', { field });
      return null;
    }
    if (typeof value !== 'string') throw new Refusal(422, 'invalid_field', { field });
    const text = value.trim();
    if (!text || /[\r\n]/.test(text) || text.length > LIMITS[field]) throw new Refusal(422, 'invalid_field', { field });
    if (field === 'proposalUpdatedAt') {
      const date = new Date(`${text}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Refusal(422, 'invalid_field', { field });
    }
    if (field === 'partnerLogoUrl' && !/^https:\/\/\S+$/.test(text)) throw new Refusal(422, 'invalid_field', { field });
    return text;
  }

  private find(id: string): FakeDeal {
    const deal = this.deals.get(id);
    if (!deal) throw new Refusal(404, 'deal_not_found');
    return deal;
  }

  private list(query: URLSearchParams) {
    for (const [key, value] of query) {
      if (!['slug', 'externalRef', 'clientName'].includes(key)) throw new Refusal(422, 'unknown_parameter', { parameter: key });
      if (!value) throw new Refusal(422, 'invalid_parameter', { parameter: key });
    }
    const slug = query.get('slug')?.toLowerCase();
    const ref = query.get('externalRef');
    const client = query.get('clientName')?.toLowerCase();
    const deals = [...this.deals.values()].filter(
      (d) => (slug === undefined || d.slug === slug) && (ref === null || d.externalRef === ref) && (client === undefined || d.clientName.toLowerCase() === client),
    );
    return { status: 200, body: { deals: deals.map((d) => this.json(d)) } };
  }

  private create(body: Record<string, unknown>) {
    for (const key of Object.keys(body)) {
      if (['status', 'allowedEmailDomains', 'hiddenPages'].includes(key)) throw new Refusal(422, 'field_not_allowed', { field: key });
      if (!['externalRef', 'slug', ...FACTS].includes(key)) throw new Refusal(422, 'unknown_field', { field: key });
    }
    if (typeof body.externalRef !== 'string' || !REF.test(body.externalRef)) throw new Refusal(422, 'invalid_field', { field: 'externalRef' });
    const existing = [...this.deals.values()].find((d) => d.externalRef === body.externalRef);
    if (existing) return { status: 200, body: { deal: this.json(existing), created: false } };

    const clientName = this.fact('clientName', body.clientName ?? null)!;
    const facts: Partial<Record<Fact, string | null>> = {};
    for (const field of FACTS) if (field in body) facts[field] = this.fact(field, body[field]);
    let slug: string;
    if (body.slug === undefined) {
      slug = slugOf(clientName);
      if (!SLUG.test(slug)) throw new Refusal(422, 'invalid_field', { field: 'slug' });
    } else {
      if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) throw new Refusal(422, 'invalid_field', { field: 'slug' });
      slug = body.slug;
    }
    if (RESERVED.includes(slug)) throw new Refusal(422, 'slug_reserved', { slug });
    const holder = [...this.deals.values()].find((d) => d.slug === slug);
    if (holder) {
      throw new Refusal(409, 'slug_taken', {
        slug,
        existing: { id: holder.id, slug: holder.slug, externalRef: holder.externalRef, name: holder.name, clientName: holder.clientName, status: holder.status },
      });
    }
    const deal = this.blank({ ...facts, slug, clientName, name: (facts.name as string | undefined) ?? `${clientName} Dealroom`, externalRef: body.externalRef });
    this.deals.set(deal.id, deal);
    return { status: 201, body: { deal: this.json(deal), created: true } };
  }

  private patch(deal: FakeDeal, body: Record<string, unknown>) {
    for (const key of Object.keys(body)) {
      if (['slug', 'allowedEmailDomains', 'hiddenPages'].includes(key)) throw new Refusal(422, 'field_not_allowed', { field: key });
      if (!['externalRef', 'status', 'confirmLive', ...FACTS].includes(key)) throw new Refusal(422, 'unknown_field', { field: key });
    }
    if ('confirmLive' in body && typeof body.confirmLive !== 'boolean') throw new Refusal(422, 'invalid_field', { field: 'confirmLive' });
    const facts: Partial<Record<Fact, string | null>> = {};
    for (const field of FACTS) if (field in body) facts[field] = this.fact(field, body[field]);
    let ref: string | undefined;
    if ('externalRef' in body) {
      if (typeof body.externalRef !== 'string' || !REF.test(body.externalRef)) throw new Refusal(422, 'invalid_field', { field: 'externalRef' });
      if (deal.externalRef !== null && deal.externalRef !== body.externalRef) throw new Refusal(409, 'external_ref_already_set', { externalRef: deal.externalRef });
      if ([...this.deals.values()].some((d) => d.id !== deal.id && d.externalRef === body.externalRef)) throw new Refusal(409, 'external_ref_taken', { externalRef: body.externalRef });
      ref = body.externalRef;
    }
    let publish = false;
    if ('status' in body) {
      if (typeof body.status !== 'string' || !['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'].includes(body.status)) throw new Refusal(422, 'invalid_field', { field: 'status' });
      if (body.status !== deal.status) {
        if (!(deal.status === 'DRAFT' && body.status === 'ACTIVE')) throw new Refusal(409, 'status_change_not_allowed', { status: deal.status });
        publish = true;
      }
    }
    if (Object.keys(facts).length && deal.status !== 'DRAFT' && body.confirmLive !== true) throw new Refusal(409, 'deal_not_draft', { status: deal.status });
    Object.assign(deal, facts);
    if (ref !== undefined) deal.externalRef = ref;
    if (publish) deal.status = 'ACTIVE';
    return { status: 200, body: { deal: this.json(deal) } };
  }

  private files(deal: FakeDeal, bodies: boolean) {
    const stored = this.contentOf(deal.id);
    const repo = this.repository.get(deal.id) ?? new Map<string, string>();
    return this.paths(deal.id).map((path) => {
      const held = stored.get(path);
      return {
        path,
        kind: path.endsWith('.json') ? 'json' : 'markdown',
        stored: held !== undefined,
        inRepository: repo.has(path),
        updatedAt: held?.updatedAt ?? null,
        // The contract returns the author's address; the adapter must not keep it.
        updatedBy: held?.by ? { kind: held.by, email: held.by === 'service' ? 'ops-bot@dealroom.invalid' : 'pat.editor@agency.example' } : null,
        ...(bodies ? { body: held?.body ?? repo.get(path) ?? '' } : {}),
      };
    });
  }

  private sections(deal: FakeDeal) {
    return this.paths(deal.id)
      .filter((path) => SECTION.test(path) && path.endsWith('.md'))
      .map((path) => {
        const key = SECTION.exec(path)![1]!;
        const title = /^---\ntitle: (.+)\n---/.exec(this.shown(deal.id, path) ?? '')?.[1] ?? key;
        return { key, title, path, url: `${this.origin}/deals/${deal.slug}/proposal/${key}` };
      });
  }

  private readContent(deal: FakeDeal, query: URLSearchParams) {
    const include = query.get('include');
    if (include !== null && include !== 'body') throw new Refusal(422, 'invalid_parameter', { parameter: 'include' });
    return { status: 200, body: { files: this.files(deal, include === 'body'), proposalSections: this.sections(deal) } };
  }

  private writeContent(deal: FakeDeal, body: Record<string, unknown>) {
    for (const key of Object.keys(body)) if (!['files', 'remove', 'confirmLive'].includes(key)) throw new Refusal(422, 'unknown_field', { field: key });
    if ('confirmLive' in body && typeof body.confirmLive !== 'boolean') throw new Refusal(422, 'invalid_field', { field: 'confirmLive' });
    const files = body.files ?? [];
    const remove = body.remove ?? [];
    if (!Array.isArray(files)) throw new Refusal(422, 'invalid_field', { field: 'files' });
    if (!Array.isArray(remove)) throw new Refusal(422, 'invalid_field', { field: 'remove' });
    const writes: { path: string; body: string }[] = [];
    files.forEach((entry: unknown, index) => {
      const file = entry as Record<string, unknown> | null;
      if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.body !== 'string' || Object.keys(file).length !== 2) {
        throw new Refusal(422, 'invalid_field', { field: `files[${index}]` });
      }
      writes.push({ path: file.path, body: file.body });
    });
    remove.forEach((entry: unknown, index) => {
      if (typeof entry !== 'string') throw new Refusal(422, 'invalid_field', { field: `remove[${index}]` });
    });
    const removes = remove as string[];
    const named = [...writes.map((w) => w.path), ...removes];
    if (!named.length) throw new Refusal(422, 'empty_request');
    if (named.length > 100) throw new Refusal(422, 'too_many_files');
    const seen = new Set<string>();
    for (const path of named) {
      if (path.length > 120 || !(FIXED_PATHS.includes(path) || SECTION.test(path))) throw new Refusal(422, 'path_not_allowed', { path });
      if (seen.has(path)) throw new Refusal(422, 'duplicate_path', { path });
      seen.add(path);
    }
    for (const file of writes) {
      if (!file.body.trim()) throw new Refusal(422, 'empty_body', { path: file.path });
      if (file.body.length > 400_000) throw new Refusal(422, 'body_too_long', { path: file.path });
      if (file.path.endsWith('.json')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(file.body);
        } catch {
          parsed = undefined;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Refusal(422, 'invalid_json', { path: file.path });
      }
    }
    if (deal.status !== 'DRAFT' && body.confirmLive !== true) throw new Refusal(409, 'deal_not_draft', { status: deal.status });

    // What the deal would have after the request, to check before anything is applied.
    const stored = this.contentOf(deal.id);
    const repo = this.repository.get(deal.id) ?? new Map<string, string>();
    const after = new Set([...stored.keys(), ...repo.keys(), ...writes.map((w) => w.path)]);
    for (const path of removes) if (!repo.has(path)) after.delete(path);
    for (const file of writes) {
      if (SECTION.test(file.path) && file.path.endsWith('.json') && !after.has(file.path.replace(/\.json$/, '.md'))) throw new Refusal(422, 'visual_without_section', { path: file.path });
    }
    const keys = new Map<string, string[]>();
    for (const path of [...after].sort()) {
      const match = SECTION.exec(path);
      if (match && match[2] === 'md') keys.set(match[1]!, [...(keys.get(match[1]!) ?? []), path]);
    }
    for (const [key, paths] of keys) if (paths.length > 1) throw new Refusal(409, 'section_key_conflict', { key, paths });

    const written: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];
    for (const file of writes) {
      if (stored.get(file.path)?.body === file.body) {
        unchanged.push(file.path);
        continue;
      }
      stored.set(file.path, { body: file.body, updatedAt: this.now(), by: 'service' });
      written.push(file.path);
    }
    for (const path of removes) if (stored.delete(path)) removed.push(path);
    return { status: 200, body: { written, unchanged, removed, files: this.files(deal, false), proposalSections: this.sections(deal) } };
  }

  fetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const path = `${url.pathname}${url.search}`;
    let body: Record<string, unknown> | undefined;
    let badJson = false;
    if (typeof init?.body === 'string') {
      try {
        const parsed: unknown = JSON.parse(init.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        else badJson = true;
      } catch {
        badJson = true;
      }
    }
    const authorized = this.token.length >= 32 && headers.get('authorization') === `Bearer ${this.token}`;
    this.calls.push({ method, path, body, authorized, redirect: init?.redirect });
    const reply = (status: number, json: unknown, extra: Record<string, string> = {}) =>
      Promise.resolve(new Response(json === null ? null : JSON.stringify(json), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } }));
    const refuse = (status: number, code: string, details: Record<string, unknown> = {}) => reply(status, { error: `Stand-in refusal: ${code}.`, code, ...details });

    if (url.origin !== this.origin) return reply(404, { message: 'no such host in the stand-in' });
    const key = `${method} ${path}`;
    if (this.failOn?.match.test(key)) {
      const { status, body: failBody } = this.failOn;
      this.failOn = undefined;
      return reply(status, failBody);
    }
    if (this.token.length < 32) return refuse(503, 'not_configured');
    if (!authorized) return refuse(401, 'unauthorized');
    if (this.before?.match.test(key)) {
      const { run } = this.before;
      this.before = undefined;
      run();
    }

    const route = /^\/api\/service\/deals(?:\/([^/]+))?(\/content)?$/.exec(url.pathname);
    if (!route) return reply(404, { message: 'Not Found' });
    const [, id, content] = route;
    if (init?.body !== undefined && badJson) return refuse(400, 'bad_request');
    if (typeof init?.body === 'string' && init.body.length > 2_000_000) return refuse(413, 'body_too_large');
    try {
      let answer: { status: number; body: unknown };
      if (!id && method === 'GET') answer = this.list(url.searchParams);
      else if (!id && method === 'POST') answer = this.create(body ?? {});
      else if (id && !content && method === 'GET') answer = { status: 200, body: { deal: this.json(this.find(id)) } };
      else if (id && !content && method === 'PATCH') answer = this.patch(this.find(id), body ?? {});
      else if (id && content && method === 'GET') answer = this.readContent(this.find(id), url.searchParams);
      else if (id && content && method === 'PUT') answer = this.writeContent(this.find(id), body ?? {});
      else return reply(404, { message: 'Not Found' });
      return reply(answer.status, answer.body);
    } catch (err) {
      if (err instanceof Refusal) return refuse(err.status, err.code, err.details);
      throw err;
    }
  };
}
