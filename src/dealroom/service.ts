import { z } from 'zod';
import { parseRoomOrigin } from './origin.js';

/**
 * The deal room's service API, and nothing else of the app: the six routes under
 * `/api/service/deals`. It can read deals, find or create one by Patcher's own reference,
 * change the facts the Overview shows, write and remove content files, and move a draft to
 * active. It has no method for members, invites, allowed domains or hidden pages, because
 * the API has none.
 *
 * Two things are decided by the caller and never here:
 *   - `confirmLive` is sent only when the caller passes `confirmLive: true`. No method adds it.
 *   - a status change is sent only by `update(..., { publish: true })`.
 *
 * The token is sent as a bearer header to the one address the caller names, which must be a
 * plain https origin. It is never put in a URL, an error or a log line; anything the app
 * answers is scrubbed of it before it is kept.
 */
export const ROOM_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** A deal's id in the app. It goes into a URL path, so its shape is checked. */
export const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The app's rule for a slug: lower-case letters and digits, single hyphens between them. */
export const ROOM_SLUG = /^(?=.{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_SLUGS: readonly string[] = ['new', 'admin', 'api', 'login', 'signup', 'account', 'invite', 'auth'];
/** The app's rule for an external reference. */
export const EXTERNAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const MAX_REQUEST_CHARS = 2_000_000;
const MAX_RESPONSE_CHARS = 8_000_000;
export const MAX_PATHS = 100;

export interface Room {
  id: string;
  slug: string;
  externalRef: string | null;
  name: string;
  clientName: string;
  status: RoomStatus;
  proposalVersion: string | null;
  proposalUpdatedAt: string | null;
  /** People who can open the room once it is active. Counts only: the API returns no names. */
  memberCount: number;
  pendingInviteCount: number;
  allowedEmailDomains: number;
  url: string;
}

export type Author = 'service' | 'person';

export interface RoomFile {
  path: string;
  kind: 'markdown' | 'json';
  /** The app's database holds content for the path. That is what the room shows. */
  stored: boolean;
  inRepository: boolean;
  /** Who last wrote the stored content. Null when nothing is stored, or the author is gone. */
  updatedBy: Author | null;
  body?: string;
}

export interface RoomSection {
  key: string;
  title: string;
  path: string;
}

export interface RoomContent {
  files: RoomFile[];
  sections: RoomSection[];
}

export interface WriteResult extends RoomContent {
  written: string[];
  unchanged: string[];
  removed: string[];
}

/** The facts the Overview shows that Patcher sets. The API accepts more; Patcher writes only these. */
export interface RoomFacts {
  proposalVersion?: string;
  proposalUpdatedAt?: string;
}

export class DealRoomServiceError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when no answer came. */
    readonly status: number,
    /** The API's stable code, or one of this client's own: `unreachable`, `bad_response`, `bad_request_local`. */
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DealRoomServiceError';
  }
}

export interface DealRoomService {
  list(origin: string, filter: { slug?: string; externalRef?: string; clientName?: string }): Promise<Room[]>;
  /** Safe to repeat. A deal that already has the reference is returned as it is, and the fields are not applied. */
  findOrCreate(origin: string, input: { externalRef: string; clientName: string; slug?: string; facts?: RoomFacts }): Promise<{ room: Room; created: boolean }>;
  get(origin: string, id: string): Promise<Room>;
  update(origin: string, id: string, change: { facts?: RoomFacts; externalRef?: string; publish?: true; confirmLive?: true }): Promise<Room>;
  content(origin: string, id: string, options?: { bodies?: boolean }): Promise<RoomContent>;
  writeContent(origin: string, id: string, input: { files: { path: string; body: string }[]; remove: string[]; confirmLive?: true }): Promise<WriteResult>;
}

export interface DealRoomServiceOptions {
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Development only: lets `http://localhost` through. */
  allowLocalHttp?: boolean;
}

const text = z.string().max(2000);
const count = z.number().int().min(0).max(1_000_000);

