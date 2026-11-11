import { z } from 'zod';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, PoolClient } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { DealRoomAdapter, ServiceDealRoomAdapter, WriteConfirmation } from '../dealroom/adapter.js';
import type { PreparedUpdate } from '../dealroom/files.js';
import type { Room, RoomFacts } from '../dealroom/service.js';
import { DealRoomServiceError, ROOM_ID, ROOM_STATUSES } from '../dealroom/service.js';
import { markError, markOk } from '../integrations/status.js';
import type { ActionResult, Catalog } from '../recommendations/catalog.js';
import { getSetting } from '../settings/settings.js';
import { getDeal, getProposal } from './store.js';
import type { Deal, DealRoomUpdateRow, Proposal, RoomHold, RoomSnapshot } from './types.js';
import { DEALROOM_KIND, PROPOSAL_KIND, SLUG, updateFromRow } from './types.js';

/**
 * What approving a proposal can do (design 6.2, 6.5 and 6.6). Every action is bound to one
 * version of the proposal by its content hash: a proposal that changed after the approval
 * was given is not acted on.
 *
 *   - `sales.finalize_proposal` marks the proposal final and gives back the PDF link for a
 *     person to send. Patcher sends nothing to the prospect.
 *   - `sales.open_dealroom_pr` does the same and opens a pull request with the proposal as
 *     content files in the deal room's repository. It never merges.
 *   - `sales.write_dealroom` does the same through the deal room's service API: it finds or
 *     creates the room and writes the files, but only into a draft room that holds no
 *     person's edits. Otherwise it writes nothing and the files wait.
 *
 * Two more are offered afterwards, each as its own approval for that one deal:
 *
 *   - `sales.confirm_dealroom_write` writes files that were held. It is the only action that
 *     can send `confirmLive`, and it does so only for the room status its approver was shown.
 *   - `sales.publish_dealroom` sets a draft room to active. It is the only action that
 *     changes a room's status.
 *
 * Both of those, when the room is or becomes visible to clients, run only while the publish
 * setting is on. With it off, nothing Patcher does can be seen by a client.
 */
export const FINALIZE_ACTION = 'sales.finalize_proposal';
export const DEALROOM_PR_ACTION = 'sales.open_dealroom_pr';
export const DEALROOM_API_ACTION = 'sales.write_dealroom';
export const DEALROOM_CONFIRM_ACTION = 'sales.confirm_dealroom_write';
export const DEALROOM_PUBLISH_ACTION = 'sales.publish_dealroom';

const base = {
  proposalId: z.string().uuid(),
  version: z.number().int().min(1).max(10_000),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  company: z.string().trim().min(1).max(150),
};

export const finalizeParams = z.object(base).strict();
export type FinalizeParams = z.infer<typeof finalizeParams>;

export const dealRoomParams = z
  .object({
    ...base,
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    slug: z.string().regex(SLUG),
    /** One hash over the files the approver was shown. */
    filesHash: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.number().int().min(1).max(100),
  })
  .strict();
export type DealRoomParams = z.infer<typeof dealRoomParams>;

