import { createHash } from 'node:crypto';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Queryable } from '../db/pool.js';
import type { Recommendation, RecommendationRow } from '../recommendations/types.js';
import { recommendationFromRow } from '../recommendations/types.js';
import type {
  CatalogItem,
  Deal,
  DealRoomUpdate,
  DealRoomUpdateRow,
  DealRow,
  Proposal,
  ProposalRow,
  SalesCall,
  SalesCallRow,
  SalesState,
  SalesStep,
} from './types.js';
import { PROPOSAL_COLUMNS, SALES_CARRIER, dealFromRow, proposalFromRow, salesCallFromRow, updateFromRow } from './types.js';

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

// Sales calls ------------------------------------------------------------------------------

export async function getSalesCall(db: Queryable, callId: string): Promise<SalesCall | null> {
  if (!isUuid(callId)) return null;
  const { rows } = await db.query<SalesCallRow>('SELECT * FROM sales_calls WHERE call_id = $1', [callId]);
  return rows[0] ? salesCallFromRow(rows[0]) : null;
}

/**
 * Puts a call in the sales pipeline, or moves it. The version goes up each time, which is
 * what makes the buttons of an earlier drawing of its message stop working.
 */
export async function setSalesState(
  db: Queryable,
  callId: string,
  change: {
    state: SalesState;
    detail?: string | null;
    holdReason?: string | null;
    heldStep?: SalesStep | null;
    decidedBy?: string;
    dealId?: string;
    note?: string | null;
    requestedBy?: string | null;
  },
): Promise<SalesCall> {
  const { rows } = await db.query<SalesCallRow>(
    `INSERT INTO sales_calls (call_id, state, detail, hold_reason, held_step, decided_by, deal_id, note, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (call_id) DO UPDATE
        SET state = EXCLUDED.state, detail = EXCLUDED.detail, hold_reason = EXCLUDED.hold_reason, held_step = EXCLUDED.held_step,
            decided_by = COALESCE(EXCLUDED.decided_by, sales_calls.decided_by),
            deal_id = COALESCE(EXCLUDED.deal_id, sales_calls.deal_id),
            note = CASE WHEN $10 THEN EXCLUDED.note ELSE sales_calls.note END,
            requested_by = CASE WHEN $10 THEN EXCLUDED.requested_by ELSE sales_calls.requested_by END,
            version = sales_calls.version + 1, updated_at = now()
     RETURNING *`,
    [
      callId,
      change.state,
      change.detail ?? null,
      change.holdReason ?? null,
      change.heldStep ?? null,
      change.decidedBy ?? null,
      change.dealId ?? null,
      change.note ?? null,
      change.requestedBy ?? null,
      change.note !== undefined,
    ],
  );
  return salesCallFromRow(rows[0]!);
}

export async function bumpSalesVersion(db: Queryable, callIds: string[]): Promise<void> {
  if (callIds.length) await db.query('UPDATE sales_calls SET version = version + 1, updated_at = now() WHERE call_id = ANY($1::uuid[])', [callIds]);
}

// Deals ------------------------------------------------------------------------------------

export async function getDeal(db: Queryable, id: string): Promise<Deal | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<DealRow>('SELECT * FROM deals WHERE id = $1', [id]);
  return rows[0] ? dealFromRow(rows[0]) : null;
}

export interface DealListItem extends Deal {
  proposalId: string | null;
  proposalVersion: number | null;
  proposalStatus: Proposal['status'] | null;
  updateStatus: DealRoomUpdate['status'] | null;
  prUrl: string | null;
  roomUrl: string | null;
  calls: number;
}