const roomSchema = z
  .object({
    id: z.string().regex(ROOM_ID),
    slug: z.string().min(1).max(100),
    externalRef: text.nullable(),
    name: text,
    clientName: text,
    status: z.enum(ROOM_STATUSES),
    proposalVersion: text.nullish(),
    proposalUpdatedAt: text.nullish(),
    memberCount: count,
    pendingInviteCount: count,
    allowedEmailDomains: z.array(z.unknown()).max(10_000),
    url: text,
  })
  .transform(
    (r): Room => ({
      id: r.id,
      slug: r.slug,
      externalRef: r.externalRef,
      name: r.name,
      clientName: r.clientName,
      status: r.status,
      proposalVersion: r.proposalVersion ?? null,
      proposalUpdatedAt: r.proposalUpdatedAt ?? null,
      memberCount: r.memberCount,
      pendingInviteCount: r.pendingInviteCount,
      // The domains themselves say who the client is. Only how many there are is kept.
      allowedEmailDomains: r.allowedEmailDomains.length,
      url: r.url,
    }),
  );

const fileSchema = z
  .object({
    path: z.string().min(1).max(200),
    kind: z.enum(['markdown', 'json']),
    stored: z.boolean(),
    inRepository: z.boolean(),
    updatedBy: z.object({ kind: z.string() }).nullish(),
    body: z.string().optional(),
  })
  .transform(
    (f): RoomFile => ({
      path: f.path,
      kind: f.kind,
      stored: f.stored,
      inRepository: f.inRepository,
      // The author's address is in the answer and is dropped here: only whether it was the bot.
      updatedBy: f.updatedBy ? (f.updatedBy.kind === 'service' ? 'service' : 'person') : null,
      ...(f.body === undefined ? {} : { body: f.body }),
    }),
  );

const sectionSchema = z.object({ key: z.string().max(200), title: z.string().max(500), path: z.string().max(200) }).transform((s): RoomSection => ({ key: s.key, title: s.title, path: s.path }));
const contentSchema = z.object({ files: z.array(fileSchema).max(2000), proposalSections: z.array(sectionSchema).max(2000) });
const paths = z.array(z.string().max(200)).max(MAX_PATHS);
const writeSchema = contentSchema.extend({ written: paths, unchanged: paths, removed: paths });

const SENTENCES: Record<string, string> = {
  unauthorized: 'The deal room refused the bot token. DEALROOM_API_TOKEN on the worker must be the same value as OPS_BOT_TOKEN on the deal room.',
  not_configured: 'The deal room has no usable OPS_BOT_TOKEN set, so its service API is switched off.',
  internal_error: 'The deal room failed while handling the request. What it wrote is not known; a retry reads the room again first.',
  deal_not_found: 'The deal room has no deal with that id any more.',
  body_too_large: 'The deal room refused the request as too large.',
};