const origin = z.string().min(8).max(200).regex(/^https?:\/\/[^\s/?#@]+$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0).max(1_000_000);
const roomId = z.string().regex(ROOM_ID);
/** Who could open the room when the approver was asked. The action runs only while that is still so. */
const audience = { members: count, invites: count, domains: count };

export const apiWriteParams = z
  .object({
    ...base,
    origin,
    /** The slug a person saved for the room, if any. Null: the deal room makes one from the company name. */
    slug: z.string().regex(SLUG).nullable(),
    filesHash: hash,
    files: z.number().int().min(1).max(100),
  })
  .strict();
export type ApiWriteParams = z.infer<typeof apiWriteParams>;

export const confirmWriteParams = z
  .object({
    ...base,
    origin,
    updateId: z.string().uuid(),
    roomId,
    /** The status the approver was shown. */
    roomStatus: z.enum(ROOM_STATUSES),
    ...audience,
    filesHash: hash,
    files: z.number().int().min(1).max(100),
    /** The plan the approver was shown: what would be sent, and whose text it replaces. */
    planHash: hash,
    replaces: z.number().int().min(0).max(100),
    removes: z.number().int().min(0).max(100),
  })
  .strict();
export type ConfirmWriteParams = z.infer<typeof confirmWriteParams>;

export const publishParams = z.object({ ...base, origin, updateId: z.string().uuid(), roomId, ...audience }).strict();
export type PublishParams = z.infer<typeof publishParams>;

/** What the actions need at run time. The public service registers them without one. */
export interface SalesRuntime {
  pool: Pool;
  appBaseUrl: string;
  /** Null until the deal room's GitHub App variables are set on the worker. */
  dealRoom: DealRoomAdapter | null;
  /** Null until the deal room's API token is set on the worker. */
  dealRoomApi: ServiceDealRoomAdapter | null;
}

export const DEALROOM_NOT_CONFIGURED =
  'The deal room GitHub App is not configured on the worker (DEALROOM_GITHUB_APP_ID, DEALROOM_GITHUB_APP_PRIVATE_KEY, DEALROOM_GITHUB_APP_INSTALLATION_ID).';
export const DEALROOM_API_NOT_CONFIGURED = 'The deal room API token is not set on the worker (DEALROOM_API_TOKEN).';
export const PUBLISH_OFF =
  'Publishing from Patcher is switched off in Settings, so nothing was changed in the deal room. With it off, Patcher writes only into draft rooms and never changes a room\'s status.';
const ROUTE_CHANGED = 'The way Patcher reaches the deal room was changed in Settings after this was offered, so nothing was done. The proposal is offered again for the current setting.';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Who can open a room once it is active, in words. Counts only: the deal room gives no names. */
export function audienceText(room: { members: number; invites: number; domains: number }): string {
  if (!room.members && !room.invites && !room.domains) return 'nobody yet: it has no members, invites or client domains';
  return `${plural(room.members, 'member')}, ${plural(room.invites, 'pending invite')} and anyone who signs up with one of its ${plural(room.domains, 'allowed email domain')}`;
}

export const snapshotOf = (room: Room): RoomSnapshot => ({
  status: room.status,
  slug: room.slug,
  members: room.memberCount,
  invites: room.pendingInviteCount,
  domains: room.allowedEmailDomains,
});

/** The room's address as the app gave it, when it is a plain web address; otherwise built from the address in Settings. */
export function roomUrl(originUrl: string, room: Pick<Room, 'url' | 'slug'>): string {
  if (/^https?:\/\/[^\s<>|"']{1,300}$/.test(room.url)) return room.url;
  return `${originUrl}/deals/${encodeURIComponent(room.slug)}`;
}

const REPLACED = 'This proposal was replaced by a newer version after the approval was given, so nothing was done. Approve the current version.';

async function approvedProposal(pool: Pool, params: FinalizeParams): Promise<Proposal> {
  const proposal = await getProposal(pool, params.proposalId);
  if (!proposal) throw new Error('The proposal no longer exists.');
  if (proposal.version !== params.version || proposal.contentHash !== params.contentHash) throw new Error(REPLACED);
  if (proposal.status !== 'draft' && proposal.status !== 'final') throw new Error(REPLACED);
  return proposal;
}

async function finalize(tx: PoolClient, proposal: Proposal, recommendationId: string): Promise<void> {
  const decided = await tx.query<{ decided_by: string | null }>('SELECT decided_by FROM recommendations WHERE id = $1', [recommendationId]);
  const by = decided.rows[0]?.decided_by ?? SYSTEM_ACTOR;
  const updated = await tx.query(
    `UPDATE proposals SET status = 'final', finalized_by = $2, finalized_at = now() WHERE id = $1 AND status = 'draft'`,
    [proposal.id, by],
  );
  if (!updated.rowCount) return;
  await tx.query(`UPDATE deals SET stage = 'proposal_final', updated_at = now() WHERE id = $1`, [proposal.dealId]);
  await recordAudit(tx, { actor: by, action: 'proposal.final', target: proposal.id, after: { version: proposal.version, deal: proposal.dealId } });
}


interface RoomContext {
  adapter: ServiceDealRoomAdapter;
  proposal: Proposal;
  deal: Deal;
  origin: string;
}

/** What every deal room API action checks before it sends anything. */
async function roomContext(runtime: SalesRuntime, params: FinalizeParams & { origin: string }): Promise<RoomContext> {
  const adapter = runtime.dealRoomApi;
  if (!adapter) throw new Error(DEALROOM_API_NOT_CONFIGURED);
  const proposal = await approvedProposal(runtime.pool, params);
  const deal = await getDeal(runtime.pool, proposal.dealId);
  if (!deal) throw new Error('The deal no longer exists.');
  if (deal.isPenguin !== true) throw new Error('The deal is no longer marked as a Penguin deal, so nothing was sent to the deal room.');
  if (deal.dealRoomSkipped) throw new Error('The deal room was skipped for this deal, so nothing was sent to it.');
  if ((await getSetting(runtime.pool, 'sales.dealroom_route')) !== 'api') throw new Error(ROUTE_CHANGED);
  // The token goes only to the address that is in Settings now, and only if the approver was shown the same one.
  const current = await getSetting(runtime.pool, 'sales.dealroom_url');
  if (!current) throw new Error('The deal room address is not set in Settings, so nothing was sent.');
  if (current !== params.origin) throw new Error('The deal room address in Settings changed after this was offered, so nothing was sent.');
  return { adapter, proposal, deal, origin: current };
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function noteFailure(pool: Pool, updateId: string, status: 'failed' | null, err: unknown): Promise<void> {
  const reason = reasonOf(err);
  await pool.query(`UPDATE deal_room_updates SET status = COALESCE($2, status), error = $3, updated_at = now() WHERE id = $1`, [updateId, status, reason.slice(0, 500)]);
  if (err instanceof DealRoomServiceError) await markError(pool, 'dealroom_api', reason);
}

function holdSentence(hold: RoomHold, room: RoomSnapshot): string {
  const parts: string[] = [];
  if (hold.reasons.includes('live')) parts.push(`the room is ${room.status}, open to ${audienceText(room)}`);
  if (hold.reasons.includes('edited')) parts.push(`${plural(hold.replaces.length + hold.removes.length, 'file')} in the room that a person edited would be replaced or removed`);
  return parts.join(', and ');
}

/**
 * Finds or creates the room and writes the files, or holds them. Shared by the approval of
 * the proposal (no confirmation: only a draft room without a person's edits is written) and
 * by the confirmation that follows a hold.
 */
async function writeRoom(
  runtime: SalesRuntime,
  context: RoomContext,
  input: { prepared: PreparedUpdate; updateId: string; confirm: WriteConfirmation | null; recommendationId: string; failStatus: 'failed' | null },
): Promise<ActionResult> {
  const { pool } = runtime;
  const { adapter, proposal, deal, origin: address } = context;
  const facts: RoomFacts = { proposalVersion: `v${proposal.version}`, proposalUpdatedAt: proposal.createdAt.toISOString().slice(0, 10) };
  let found;
  let published;
  try {
    found = await adapter.findDeal(address, deal, facts);
    if (deal.dealRoomRef !== found.room.id) {
      const room = found;
      await withTx(pool, async (tx) => {
        await tx.query('UPDATE deals SET deal_room_ref = $2, updated_at = now() WHERE id = $1', [deal.id, room.room.id]);
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: room.created ? 'dealroom.api.create' : 'dealroom.api.link',
          target: deal.id,
          before: { room: deal.dealRoomRef },
          after: { room: room.room.id, slug: room.room.slug, status: room.room.status, linkedBySlug: room.linked },
        });
      });
    }
    published = await adapter.publish(address, found, input.prepared, { version: proposal.version, facts, confirm: input.confirm });
    await markOk(pool, 'dealroom_api');
  } catch (err) {
    await noteFailure(pool, input.updateId, input.failStatus, err);
    throw err;
  }

  const room = published.room;
  const url = roomUrl(address, room);
  const snapshot = snapshotOf(room);
  const files = JSON.stringify(input.prepared.files.map((f) => ({ path: f.path, hash: f.hash })));
  const changes = JSON.stringify(published.plan.changes);

  if (published.outcome === 'held') {
    const plan = published.plan;
    const hold: RoomHold = {
      reasons: published.reasons,
      planHash: plan.hash,
      replaces: plan.personEdits.filter((p) => !plan.remove.includes(p)),
      removes: plan.personEdits.filter((p) => plan.remove.includes(p)),
    };
    await withTx(pool, async (tx) => {
      await tx.query(
        `UPDATE deal_room_updates
            SET status = 'held', error = NULL, slug = $2, room_id = $3, room_url = $4, room = $5, hold = $6, changes = $7, files = $8, updated_at = now()
          WHERE id = $1`,
        [input.updateId, room.slug, room.id, url, JSON.stringify(snapshot), JSON.stringify(hold), changes, files],
      );
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'dealroom.api.hold',
        target: input.updateId,
        after: { room: room.id, status: room.status, reasons: hold.reasons, replaces: hold.replaces, removes: hold.removes },
      });
      await finalize(tx, proposal, input.recommendationId);
    });
    return {
      summary: `Proposal v${proposal.version} is final. Nothing was written to the deal room: ${holdSentence(hold, snapshot)}. Writing it needs its own approval.`,
      externalRef: url,
    };
  }

  const written = published;
  await withTx(pool, async (tx) => {
    await tx.query(
      `UPDATE deal_room_updates
          SET status = $2, error = NULL, slug = $3, room_id = $4, room_url = $5, room = $6, hold = NULL, changes = $7, files = $8, manual_steps = $9, updated_at = now()
        WHERE id = $1`,
      [input.updateId, written.live ? 'published' : 'draft_written', room.slug, room.id, url, JSON.stringify(snapshot), changes, files, JSON.stringify(written.manualSteps)],
    );
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'dealroom.api.write',
      target: input.updateId,
      after: { room: room.id, status: room.status, created: found.created, written: written.written, removed: written.removed, confirmLive: written.live },
    });
    await finalize(tx, proposal, input.recommendationId);
  });
  return {
    summary: written.live
      ? `Proposal v${proposal.version} was written to the deal room, which is ${room.status}: ${url}. It shows now to everyone who can open the room.`
      : `Proposal v${proposal.version} is in the draft deal room: ${url}. Clients cannot open a draft room, and its status was not changed.`,
    detail: `Still to do by hand:\n${written.manualSteps.map((step) => `- ${step}`).join('\n')}`,
    externalRef: url,
  };
}

