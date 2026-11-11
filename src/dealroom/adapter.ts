import type { DealRoomRoute } from '../sales/types.js';
import { SLUG } from '../sales/types.js';
import type { PreparedUpdate } from './files.js';
import { prepareFiles } from './files.js';
import type { DealRoomRepo } from './github.js';
import { contentPrefix } from './github.js';

/**
 * The three methods of design 6.5. This phase has one implementation, which works against
 * the deal room's repository and ends at an open pull request.
 *
 * Phase 3b adds a second implementation that uses the app's service API (`route: 'api'`):
 * `findDeal` asks the app, `publish` writes into a draft deal. It plugs in where the worker
 * builds `integrations.dealRoom`; `deal_room_updates.route` and `deals.deal_room_ref` are
 * already there for it, and nothing else in the sales pipeline names GitHub.
 */
export interface FoundDeal {
  slug: string;
  /** Files already in the deal's content folder, relative to it. */
  existingFiles: string[];
}

export interface PublishContext {
  /** The repository, for the pull request route. */
  repo: string;
  company: string;
  proposalTitle: string;
  proposalVersion: number;
  /** Unique per approval; a retry of the same approval uses the same one. */
  updateId: string;
  appBaseUrl: string;
  proposalId: string;
}

export interface Published {
  route: DealRoomRoute;
  status: 'pr_open';
  repo: string;
  branch: string;
  prUrl: string;
  prNumber: number;
  headSha: string;
  /** What was written, relative to the repository root. */
  files: { path: string; hash: string }[];
  /** What a person must still do by hand. The same list is in the pull request. */
  manualSteps: string[];
}

export interface DealRoomAdapter {
  readonly route: DealRoomRoute;
  /** Null when Patcher has no slug for the deal: a person creates the room in the app and says what it is. */
  findDeal(repo: string, deal: { dealRoomSlug: string | null }): Promise<FoundDeal | null>;
  /** The proposal as the room's files, checked against the app's rules. Pure: the same proposal always gives the same files. */
  prepareUpdate(input: { slug: string; title: string; contentMd: string }): PreparedUpdate;
  publish(prepared: PreparedUpdate, found: FoundDeal, ctx: PublishContext): Promise<Published>;
  /** Where something published earlier stands now. */
  check(repo: string, update: { prNumber: number | null }): Promise<'open' | 'merged' | 'closed' | null>;
}

/** What a person must still do after the pull request exists (design 6.5, "what phase A does not cover"). */
export function manualSteps(input: { version: number; firstContent: boolean; leftAlone: string[]; stale: string[] }): string[] {
  const steps = [
    `In the app, under Deal Admin, enter the deal facts the Overview shows: investment, kickoff, go-live, proposal version (v${input.version}) and status. This pull request cannot set them.`,
    'If a file in this pull request was edited in the app, the app keeps showing its own copy. Reset that edit in Deal Admin for the new text to show.',
    input.firstContent
      ? 'This is the first content for this room. Keep the room without client domains or invites until someone has looked at it in the app.'
      : 'Check who can open the room before merging: the content is live to all of them as soon as the app has redeployed.',
    'No timeline or payment schedule visual (proposal/NN-name.json) is included. Add one by hand if a section should have it.',
  ];
  if (input.leftAlone.length) steps.push(`Already in the room and left as it is: ${input.leftAlone.join(', ')}. Change it by hand if the new proposal should replace it.`);
  if (input.stale.length) steps.push(`Section files from before that this pull request does not write: ${input.stale.join(', ')}. The room still shows them. Delete them in this pull request if they should go.`);
  return steps;
}

export function pullRequestBody(input: { ctx: PublishContext; slug: string; files: string[]; steps: string[] }): string {
  return [
    `Proposal v${input.ctx.proposalVersion} for ${input.ctx.company}: ${input.ctx.proposalTitle}`,
    '',
    `Opened by Patcher after the proposal was approved there (${input.ctx.appBaseUrl}/sales/proposals/${input.ctx.proposalId}). It adds or changes files under \`content/${input.slug}/\` and nothing else.`,
    '',
    '**Patcher does not merge this.** Merging redeploys the app, and the content is then live to everyone who can open the room.',
    '',
    '## Files',
    ...input.files.map((f) => `- \`${f}\``),
    '',
    '## Still to do by hand',
    ...input.steps.map((s) => `- [ ] ${s}`),
  ].join('\n');
}

/** Phase A: the deal room through its repository. */
export function createRepoAdapter(github: DealRoomRepo): DealRoomAdapter {
  return {
    route: 'pull_request',

    async findDeal(repo, deal) {
      const slug = deal.dealRoomSlug;
      if (!slug || !SLUG.test(slug)) return null;
      return { slug, existingFiles: await github.listFolder(repo, slug) };
    },

    prepareUpdate: prepareFiles,

    async publish(prepared, found, ctx) {
      if (prepared.problems.length) throw new Error(`The deal room files were not written: ${prepared.problems.slice(0, 3).join(' ')}`);
      const existing = new Set(found.existingFiles);
      // An overview that is already in the room was written by a person; the proposal does not replace it.
      const leftAlone = prepared.files.filter((f) => f.path === 'overview.md' && existing.has(f.path)).map((f) => f.path);
      const files = prepared.files.filter((f) => !leftAlone.includes(f.path));
      const written = new Set(files.map((f) => f.path));
      const stale = found.existingFiles.filter((p) => /^proposal\/[^/]+\.md$/.test(p) && !written.has(p)).sort();
      const steps = manualSteps({ version: ctx.proposalVersion, firstContent: found.existingFiles.length === 0, leftAlone, stale });
      const prefix = contentPrefix(prepared.slug);
      const branch = `patcher/${prepared.slug}/proposal-v${ctx.proposalVersion}-${ctx.updateId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
      const opened = await github.openPullRequest({
        repo: ctx.repo,
        slug: prepared.slug,
        branch,
        title: `Deal room content: ${ctx.company} proposal v${ctx.proposalVersion}`,
        body: pullRequestBody({ ctx, slug: prepared.slug, files: files.map((f) => `${prefix}${f.path}`), steps }),
        commitMessage: `content(${prepared.slug}): proposal v${ctx.proposalVersion}`,
        files: files.map((f) => ({ path: `${prefix}${f.path}`, content: f.content })),
      });
      return {
        route: 'pull_request',
        status: 'pr_open',
        repo: ctx.repo,
        branch,
        prUrl: opened.url,
        prNumber: opened.number,
        headSha: opened.headSha,
        files: files.map((f) => ({ path: `${prefix}${f.path}`, hash: f.hash })),
        manualSteps: steps,
      };
    },

    async check(repo, update) {
      if (update.prNumber === null) return null;
      return (await github.pullRequest(repo, update.prNumber)).state;
    },
  };
}
