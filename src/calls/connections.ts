import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Enqueuer } from '../queue/queue.js';
import { SealedSecretError } from '../security/sealed.js';
import { getSetting } from '../settings/settings.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { ingestTranscript, isKnown, removeTranscript } from './ingest.js';
import type { SourceAccount } from './sources/source.js';
import { SourceApiError } from './sources/source.js';
import type { Vendor } from './types.js';
import { VENDOR_LABEL, isVendor } from './types.js';

/**
 * The connected Calendly and Fathom accounts (design 5.1 and 12.2). A key is typed into the
 * UI, sealed by the public service with the public key, and opened only here in the worker,
 * which checks it, registers the webhook and polls. The public service never sees a key in
 * the clear after the request that carried it, and never holds a webhook secret.
 */
export interface Connection {
  id: string;
  source: Vendor;
  owner: string;
  scope: 'personal' | 'team';
  status: 'pending' | 'connected' | 'error' | 'disconnected';
  hasKey: boolean;
  hasWebhook: boolean;
  webhookNote: string | null;
  accountLabel: string | null;
  importDays: number;
  watermark: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

interface ConnectionRow {
  id: string;
  source: Vendor;
  owner: string;
  scope: Connection['scope'];
  status: Connection['status'];
  secret_ciphertext: string | null;
  webhook_secret_ct: string | null;
  webhook_ref: string | null;
  hook_token_hash: string | null;
  webhook_note: string | null;
  account: Partial<SourceAccount>;
  import_days: number;
  watermark: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

const fromRow = (r: ConnectionRow): Connection => ({
  id: r.id,
  source: r.source,
  owner: r.owner,
  scope: r.scope,
  status: r.status,
  hasKey: r.secret_ciphertext !== null,
  hasWebhook: r.webhook_ref !== null,
  webhookNote: r.webhook_note,
  accountLabel: r.account.label ?? null,
  importDays: r.import_days,
  watermark: r.watermark,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
  lastErrorAt: r.last_error_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_IMPORT_DAYS = 14;
/** Each poll looks this far behind its watermark: a recap can become available hours after its call ended. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_PER_POLL = 200;

export class ConnectionError extends Error {}

/** Connections that exist: everything except those a person removed. */
export async function listConnections(db: Queryable): Promise<Connection[]> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT * FROM transcript_connections
      WHERE status <> 'disconnected' OR secret_ciphertext IS NOT NULL
      ORDER BY source, created_at`,
  );
  return rows.map(fromRow);
}

async function getRow(db: Queryable, id: string): Promise<ConnectionRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<ConnectionRow>('SELECT * FROM transcript_connections WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// The public service's side ---------------------------------------------------------------

export interface NewConnection {
  source: string;
  owner: string;
  scope: string;
  /** The key, already sealed. The caller seals it; this module never takes it in the clear. */
  sealedKey: string;
  importDays: number;
}

/** Stores a sealed key and asks the worker to check it and register its webhook. */
export async function addConnection(deps: { pool: Pool; queue: Enqueuer }, input: NewConnection, actor: Actor): Promise<string> {
  if (!isVendor(input.source)) throw new ConnectionError('Unknown source.');
  const owner = input.owner.replace(/\s+/g, ' ').trim();
  if (!owner || owner.length > 100) throw new ConnectionError('Say whose key this is, in at most 100 characters.');
  if (!Number.isInteger(input.importDays) || input.importDays < 0 || input.importDays > MAX_IMPORT_DAYS) {
    throw new ConnectionError(`Earlier calls can be collected for 0 to ${MAX_IMPORT_DAYS} days.`);
  }
  const scope = input.source === 'fathom' && input.scope === 'team' ? 'team' : 'personal';
  return withTx(deps.pool, async (tx) => {
    if (input.source === 'calendly') {
      const existing = await tx.query(`SELECT 1 FROM transcript_connections WHERE source = 'calendly' AND status <> 'disconnected'`);
      if (existing.rowCount) throw new ConnectionError('Calendly is already connected. Remove that connection first.');
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO transcript_connections (source, owner, scope, secret_ciphertext, import_days, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.source, owner, scope, input.sealedKey, input.importDays, actor],
    );
    const id = rows[0]!.id;
    await recordAudit(tx, { actor, action: 'calls.connection.add', target: id, after: { source: input.source, owner, scope, importDays: input.importDays } });
    await deps.queue.enqueue('calls.connection.setup', { connectionId: id }, { tx });
    return id;
  });
}

/** Asks the worker to check a connection again, after an error or a rejected key. */
export async function retryConnection(deps: { pool: Pool; queue: Enqueuer }, id: string, actor: Actor): Promise<void> {
  const row = await getRow(deps.pool, id);
  if (!row?.secret_ciphertext) throw new ConnectionError('That connection does not exist.');
  await recordAudit(deps.pool, { actor, action: 'calls.connection.retry', target: id });
  await deps.queue.enqueue('calls.connection.setup', { connectionId: id });
}

export async function requestRemoval(deps: { pool: Pool; queue: Enqueuer }, id: string, actor: Actor): Promise<void> {
  const row = await getRow(deps.pool, id);
  if (!row) throw new ConnectionError('That connection does not exist.');
  await deps.queue.enqueue('calls.connection.remove', { connectionId: id, requestedBy: actor });
}

export const hookTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

const HOOK_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
/** The headers each vendor signs with. Only these are kept with a stored delivery. */
const SIGNATURE_HEADERS: Record<Vendor, string[]> = {
  calendly: ['calendly-webhook-signature'],
  fathom: ['webhook-id', 'webhook-timestamp', 'webhook-signature'],
};

export type DeliveryOutcome = 'stored' | 'duplicate' | 'unknown' | 'unsigned' | 'off';

/**
 * A webhook arriving at the public service. The address carries a token that only the vendor
 * was given, which is what the public service can check; the signature is checked by the
 * worker, which holds the webhook secret, before anything in the delivery is used.
 */
export async function storeDelivery(
  deps: { pool: Pool; queue: Enqueuer },
  input: { source: string; token: string; headers: Record<string, string | undefined>; rawBody: string },
): Promise<DeliveryOutcome> {
  if (!isVendor(input.source) || !HOOK_TOKEN.test(input.token)) return 'unknown';
  const found = await deps.pool.query<{ id: string }>(
    `SELECT id FROM transcript_connections WHERE source = $1 AND hook_token_hash = $2 AND status <> 'disconnected'`,
    [input.source, hookTokenHash(input.token)],
  );
  const connectionId = found.rows[0]?.id;
  if (!connectionId) return 'unknown';
  const names = SIGNATURE_HEADERS[input.source];
  const headers = Object.fromEntries(names.map((name) => [name, input.headers[name]?.slice(0, 500)]));
  if (names.some((name) => !headers[name]) || input.rawBody.includes('\u0000')) return 'unsigned';
  if (!(await getSetting(deps.pool, 'calls.enabled'))) return 'off';

  // Fathom repeats `webhook-id` on a retry. Calendly sends no delivery id, so the body is the identity.
  const eventId = input.source === 'fathom' ? headers['webhook-id']! : createHash('sha256').update(input.rawBody).digest('hex');
  return withTx(deps.pool, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO webhook_events (source, external_event_id, payload) VALUES ($1, $2, $3)
       ON CONFLICT (source, external_event_id) DO NOTHING
       RETURNING id`,
      [input.source, `${connectionId}:${eventId}`.slice(0, 300), JSON.stringify({ connectionId, headers, body: input.rawBody })],
    );
    if (!inserted.rows[0]) return 'duplicate';
    await deps.queue.enqueue('calls.webhook', { webhookEventId: inserted.rows[0].id }, { tx });
    return 'stored';
  });
}