async function updateRow(pool: Pool, id: string, proposalId: string): Promise<DealRoomUpdateRow> {
  const { rows } = await pool.query<DealRoomUpdateRow>(`SELECT * FROM deal_room_updates WHERE id = $1 AND proposal_id = $2 AND route = 'api'`, [id, proposalId]);
  if (!rows[0]) throw new Error('The deal room update this belongs to no longer exists.');
  return rows[0];
}

export function registerSalesCatalog(catalog: Catalog, runtime: SalesRuntime | null): Catalog {
  return catalog
    .registerKind({ kind: PROPOSAL_KIND, label: 'Proposal', defaultReportType: 'sales' })
    .registerKind({ kind: DEALROOM_KIND, label: 'Deal room', defaultReportType: 'sales' })
    .registerAction({
      type: FINALIZE_ACTION,
      params: finalizeParams,
      describe: (p) =>
        `Mark proposal v${p.version} for ${p.company} as final and give back the link to its PDF. Patcher sends nothing to the prospect; a person sends it.`,
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        const proposal = await approvedProposal(runtime.pool, params);
        await withTx(runtime.pool, (tx) => finalize(tx, proposal, ctx.recommendationId));
        const link = `${runtime.appBaseUrl}/sales/proposals/${proposal.id}/pdf`;
        return { summary: `Proposal v${proposal.version} is final. PDF for a person to send: ${link}`, externalRef: link };
      },
    })
    .registerAction({
      type: DEALROOM_PR_ACTION,
      params: dealRoomParams,
      describe: (p) =>
        `Open a pull request on ${p.repo} that adds or changes ${p.files} ${p.files === 1 ? 'file' : 'files'} under content/${p.slug}/ with proposal v${p.version} for ${p.company}, and mark the proposal final. Patcher does not merge it: nothing shows in the room until a person merges.`,
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        const adapter = runtime.dealRoom;
        if (!adapter) throw new Error(DEALROOM_NOT_CONFIGURED);
        const proposal = await approvedProposal(runtime.pool, params);
        const deal = await getDeal(runtime.pool, proposal.dealId);
        if (!deal) throw new Error('The deal no longer exists.');
        if (deal.isPenguin !== true) throw new Error('The deal is no longer marked as a Penguin deal, so nothing was opened in the deal room.');
        if (deal.dealRoomSlug !== params.slug) throw new Error('The deal room slug changed after the approval was given, so nothing was opened. Approve the current version.');
        if ((await getSetting(runtime.pool, 'sales.dealroom_route')) !== 'pull_request') throw new Error(ROUTE_CHANGED);
        const repo = await getSetting(runtime.pool, 'sales.dealroom_repo');
        if (repo !== params.repo) throw new Error('The deal room repository in Settings changed after the approval was given, so nothing was opened.');

        if (deal.dealRoomSkipped) throw new Error('The deal room was skipped for this deal after the approval was given, so nothing was opened.');
        const prepared = adapter.prepareUpdate({ slug: params.slug, title: proposal.title, contentMd: proposal.contentMd });
        if (prepared.filesHash !== params.filesHash) throw new Error('The deal room files are not the ones that were approved, so nothing was opened.');
        const found = await adapter.findDeal(repo, deal);
        if (!found) throw new Error('Patcher has no deal room slug for this deal.');

        // One update per approval. A retry of the same approval continues it and reuses its branch.
        const row = await runtime.pool.query<DealRoomUpdateRow>(
          `INSERT INTO deal_room_updates (deal_id, proposal_id, route, repo, slug, files, status, recommendation_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7)
           ON CONFLICT (recommendation_id) DO UPDATE SET status = 'prepared', error = NULL, updated_at = now()
           RETURNING *`,
          [deal.id, proposal.id, adapter.route, repo, params.slug, JSON.stringify(prepared.files.map((f) => ({ path: f.path, hash: f.hash }))), ctx.recommendationId],
        );
        const updateId = row.rows[0]!.id;
        let published;
        try {
          published = await adapter.publish(prepared, found, {
            repo,
            company: deal.company,
            proposalTitle: proposal.title,
            proposalVersion: proposal.version,
            updateId,
            appBaseUrl: runtime.appBaseUrl,
            proposalId: proposal.id,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await runtime.pool.query(`UPDATE deal_room_updates SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [updateId, reason.slice(0, 500)]);
          throw err;
        }
        await withTx(runtime.pool, async (tx) => {
          await tx.query(
            `UPDATE deal_room_updates
                SET status = $2, branch = $3, pr_url = $4, pr_number = $5, head_sha = $6, files = $7, manual_steps = $8, error = NULL, updated_at = now()
              WHERE id = $1`,
            [updateId, published.status, published.branch, published.prUrl, published.prNumber, published.headSha, JSON.stringify(published.files), JSON.stringify(published.manualSteps)],
          );
          await recordAudit(tx, {
            actor: SYSTEM_ACTOR,
            action: 'dealroom.pr.open',
            target: updateId,
            after: { repo, slug: params.slug, pr: published.prUrl, headSha: published.headSha, files: published.files.map((f) => f.path) },
          });
          await finalize(tx, proposal, ctx.recommendationId);
        });
        return {
          summary: `Deal room pull request opened: ${published.prUrl}. Patcher does not merge it; merging makes the proposal live to everyone in the room.`,
          detail: `Still to do by hand:\n${published.manualSteps.map((s) => `- ${s}`).join('\n')}`,
          externalRef: published.prUrl,
        };
      },
    })
    .registerAction({
      type: DEALROOM_API_ACTION,
      params: apiWriteParams,
      describe: (p) =>
        `Find the deal room for ${p.company} at ${p.origin} by Patcher's own reference, or create it as a draft${p.slug ? ` (with the slug "${p.slug}" a person saved: a room that already has that slug and no reference is linked to this deal)` : ''}. If the room is a draft, write proposal v${p.version} into it as ${p.files} ${p.files === 1 ? 'file' : 'files'}; clients cannot open a draft room. If the room is not a draft, or a person edited its files, nothing is written and Patcher asks again. The proposal is marked final either way. The room's status is not changed.`,
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        const context = await roomContext(runtime, params);
        const { adapter, proposal, deal } = context;
        if (deal.dealRoomSlug !== params.slug) throw new Error('The deal room slug changed after the approval was given, so nothing was sent. Approve the current version.');
        const prepared = adapter.prepareUpdate({ title: proposal.title, contentMd: proposal.contentMd });
        if (prepared.filesHash !== params.filesHash) throw new Error('The deal room files are not the ones that were approved, so nothing was sent.');

        // One update per approval. A retry of the same approval continues it.
        const row = await runtime.pool.query<{ id: string }>(
          `INSERT INTO deal_room_updates (deal_id, proposal_id, route, slug, origin, files, status, recommendation_id)
           VALUES ($1, $2, 'api', $3, $4, $5, 'prepared', $6)
           ON CONFLICT (recommendation_id) DO UPDATE SET status = 'prepared', error = NULL, updated_at = now()
           RETURNING id`,
          [deal.id, proposal.id, params.slug ?? '', context.origin, JSON.stringify(prepared.files.map((f) => ({ path: f.path, hash: f.hash }))), ctx.recommendationId],
        );
        return writeRoom(runtime, context, { prepared, updateId: row.rows[0]!.id, confirm: null, recommendationId: ctx.recommendationId, failStatus: 'failed' });
      },
    })
    .registerAction({
      type: DEALROOM_CONFIRM_ACTION,
      params: confirmWriteParams,
      describe: (p) => {
        const edits = p.replaces + p.removes ? ` It replaces ${p.replaces} and removes ${p.removes} ${p.replaces + p.removes === 1 ? 'file' : 'files'} that a person edited in the room.` : '';
        return p.roomStatus === 'DRAFT'
          ? `Write proposal v${p.version} for ${p.company} (${p.files} ${p.files === 1 ? 'file' : 'files'}) into its draft deal room at ${p.origin}.${edits} Clients cannot open a draft room. The room's status is not changed.`
          : `Write proposal v${p.version} for ${p.company} (${p.files} ${p.files === 1 ? 'file' : 'files'}) into its deal room at ${p.origin}, which is ${p.roomStatus}. The new text shows at once to everyone who can open the room: ${audienceText(p)}.${edits} The room's status is not changed.`;
      },
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        const context = await roomContext(runtime, params);
        const { adapter, proposal, deal } = context;
        const update = updateFromRow(await updateRow(runtime.pool, params.updateId, proposal.id));
        if (update.status === 'draft_written' || update.status === 'published') return { summary: 'These files were already written to the deal room. Nothing was sent again.', ...(update.roomUrl ? { externalRef: update.roomUrl } : {}) };
        if (update.status !== 'held') throw new Error('These files are no longer waiting to be written, so nothing was sent.');
        if (update.roomId !== params.roomId || deal.dealRoomRef !== params.roomId) throw new Error('The deal is linked to another room now, so nothing was sent.');
        // Anything a client can see is written only while the publish setting is on.
        if (params.roomStatus !== 'DRAFT' && !(await getSetting(runtime.pool, 'sales.dealroom_publish'))) throw new Error(PUBLISH_OFF);
        const prepared = adapter.prepareUpdate({ title: proposal.title, contentMd: proposal.contentMd });
        if (prepared.filesHash !== params.filesHash) throw new Error('The deal room files are not the ones that were approved, so nothing was sent.');
        const confirm: WriteConfirmation = {
          status: params.roomStatus,
          planHash: params.planHash,
          audience: { members: params.members, invites: params.invites, domains: params.domains },
        };
        const result = await writeRoom(runtime, context, { prepared, updateId: update.id, confirm, recommendationId: ctx.recommendationId, failStatus: null });
        const after = await runtime.pool.query<{ status: string }>('SELECT status FROM deal_room_updates WHERE id = $1', [update.id]);
        if (after.rows[0]?.status !== 'held') return result;
        return { ...result, summary: `The room is not as it was when you were asked, so nothing was written. Patcher asks again with what it found. ${result.summary ?? ''}`.trim() };
      },
    })
    .registerAction({
      type: DEALROOM_PUBLISH_ACTION,
      params: publishParams,
      describe: (p) =>
        `Set the deal room for ${p.company} at ${p.origin} from DRAFT to ACTIVE. It then opens to ${audienceText(p)}. Nothing else in the room is changed, and nothing is sent to anyone.`,
      async execute(params) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        const { pool } = runtime;
        if (!(await getSetting(pool, 'sales.dealroom_publish'))) throw new Error(PUBLISH_OFF);
        const { adapter, proposal, deal, origin: address } = await roomContext(runtime, params);
        if (proposal.status !== 'final') throw new Error('The proposal is not final, so its room was not published.');
        const update = updateFromRow(await updateRow(pool, params.updateId, proposal.id));
        if (update.status === 'published') return { summary: 'The deal room was already published. Nothing was changed.', ...(update.roomUrl ? { externalRef: update.roomUrl } : {}) };
        if (update.status !== 'draft_written') throw new Error('The proposal is not in a draft room that Patcher wrote, so nothing was published.');
        if (update.roomId !== params.roomId || deal.dealRoomRef !== params.roomId) throw new Error('The deal is linked to another room now, so nothing was published.');

        let room: Room | null;
        let changed = false;
        let moved = false;
        try {
          room = await adapter.check(address, params.roomId);
          if (room?.status === 'DRAFT') {
            // The approver was told who the room opens to. If that is no longer so, they are asked again.
            moved = room.memberCount !== params.members || room.pendingInviteCount !== params.invites || room.allowedEmailDomains !== params.domains;
            if (!moved) ({ room, changed } = await adapter.activate(address, params.roomId));
          }
          await markOk(pool, 'dealroom_api');
        } catch (err) {
          await noteFailure(pool, update.id, null, err);
          throw err;
        }
        if (!room) {
          await pool.query(`UPDATE deal_room_updates SET status = 'closed', error = $2, updated_at = now() WHERE id = $1`, [update.id, 'The room no longer exists in the deal room.']);
          throw new Error('The room no longer exists in the deal room, so there was nothing to publish.');
        }
        const snapshot = snapshotOf(room);
        const url = roomUrl(address, room);
        if (moved) {
          await pool.query(`UPDATE deal_room_updates SET room = $2, room_url = $3, error = NULL, updated_at = now() WHERE id = $1`, [update.id, JSON.stringify(snapshot), url]);
          return { summary: `Who can open the room changed since you were asked (now ${audienceText(snapshot)}), so nothing was changed. Publish is offered again with the current numbers.`, externalRef: url };
        }
        if (!changed && room.status !== 'ACTIVE') {
          await pool.query(`UPDATE deal_room_updates SET status = 'closed', room = $2, room_url = $3, error = $4, updated_at = now() WHERE id = $1`, [
            update.id,
            JSON.stringify(snapshot),
            url,
            `The room was set to ${room.status} in the deal room.`,
          ]);
          return { summary: `The deal room was set to ${room.status} by a person, so Patcher changed nothing: ${url}.`, externalRef: url };
        }
        const live = room;
        await withTx(pool, async (tx) => {
          await tx.query(`UPDATE deal_room_updates SET status = 'published', room = $2, room_url = $3, error = NULL, updated_at = now() WHERE id = $1`, [update.id, JSON.stringify(snapshot), url]);
          await recordAudit(tx, {
            actor: SYSTEM_ACTOR,
            action: changed ? 'dealroom.api.publish' : 'dealroom.api.published_elsewhere',
            target: update.id,
            before: { status: changed ? 'DRAFT' : live.status },
            after: { room: live.id, status: live.status },
          });
        });
        return {
          summary: changed
            ? `The deal room is now ${room.status}: ${url}. It is open to ${audienceText(snapshot)}.`
            : `The deal room was already ${room.status} when Patcher looked, so Patcher changed nothing: ${url}.`,
          externalRef: url,
        };
      },
    });
}