export async function listDeals(db: Queryable, limit = 200): Promise<DealListItem[]> {
  const { rows } = await db.query<
    DealRow & { proposal_id: string | null; proposal_version: number | null; proposal_status: Proposal['status'] | null; update_status: DealRoomUpdate['status'] | null; pr_url: string | null; room_url: string | null; calls: string }
  >(
    `SELECT d.*, p.id AS proposal_id, p.version AS proposal_version, p.status AS proposal_status,
            u.status AS update_status, u.pr_url, u.room_url,
            (SELECT count(*) FROM sales_calls s WHERE s.deal_id = d.id) AS calls
       FROM deals d
       LEFT JOIN LATERAL (SELECT id, version, status FROM proposals WHERE deal_id = d.id ORDER BY version DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (SELECT status, pr_url, room_url FROM deal_room_updates WHERE deal_id = d.id ORDER BY created_at DESC LIMIT 1) u ON true
      ORDER BY d.updated_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    ...dealFromRow(r),
    proposalId: r.proposal_id,
    proposalVersion: r.proposal_version,
    proposalStatus: r.proposal_status,
    updateStatus: r.update_status,
    prUrl: r.pr_url,
    roomUrl: r.room_url,
    calls: Number(r.calls),
  }));
}

/** A sales call as the Sales screen lists it. */
export interface SalesCallItem extends SalesCall {
  title: string;
  startedAt: Date | null;
}

const itemFromRow = (r: SalesCallRow & { title: string; started_at: Date | null }): SalesCallItem => ({ ...salesCallFromRow(r), title: r.title, startedAt: r.started_at });

/** Sales calls that are not settled: a question is open, a draft is on its way, or something is waiting. */
export async function listOpenSalesCalls(db: Queryable, limit = 50): Promise<SalesCallItem[]> {
  const { rows } = await db.query<SalesCallRow & { title: string; started_at: Date | null }>(
    `SELECT s.*, c.title, c.started_at
       FROM sales_calls s JOIN calls c ON c.id = s.call_id
      WHERE c.status <> 'deleted' AND (s.state IN ('asked', 'drafting', 'held', 'failed') OR s.post_error IS NOT NULL)
      ORDER BY s.updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(itemFromRow);
}

export async function listDealCalls(db: Queryable, dealId: string): Promise<SalesCallItem[]> {
  const { rows } = await db.query<SalesCallRow & { title: string; started_at: Date | null }>(
    `SELECT s.*, c.title, c.started_at
       FROM sales_calls s JOIN calls c ON c.id = s.call_id
      WHERE s.deal_id = $1
      ORDER BY coalesce(c.started_at, c.created_at) DESC LIMIT 50`,
    [dealId],
  );
  return rows.map(itemFromRow);
}

// Proposals --------------------------------------------------------------------------------

export async function getProposal(db: Queryable, id: string): Promise<Proposal | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = $1`, [id]);
  return rows[0] ? proposalFromRow(rows[0]) : null;
}

export async function listProposals(db: Queryable, dealId: string): Promise<Proposal[]> {
  const { rows } = await db.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE deal_id = $1 ORDER BY version DESC`, [dealId]);
  return rows.map(proposalFromRow);
}

/** The newest version drafted from this call. */
export async function proposalForCall(db: Queryable, callId: string): Promise<Proposal | null> {
  const { rows } = await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE call_id = $1 ORDER BY version DESC LIMIT 1`,
    [callId],
  );
  return rows[0] ? proposalFromRow(rows[0]) : null;
}

export async function proposalPdf(db: Queryable, id: string): Promise<{ pdf: Buffer; title: string; version: number } | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<{ pdf: Buffer | null; title: string; version: number }>('SELECT pdf, title, version FROM proposals WHERE id = $1', [id]);
  return rows[0]?.pdf ? { pdf: rows[0].pdf, title: rows[0].title, version: rows[0].version } : null;
}

export interface NewProposal {
  dealId: string;
  callId: string | null;
  title: string;
  summary: string;
  brief: Proposal['brief'];
  contentMd: string;
  gaps: string[];
  flags: string[];
  lineItems: Proposal['lineItems'];
  pdf: Buffer | null;
  createdBy: Actor;
  note: string | null;
}

/**
 * Adds the next version of a deal's proposal. Earlier drafts become `superseded`; what they
 * had waiting for a decision is closed, and the calls they were drafted from are returned
 * so their messages can be redrawn.
 */
export async function insertProposal(tx: Queryable, input: NewProposal): Promise<{ proposal: Proposal; affectedCalls: string[] }> {
  await tx.query('SELECT id FROM deals WHERE id = $1 FOR UPDATE', [input.dealId]);
  const older = await tx.query<{ id: string; call_id: string | null }>(
    `UPDATE proposals SET status = 'superseded' WHERE deal_id = $1 AND status = 'draft' RETURNING id, call_id`,
    [input.dealId],
  );
  const next = await tx.query<{ version: number }>('SELECT COALESCE(max(version), 0) + 1 AS version FROM proposals WHERE deal_id = $1', [input.dealId]);
  const version = next.rows[0]!.version;
  const { rows } = await tx.query<ProposalRow>(
    `INSERT INTO proposals (deal_id, call_id, version, title, summary, brief, content_md, content_hash, gaps, flags, line_items, pdf, created_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${PROPOSAL_COLUMNS}`,
    [
      input.dealId,
      input.callId,
      version,
      input.title,
      input.summary,
      JSON.stringify(input.brief),
      input.contentMd,
      sha256(input.contentMd),
      JSON.stringify(input.gaps),
      JSON.stringify(input.flags),
      JSON.stringify(input.lineItems),
      input.pdf,
      input.createdBy,
      input.note,
    ],
  );
  await tx.query(`UPDATE deals SET stage = 'open', updated_at = now() WHERE id = $1`, [input.dealId]);
  const affected = new Set<string>();
  for (const row of older.rows) if (row.call_id) affected.add(row.call_id);
  if (input.callId) affected.add(input.callId);
  for (const callId of affected) {
    await closeSalesRecommendations(tx, callId, { reason: `Replaced by proposal v${version}.`, actor: input.createdBy });
  }
  await bumpSalesVersion(tx, [...affected]);
  return { proposal: proposalFromRow(rows[0]!), affectedCalls: [...affected] };
}

// Recommendations carried by a sales call's message ------------------------------------------

/** The recommendation that offers this proposal, newest first: the one waiting, or the one that was decided. */
export async function offerFor(db: Queryable, proposalId: string): Promise<Recommendation | null> {
  const { rows } = await db.query<RecommendationRow>(
    `SELECT * FROM recommendations WHERE carrier_type = $1 AND source_type = 'proposal' AND source_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [SALES_CARRIER, proposalId],
  );
  return rows[0] ? recommendationFromRow(rows[0]) : null;
}