// The worker's side -----------------------------------------------------------------------

const NO_PRIVATE_KEY = 'TOKEN_PRIVATE_KEY is not set on the worker, so stored keys cannot be read.';

function openKey(deps: Pick<WorkerDeps, 'secrets'>, sealed: string | null): string {
  if (!deps.secrets) throw new ConnectionError(NO_PRIVATE_KEY);
  if (!sealed) throw new ConnectionError('The connection has no key.');
  try {
    return deps.secrets.open(sealed);
  } catch (err) {
    if (err instanceof SealedSecretError) {
      throw new ConnectionError("The stored key cannot be opened with the worker's TOKEN_PRIVATE_KEY. Remove the connection and add it again.");
    }
    throw err;
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
/** Worth another try without anyone doing anything: the vendor did not answer, was busy, or failed. */
const transient = (err: unknown): boolean => err instanceof SourceApiError && (err.status === 0 || err.status === 429 || err.status >= 500);

async function recordError(db: Queryable, id: string, message: string, status?: Connection['status']): Promise<void> {
  await db.query(
    `UPDATE transcript_connections
        SET last_error = $2, last_error_at = now(), status = coalesce($3, status), updated_at = now()
      WHERE id = $1`,
    [id, message.slice(0, 300), status ?? null],
  );
}

/** The key itself was refused. Marked once, with one notice; the other connections carry on. */
async function disconnect(deps: WorkerDeps, row: ConnectionRow, err: SourceApiError): Promise<void> {
  const changed = await deps.pool.query(
    `UPDATE transcript_connections
        SET status = 'disconnected', last_error = $2, last_error_at = now(), updated_at = now()
      WHERE id = $1 AND status <> 'disconnected'`,
    [row.id, `The key was refused: ${err.message}`.slice(0, 300)],
  );
  if (!changed.rowCount) return;
  await recordAudit(deps.pool, { actor: SYSTEM_ACTOR, action: 'calls.connection.disconnected', target: row.id, after: { source: row.source, owner: row.owner } });
  await notifyOps(
    deps,
    `${VENDOR_LABEL[row.source]} key for ${row.owner} stopped working, so its calls are not collected. Connect a new key in <${deps.appBaseUrl}/settings#calls|Settings>.`,
  );
}

/** A webhook can only be delivered to an address the vendor can reach over https. */
function publicAddress(appBaseUrl: string): boolean {
  try {
    const url = new URL(appBaseUrl);
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

const POLL_ONLY = 'The 15-minute poll collects calls instead.';

export type SetupOutcome = 'connected' | 'error' | 'disconnected' | 'not_found';

/** Checks a key, registers its webhook and starts collecting. Safe to run again. */
export async function setupConnection(deps: WorkerDeps, id: string): Promise<SetupOutcome> {
  const row = await getRow(deps.pool, id);
  if (!row?.secret_ciphertext) return 'not_found';
  const source = deps.integrations.transcripts[row.source];

  let key: string;
  let account: SourceAccount;
  try {
    key = openKey(deps, row.secret_ciphertext);
    account = await source.identify(key);
  } catch (err) {
    if (err instanceof SourceApiError && err.keyRejected) {
      await recordError(deps.pool, id, `The key was refused: ${err.message}`, 'disconnected');
      return 'disconnected';
    }
    if (!(err instanceof SourceApiError) && !(err instanceof ConnectionError)) throw err;
    await recordError(deps.pool, id, messageOf(err), 'error');
    if (transient(err)) throw err;
    return 'error';
  }

  let hook: { ref: string; secretCt: string; tokenHash: string } | undefined;
  let note: string | null = row.webhook_note;
  if (!row.webhook_ref) {
    if (!publicAddress(deps.appBaseUrl)) {
      note = `No webhook: APP_BASE_URL on the worker is not a public https address. ${POLL_ONLY}`;
    } else {
      const token = randomBytes(32).toString('base64url');
      try {
        const created = await source.createWebhook(key, {
          url: `${deps.appBaseUrl}/webhooks/${row.source}/${token}`,
          account,
          scope: row.scope,
        });
        hook = { ref: created.ref, secretCt: deps.secrets!.seal(created.secret), tokenHash: hookTokenHash(token) };
        note = created.note ?? null;
      } catch (err) {
        if (!(err instanceof SourceApiError)) throw err;
        note = `No webhook: ${err.message}. ${POLL_ONLY}`;
      }
    }
  }

  await withTx(deps.pool, async (tx) => {
    await tx.query(
      `UPDATE transcript_connections
          SET status = 'connected', account = $2, webhook_note = $3,
              webhook_ref = coalesce($4, webhook_ref), webhook_secret_ct = coalesce($5, webhook_secret_ct),
              hook_token_hash = coalesce($6, hook_token_hash),
              watermark = coalesce(watermark, now() - make_interval(days => import_days)),
              last_ok_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(account), note, hook?.ref ?? null, hook?.secretCt ?? null, hook?.tokenHash ?? null],
    );
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'calls.connection.connected',
      target: id,
      after: { source: row.source, owner: row.owner, webhook: Boolean(hook ?? row.webhook_ref) },
    });
    await deps.queue.enqueue('calls.poll', { connectionId: id }, { tx });
  });
  return 'connected';
}

/** Removes the webhook at the vendor and forgets the key. The calls already collected stay. */
export async function removeConnection(deps: WorkerDeps, id: string, requestedBy: Actor): Promise<boolean> {
  const row = await getRow(deps.pool, id);
  if (!row) return false;
  let leftover: string | null = null;
  if (row.webhook_ref) {
    try {
      await deps.integrations.transcripts[row.source].deleteWebhook(openKey(deps, row.secret_ciphertext), row.webhook_ref);
    } catch (err) {
      if (!(err instanceof SourceApiError) && !(err instanceof ConnectionError)) throw err;
      // The key may already be dead. The address stops being accepted here either way.
      leftover = `The webhook could not be removed at ${VENDOR_LABEL[row.source]} (${messageOf(err)}). Its deliveries are refused here.`;
      deps.log.warn('could not remove vendor webhook', { connectionId: id, source: row.source, reason: messageOf(err) });
    }
  }
  await withTx(deps.pool, async (tx) => {
    await tx.query(
      `UPDATE transcript_connections
          SET status = 'disconnected', secret_ciphertext = NULL, webhook_secret_ct = NULL, webhook_ref = NULL,
              hook_token_hash = NULL, last_error = $2, updated_at = now()
        WHERE id = $1`,
      [id, leftover],
    );
    await recordAudit(tx, { actor: requestedBy, action: 'calls.connection.remove', target: id, after: { source: row.source, owner: row.owner, leftover } });
  });
  return true;
}

export interface PollResult {
  outcome: 'polled' | 'skipped' | 'disconnected' | 'rate_limited';
  listed: number;
  added: number;
}

/** The catch-up poll for one connection (design 13.1): everything since the watermark that is not here yet. */
export async function pollConnection(deps: WorkerDeps, id: string, now: Date = new Date()): Promise<PollResult> {
  const row = await getRow(deps.pool, id);
  if (!row || row.status !== 'connected' || !(await getSetting(deps.pool, 'calls.enabled'))) return { outcome: 'skipped', listed: 0, added: 0 };
  const source = deps.integrations.transcripts[row.source];
  const since = new Date((row.watermark ?? now).getTime() - LOOKBACK_MS);
  let listed = 0;
  let added = 0;
  try {
    const key = openKey(deps, row.secret_ciphertext);
    const listings = (await source.listSince(key, since)).slice(0, MAX_PER_POLL);
    listed = listings.length;
    for (const listing of listings) {
      if (!listing.ready || (await isKnown(deps.pool, row.source, listing.externalId))) continue;
      const transcript = await source.fetchTranscript(key, listing);
      if (!transcript) continue;
      const result = await ingestTranscript(deps, transcript, row.id);
      if (result.outcome === 'new_call' || result.outcome === 'grouped') added += 1;
    }
  } catch (err) {
    if (err instanceof SourceApiError && err.keyRejected) {
      await disconnect(deps, row, err);
      return { outcome: 'disconnected', listed, added };
    }
    if (err instanceof SourceApiError && err.status === 429) {
      // What was fetched is kept; the watermark stays, so the next poll carries on from here.
      deps.log.info('call source rate limit reached, carrying on at the next poll', { connectionId: id, source: row.source });
      return { outcome: 'rate_limited', listed, added };
    }
    if (err instanceof SourceApiError || err instanceof ConnectionError) await recordError(deps.pool, id, messageOf(err));
    throw err;
  }
  await deps.pool.query(
    `UPDATE transcript_connections SET watermark = $2, last_ok_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now() WHERE id = $1`,
    [id, now],
  );
  return { outcome: 'polled', listed, added };
}

/** The `transcripts.poll` schedule: one job per connection, so one failing key does not hold up the others. */
export async function pollAll(deps: Pick<WorkerDeps, 'pool' | 'queue' | 'secrets'>): Promise<string> {
  if (!(await getSetting(deps.pool, 'calls.enabled'))) return 'Skipped: calls are switched off.';
  const { rows } = await deps.pool.query<{ id: string }>(`SELECT id FROM transcript_connections WHERE status = 'connected' ORDER BY created_at`);
  if (!rows.length) return 'No call source is connected.';
  if (!deps.secrets) return `Skipped: ${NO_PRIVATE_KEY}`;
  for (const row of rows) await deps.queue.enqueue('calls.poll', { connectionId: row.id });
  return `${rows.length} connection${rows.length === 1 ? '' : 's'} asked for new calls.`;
}

interface StoredDelivery {
  connectionId?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}

export type WebhookOutcome = 'ingested' | 'duplicate' | 'deleted' | 'not_ready' | 'rejected' | 'ignored' | 'already_done';

/**
 * A stored delivery: its signature is checked with the connection's webhook secret, and only
 * then is it read. Whatever the outcome, the body is removed from the stored event; the
 * transcript, if there was one, now lives in `transcripts`.
 */
export async function handleWebhook(deps: WorkerDeps, webhookEventId: string): Promise<WebhookOutcome> {
  const { rows } = await deps.pool.query<{ payload: StoredDelivery; received_at: Date; processed_at: Date | null }>(
    'SELECT payload, received_at, processed_at FROM webhook_events WHERE id = $1',
    [webhookEventId],
  );
  const event = rows[0];
  if (!event || event.processed_at) return 'already_done';
  const connectionId = event.payload.connectionId ?? '';
  const finish = async (outcome: WebhookOutcome, detail?: string): Promise<WebhookOutcome> => {
    await deps.pool.query(`UPDATE webhook_events SET processed_at = now(), payload = $2 WHERE id = $1`, [
      webhookEventId,
      JSON.stringify({ connectionId, outcome, ...(detail ? { detail } : {}) }),
    ]);
    return outcome;
  };

  const row = await getRow(deps.pool, connectionId);
  if (!row || row.status === 'disconnected' || !row.webhook_secret_ct || typeof event.payload.body !== 'string') {
    return finish('ignored', 'no_connection');
  }
  const source = deps.integrations.transcripts[row.source];
  let secret: string;
  let key: string;
  try {
    secret = openKey(deps, row.webhook_secret_ct);
    key = openKey(deps, row.secret_ciphertext);
  } catch (err) {
    if (!(err instanceof ConnectionError)) throw err;
    await recordError(deps.pool, row.id, err.message);
    return finish('ignored', 'no_key');
  }

  const check = source.verifyWebhook({ headers: event.payload.headers ?? {}, rawBody: event.payload.body, secret, receivedAt: event.received_at });
  if (!check.ok) {
    deps.log.warn('call webhook rejected', { connectionId: row.id, source: row.source, reason: check.reason });
    return finish('rejected', check.reason);
  }

  const notice = source.readWebhook(event.payload.body);
  if (notice.kind === 'ignored') return finish('ignored', notice.reason);
  if (notice.kind === 'deleted') {
    await removeTranscript(deps, row.source, notice.externalId);
    return finish('deleted');
  }

  let transcript = notice.transcript ?? null;
  const known = await isKnown(deps.pool, row.source, notice.listing.externalId);
  if (!transcript && !known) {
    try {
      transcript = await source.fetchTranscript(key, notice.listing);
    } catch (err) {
      if (err instanceof SourceApiError && err.keyRejected) {
        await disconnect(deps, row, err);
        return finish('ignored', 'key_refused');
      }
      throw err;
    }
  }
  await deps.pool.query(`UPDATE transcript_connections SET last_ok_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
  // Not finished at the vendor yet: the poll picks it up once it is.
  if (!transcript) return finish(known ? 'duplicate' : 'not_ready');
  const result = await ingestTranscript(deps, transcript, row.id);
  return finish(result.outcome === 'duplicate' || result.outcome === 'empty' ? 'duplicate' : 'ingested');
}

/** Per source: how many connections work, and the last time one did. For `/health` and the Home screen. */
export async function sourceHealth(db: Queryable): Promise<Record<Vendor, { connected: number; lastOkAt: string | null }>> {
  const { rows } = await db.query<{ source: Vendor; connected: string; last_ok_at: Date | null }>(
    `SELECT source, count(*) FILTER (WHERE status = 'connected') AS connected, max(last_ok_at) AS last_ok_at
       FROM transcript_connections GROUP BY source`,
  );
  const out: Record<Vendor, { connected: number; lastOkAt: string | null }> = {
    calendly: { connected: 0, lastOkAt: null },
    fathom: { connected: 0, lastOkAt: null },
  };
  for (const r of rows) out[r.source] = { connected: Number(r.connected), lastOkAt: r.last_ok_at?.toISOString() ?? null };
  return out;
}