export function createDealRoomService(options: DealRoomServiceOptions): DealRoomService {
  const { token } = options;
  if (token.length < 32) throw new Error('The deal room token is too short.');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const scrub = (value: string): string => value.split(token).join('[token]');

  const base = (origin: string): string => {
    const parsed = parseRoomOrigin(origin, { allowLocalHttp: options.allowLocalHttp === true });
    if (!parsed.ok) throw new DealRoomServiceError(`The deal room address in Settings cannot be used: ${parsed.reason}`, 0, 'bad_request_local');
    return `${parsed.origin}/api/service/deals`;
  };
  const idPath = (id: string): string => {
    if (!ROOM_ID.test(id)) throw new DealRoomServiceError('That is not a deal room id.', 0, 'bad_request_local');
    return `/${id}`;
  };

  async function call(origin: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${base(origin)}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && payload.length > MAX_REQUEST_CHARS) {
      throw new DealRoomServiceError('The files are too large to send to the deal room in one request.', 0, 'bad_request_local');
    }
    let response: Response;
    let raw: string;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: payload }),
        // A redirect is never followed: the token goes to the address in Settings and nowhere else.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      raw = await response.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new DealRoomServiceError(timedOut ? 'The deal room did not answer in time.' : 'The deal room could not be reached.', 0, 'unreachable');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DealRoomServiceError(`The deal room answered with a redirect (${response.status}), which Patcher does not follow. Check the address in Settings.`, response.status, 'bad_response');
    }
    let parsed: unknown;
    try {
      parsed = raw.length <= MAX_RESPONSE_CHARS ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    if (!response.ok) {
      const code = typeof object?.code === 'string' && /^[a-z_]{1,60}$/.test(object.code) ? object.code : undefined;
      if (!code) {
        const hint = response.status === 404 ? ' Is the service API deployed at the address in Settings?' : '';
        throw new DealRoomServiceError(`The deal room answered ${response.status} without a reason.${hint}`, response.status, 'bad_response');
      }
      const { error: sentence, code: _code, ...details } = object!;
      const said = typeof sentence === 'string' ? scrub(sentence).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      const message = SENTENCES[code] ?? `The deal room refused the request (${code})${said ? `: ${said}` : '.'}`;
      throw new DealRoomServiceError(message, response.status, code, JSON.parse(scrub(JSON.stringify(details))) as Record<string, unknown>);
    }
    if (!object) throw new DealRoomServiceError('The deal room answered with something that is not JSON.', response.status, 'bad_response');
    return object;
  }

  function read<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      const where = result.error.issues[0]?.path.join('.') ?? '';
      throw new DealRoomServiceError(`The deal room answered in a shape Patcher does not know${where ? ` (${where})` : ''}.`, 200, 'bad_response');
    }
    return result.data;
  }
  const roomOf = (value: unknown): Room => read(z.object({ deal: roomSchema }), value).deal;
  const contentOf = (parsed: z.infer<typeof contentSchema>): RoomContent => ({ files: parsed.files, sections: parsed.proposalSections });

  return {
    async list(origin, filter) {
      const query = new URLSearchParams();
      for (const key of ['slug', 'externalRef', 'clientName'] as const) {
        const value = filter[key];
        if (value) query.set(key, value);
      }
      const suffix = query.toString();
      return read(z.object({ deals: z.array(roomSchema).max(5000) }), await call(origin, 'GET', suffix ? `?${suffix}` : '')).deals;
    },

    async findOrCreate(origin, input) {
      if (!EXTERNAL_REF.test(input.externalRef)) throw new DealRoomServiceError('That is not a reference the deal room accepts.', 0, 'bad_request_local');
      const answer = read(
        z.object({ deal: roomSchema, created: z.boolean() }),
        await call(origin, 'POST', '', {
          externalRef: input.externalRef,
          clientName: input.clientName,
          ...(input.slug ? { slug: input.slug } : {}),
          ...input.facts,
        }),
      );
      return { room: answer.deal, created: answer.created };
    },

    async get(origin, id) {
      return roomOf(await call(origin, 'GET', idPath(id)));
    },

    async update(origin, id, change) {
      const body: Record<string, unknown> = { ...change.facts };
      if (change.externalRef !== undefined) {
        if (!EXTERNAL_REF.test(change.externalRef)) throw new DealRoomServiceError('That is not a reference the deal room accepts.', 0, 'bad_request_local');
        body.externalRef = change.externalRef;
      }
      if (change.publish === true) body.status = 'ACTIVE';
      if (change.confirmLive === true) body.confirmLive = true;
      return roomOf(await call(origin, 'PATCH', idPath(id), body));
    },

    async content(origin, id, options = {}) {
      return contentOf(read(contentSchema, await call(origin, 'GET', `${idPath(id)}/content${options.bodies ? '?include=body' : ''}`)));
    },

    async writeContent(origin, id, input) {
      if (input.files.length + input.remove.length === 0) throw new DealRoomServiceError('There is nothing to write.', 0, 'bad_request_local');
      if (input.files.length + input.remove.length > MAX_PATHS) throw new DealRoomServiceError(`The deal room takes at most ${MAX_PATHS} files in one request.`, 0, 'bad_request_local');
      const body: Record<string, unknown> = { files: input.files.map((f) => ({ path: f.path, body: f.body })), remove: input.remove };
      if (input.confirmLive === true) body.confirmLive = true;
      const parsed = read(writeSchema, await call(origin, 'PUT', `${idPath(id)}/content`, body));
      return { ...contentOf(parsed), written: parsed.written, unchanged: parsed.unchanged, removed: parsed.removed };
    },
  };
}