/** The newest approval that followed a deal room update: writing files that were held, or publishing the draft room. */
export async function followUpFor(db: Queryable, updateId: string): Promise<Recommendation | null> {
  const { rows } = await db.query<RecommendationRow>(
    `SELECT * FROM recommendations WHERE carrier_type = $1 AND source_type = 'deal_room_update' AND source_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [SALES_CARRIER, updateId],
  );
  return rows[0] ? recommendationFromRow(rows[0]) : null;
}

/** Withdraws one recommendation that is waiting or failed, because what it would do no longer fits the room. */
export async function withdrawRecommendation(tx: Queryable, id: string, options: { reason: string; actor: Actor }): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE recommendations SET status = 'expired', last_error = $2, updated_at = now() WHERE id = $1 AND status IN ('drafted', 'posted', 'failed')`,
    [id, options.reason],
  );
  if (!rowCount) return false;
  await recordAudit(tx, { actor: options.actor, action: 'recommendation.expire', target: id, after: { status: 'expired', reason: options.reason } });
  return true;
}

/** Closes what a sales call still has waiting for a decision. What was approved stays as it is. */
export async function closeSalesRecommendations(
  tx: Queryable,
  callId: string,
  options: { reason: string; actor: Actor; alsoFailed?: boolean },
): Promise<number> {
  // A failed one is closed too when what it would retry no longer fits the deal.
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE recommendations
        SET status = 'expired', last_error = $3, updated_at = now()
      WHERE carrier_type = $1 AND carrier_id = $2 AND status = ANY($4::text[])
      RETURNING id`,
    [SALES_CARRIER, callId, options.reason, options.alsoFailed ? ['drafted', 'posted', 'failed'] : ['drafted', 'posted']],
  );
  for (const rec of rows) {
    await recordAudit(tx, { actor: options.actor, action: 'recommendation.expire', target: rec.id, after: { status: 'expired', reason: options.reason } });
  }
  return rows.length;
}

// Deal room updates --------------------------------------------------------------------------

export async function listUpdates(db: Queryable, dealId: string, limit = 20): Promise<DealRoomUpdate[]> {
  const { rows } = await db.query<DealRoomUpdateRow>('SELECT * FROM deal_room_updates WHERE deal_id = $1 ORDER BY created_at DESC LIMIT $2', [dealId, limit]);
  return rows.map(updateFromRow);
}

export async function updateForProposal(db: Queryable, proposalId: string): Promise<DealRoomUpdate | null> {
  const { rows } = await db.query<DealRoomUpdateRow>('SELECT * FROM deal_room_updates WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1', [proposalId]);
  return rows[0] ? updateFromRow(rows[0]) : null;
}

// Service catalog and rate card ---------------------------------------------------------------

interface CatalogRow {
  id: string;
  key: string;
  name: string;
  description: string;
  unit: string;
  unit_price_cents: string | null;
  active: boolean;
}

const catalogFromRow = (r: CatalogRow): CatalogItem => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  unit: r.unit,
  unitPriceCents: r.unit_price_cents === null ? null : Number(r.unit_price_cents),
  active: r.active,
});

export async function listCatalog(db: Queryable, options: { activeOnly?: boolean } = {}): Promise<CatalogItem[]> {
  const { rows } = await db.query<CatalogRow>(
    `SELECT id, key, name, description, unit, unit_price_cents, active FROM sales_catalog ${options.activeOnly ? 'WHERE active' : ''} ORDER BY name, key`,
  );
  return rows.map(catalogFromRow);
}

export class CatalogInputError extends Error {}

export interface CatalogInput {
  key: string;
  name: string;
  description: string;
  unit: string;
  /** As typed: "1500", "1,500.00", or empty for no price. */
  price: string;
  active: boolean;
}

/** "1,500.50" to cents. Null for an empty box; an error for anything that is not an amount. */
export function parsePrice(text: string): number | null {
  const trimmed = text.trim().replace(/^[$€£]/, '').replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(trimmed)) throw new CatalogInputError('Write the price as a number, like 1500 or 1500.50, or leave it empty.');
  return Math.round(Number(trimmed) * 100);
}

export async function saveCatalogItem(db: Queryable, input: CatalogInput, actor: Actor): Promise<CatalogItem> {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) throw new CatalogInputError('The reference is 2 to 40 lower-case letters, digits or dashes, like "integration-build".');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new CatalogInputError('The name is 2 to 120 characters.');
  const unit = input.unit.trim().toLowerCase() || 'fixed';
  if (!/^[a-z][a-z -]{0,29}$/.test(unit)) throw new CatalogInputError('The unit is one or two words, like "month" or "fixed".');
  const price = parsePrice(input.price);
  const before = await db.query<CatalogRow>('SELECT id, key, name, description, unit, unit_price_cents, active FROM sales_catalog WHERE key = $1', [key]);
  const { rows } = await db.query<CatalogRow>(
    `INSERT INTO sales_catalog (key, name, description, unit, unit_price_cents, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (key) DO UPDATE
        SET name = EXCLUDED.name, description = EXCLUDED.description, unit = EXCLUDED.unit, unit_price_cents = EXCLUDED.unit_price_cents,
            active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, key, name, description, unit, unit_price_cents, active`,
    [key, name, input.description.trim().slice(0, 500), unit, price, input.active, actor],
  );
  const saved = catalogFromRow(rows[0]!);
  await recordAudit(db, {
    actor,
    action: before.rows[0] ? 'sales.catalog.update' : 'sales.catalog.add',
    target: key,
    ...(before.rows[0] ? { before: catalogFromRow(before.rows[0]) } : {}),
    after: saved,
  });
  return saved;
}

export async function removeCatalogItem(db: Queryable, id: string, actor: Actor): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rows } = await db.query<CatalogRow>('DELETE FROM sales_catalog WHERE id = $1 RETURNING id, key, name, description, unit, unit_price_cents, active', [id]);
  if (!rows[0]) return false;
  await recordAudit(db, { actor, action: 'sales.catalog.remove', target: rows[0].key, before: catalogFromRow(rows[0]) });
  return true;
}

// What a deleted recording leaves behind -------------------------------------------------------

/**
 * The recording was deleted at its source. What was drawn from the call and not yet acted on
 * goes with it: drafts lose their text, and the words of the call leave every brief and every
 * recommendation. A proposal a person approved stays, without the quotes behind it.
 */
export async function forgetCallQuotes(db: Queryable, callId: string): Promise<void> {
  await db.query(`UPDATE proposals SET brief = '{}'::jsonb WHERE call_id = $1`, [callId]);
  await db.query(
    `UPDATE proposals
        SET status = 'dismissed', content_md = '', content_hash = $2, summary = '', gaps = '[]', flags = '[]', line_items = '[]', pdf = NULL
      WHERE call_id = $1 AND status IN ('draft', 'superseded')`,
    [callId, sha256('')],
  );
  await db.query(
    `UPDATE recommendations
        SET evidence = '[{"quote": "[removed]", "source": "The recording was deleted at its source"}]'::jsonb
      WHERE carrier_type = $1 AND carrier_id = $2`,
    [SALES_CARRIER, callId],
  );
  await db.query(`UPDATE sales_calls SET detail = NULL, note = NULL, version = version + 1, updated_at = now() WHERE call_id = $1`, [callId]);
}
