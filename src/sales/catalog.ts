import { z } from 'zod';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, PoolClient } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { DealRoomAdapter } from '../dealroom/adapter.js';
import type { Catalog } from '../recommendations/catalog.js';
import { getSetting } from '../settings/settings.js';
import { getDeal, getProposal } from './store.js';
import type { DealRoomUpdateRow, Proposal } from './types.js';
import { PROPOSAL_KIND, SLUG } from './types.js';

/**
 * What approving a proposal can do (design 6.2 and 6.5). Both actions are bound to one
 * version of the proposal by its content hash: a proposal that changed after the approval
 * was given is not acted on.
 *
 *   - `sales.finalize_proposal` marks the proposal final and gives back the PDF link for a
 *     person to send. Patcher sends nothing to the prospect.
 *   - `sales.open_dealroom_pr` does the same and opens a pull request with the proposal as
 *     content files in the deal room's repository. It never merges.
 */
export const FINALIZE_ACTION = 'sales.finalize_proposal';
export const DEALROOM_PR_ACTION = 'sales.open_dealroom_pr';

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

/** What the actions need at run time. The public service registers them without one. */
export interface SalesRuntime {
  pool: Pool;
  appBaseUrl: string;
  /** Null until the deal room's GitHub App variables are set on the worker. */
  dealRoom: DealRoomAdapter | null;
}

export const DEALROOM_NOT_CONFIGURED =
  'The deal room GitHub App is not configured on the worker (DEALROOM_GITHUB_APP_ID, DEALROOM_GITHUB_APP_PRIVATE_KEY, DEALROOM_GITHUB_APP_INSTALLATION_ID).';

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

export function registerSalesCatalog(catalog: Catalog, runtime: SalesRuntime | null): Catalog {
  return catalog
    .registerKind({ kind: PROPOSAL_KIND, label: 'Proposal', defaultReportType: 'sales' })
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
        const repo = await getSetting(runtime.pool, 'sales.dealroom_repo');
        if (repo !== params.repo) throw new Error('The deal room repository in Settings changed after the approval was given, so nothing was opened.');

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
    });
}
