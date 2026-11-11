import type { DealRoomRoute } from '../sales/types.js';
import { SLUG } from '../sales/types.js';
import type { PreparedUpdate } from './files.js';
import { prepareFiles } from './files.js';
import type { DealRoomRepo } from './github.js';
import { contentPrefix } from './github.js';
import type { WritePlan } from './plan.js';
import { planWrite } from './plan.js';
import type { DealRoomService, Room, RoomFacts, RoomStatus } from './service.js';
import { DealRoomServiceError, RESERVED_SLUGS, ROOM_ID, ROOM_SLUG } from './service.js';

/**
 * The three methods of design 6.5: `findDeal`, `prepareUpdate` and `publish`. There are two
 * implementations, and Settings says which one an approved Penguin proposal uses.
 *
 *   - `createRepoAdapter` (`route: 'pull_request'`, phase A) works against the deal room's
 *     repository and ends at an open pull request that a person merges.
 *   - `createServiceAdapter` (`route: 'api'`, phase B) uses the app's service API: `findDeal`
 *     finds or creates the deal by Patcher's own reference, `publish` writes the files into
 *     it. Nothing in it runs before the proposal is approved.
 *
 * The worker builds both where it builds `integrations`, each only when its own variables
 * are set. The pull request route stays as it was, as the fallback.
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
  prepareUpdate(input: { slug?: string; title: string; contentMd: string }): PreparedUpdate;
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

// The service API route -----------------------------------------------------------------------

/** Patcher's own reference for a deal, which the deal room keeps unique. */
export const externalRefFor = (dealId: string): string => `patcher:deal:${dealId}`;

export interface FoundRoom {
  room: Room;
  /** The room did not exist and was created, as a draft with no client domains. */
  created: boolean;
  /** A room a person made by hand was given Patcher's reference. Nothing a client sees changed. */
  linked: boolean;
}

/**
 * A person's explicit yes to writing into this room, taken from the approval that was just
 * given. Without one, `publish` writes only into a draft room that holds no person's edits.
 */
export interface WriteConfirmation {
  /** The status the person was shown. A live write goes ahead only while the room still has it. */
  status: RoomStatus;
  /** The plan the person was shown. A person's edits are replaced only while the plan is still that one. */
  planHash: string;
  /** Who could open the room when the person was asked. A live write goes ahead only while that is still so. */
  audience: { members: number; invites: number; domains: number };
}

export type HoldReason = 'live' | 'edited';

export type ServicePublished =
  | {
      outcome: 'written';
      room: Room;
      plan: WritePlan;
      written: string[];
      removed: string[];
      /** The room was not a draft, and the write was sent with `confirmLive`. */
      live: boolean;
      manualSteps: string[];
    }
  | { outcome: 'held'; room: Room; plan: WritePlan; reasons: HoldReason[] };

export interface ServiceDealRoomAdapter {
  readonly route: 'api';
  /**
   * Finds the room by Patcher's reference or creates it as a draft. With a slug a person
   * saved for the deal, a room that already has that slug and no reference is linked.
   */
  findDeal(origin: string, deal: { id: string; company: string; dealRoomSlug: string | null }, facts: RoomFacts): Promise<FoundRoom>;
  prepareUpdate(input: { title: string; contentMd: string }): PreparedUpdate;
  /**
   * Writes the files, or holds them. It writes without a confirmation only when the room is a
   * draft and no person's text would be lost. `confirmLive` is sent only with a confirmation
   * for the status the room has now.
   */
  publish(origin: string, found: FoundRoom, prepared: PreparedUpdate, options: { version: number; facts: RoomFacts; confirm: WriteConfirmation | null }): Promise<ServicePublished>;
  /** Draft to active, and nothing else. The one call that changes a room's status. */
  activate(origin: string, roomId: string): Promise<{ room: Room; changed: boolean }>;
  /** The room as it is now. Null when the app no longer has it. Reads only. */
  check(origin: string, roomId: string): Promise<Room | null>;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** What a person must still do after the files are in the room. */
export function serviceManualSteps(input: { version: number; created: boolean; live: boolean; plan: WritePlan; factsNotSet: boolean }): string[] {
  const steps = [
    input.factsNotSet
      ? `The room was published while Patcher was writing, so the proposal version on the Overview was not set. Enter v${input.version} in Deal Admin.`
      : `Patcher set the proposal version (v${input.version}) and its date. Enter the other facts the Overview shows in Deal Admin: investment, kickoff and go-live.`,
    input.live
      ? 'The room is live: the new text shows now to everyone who can open it.'
      : input.created
        ? 'The room is a new draft with no members, invites or client domains. Add them in the deal room admin when it should be shared.'
        : 'The room is a draft: clients cannot open it. Look at it in the app before it is published.',
    'No timeline or payment schedule visual (proposal/NN-name.json) is included. Add one by hand if a section should have it.',
  ];
  if (input.plan.leftAlone.length) steps.push(`Already in the room and left as it is: ${input.plan.leftAlone.join(', ')}. Change it by hand if the new proposal should replace it.`);
  if (input.plan.repositoryStale.length) {
    steps.push(`Section files from before that live in the deal room repository, which the API cannot remove: ${input.plan.repositoryStale.join(', ')}. The room still shows them. Delete them in the repository if they should go.`);
  }
  return steps;
}

/** Phase B: the deal room through its service API. */
export function createServiceAdapter(service: DealRoomService): ServiceDealRoomAdapter {
  const factsToSet = (room: Room, facts: RoomFacts): RoomFacts => ({
    ...(facts.proposalVersion !== undefined && facts.proposalVersion !== room.proposalVersion ? { proposalVersion: facts.proposalVersion } : {}),
    ...(facts.proposalUpdatedAt !== undefined && facts.proposalUpdatedAt !== room.proposalUpdatedAt ? { proposalUpdatedAt: facts.proposalUpdatedAt } : {}),
  });

  return {
    route: 'api',

    async findDeal(origin, deal, facts) {
      const clientName = oneLine(deal.company).slice(0, 200);
      if (!clientName) throw new Error('The deal has no company name, which the deal room needs.');
      const slug = deal.dealRoomSlug;
      if (slug !== null) {
        if (!ROOM_SLUG.test(slug)) throw new Error(`The slug "${slug}" is not one the deal room accepts: lower-case letters and digits with single dashes between them, at most 60. Save another on the deal.`);
        if (RESERVED_SLUGS.includes(slug)) throw new Error(`The slug "${slug}" is one the deal room uses itself. Save another on the deal.`);
      }
      try {
        const { room, created } = await service.findOrCreate(origin, { externalRef: externalRefFor(deal.id), clientName, ...(slug ? { slug } : {}), facts });
        return { room, created, linked: false };
      } catch (err) {
        if (!(err instanceof DealRoomServiceError) || err.code !== 'slug_taken') throw err;
        const existing = (err.details.existing ?? {}) as Record<string, unknown>;
        const taken = typeof existing.slug === 'string' ? existing.slug : (slug ?? 'that slug');
        const what = `${typeof existing.name === 'string' ? oneLine(existing.name).slice(0, 80) : 'a room'}${typeof existing.status === 'string' ? `, ${existing.status}` : ''}`;
        if (slug === null) {
          throw new DealRoomServiceError(
            `The deal room already has a room at "${taken}" (${what}) that is not linked to this deal, so nothing was created or written. If it is this deal's room, save "${taken}" as the slug on the deal in Patcher. If it is another deal's, save a different slug for a new room.`,
            409,
            'slug_taken',
          );
        }
        if (existing.externalRef !== null || existing.slug !== slug || typeof existing.id !== 'string' || !ROOM_ID.test(existing.id)) {
          throw new DealRoomServiceError(`The room "${taken}" (${what}) is linked to another deal, so nothing was written. Save a different slug on the deal in Patcher.`, 409, 'slug_taken');
        }
        // A person named this room for the deal, and approved writing to it. Setting the
        // reference changes nothing a client sees and is allowed on a live room.
        const room = await service.update(origin, existing.id, { externalRef: externalRefFor(deal.id) });
        return { room, created: false, linked: true };
      }
    },

    prepareUpdate: (input) => prepareFiles(input),

    async publish(origin, found, prepared, options) {
      if (prepared.problems.length) throw new Error(`The deal room files were not written: ${prepared.problems.slice(0, 3).join(' ')}`);
      let room = found.room;
      const content = await service.content(origin, room.id, { bodies: true });
      const plan = planWrite(prepared.files, content.files);
      if (plan.problems.length) throw new Error(`Nothing was written to the deal room: ${plan.problems.slice(0, 3).join(' ')}`);

      const live = room.status !== 'DRAFT';
      const reasons: HoldReason[] = [];
      const confirmed = options.confirm;
      const sameAudience =
        confirmed !== null &&
        confirmed.audience.members === room.memberCount &&
        confirmed.audience.invites === room.pendingInviteCount &&
        confirmed.audience.domains === room.allowedEmailDomains;
      if (live && !(confirmed?.status === room.status && sameAudience)) reasons.push('live');
      if (plan.personEdits.length && options.confirm?.planHash !== plan.hash) reasons.push('edited');
      if (reasons.length) return { outcome: 'held', room, plan, reasons };

      let written: string[] = [];
      let removed: string[] = [];
      if (plan.files.length || plan.remove.length) {
        try {
          const result = await service.writeContent(origin, room.id, { files: plan.files, remove: plan.remove, ...(live ? { confirmLive: true as const } : {}) });
          written = result.written;
          removed = result.removed;
        } catch (err) {
          // Published by a person between the read and the write. Nothing was written.
          if (!live && err instanceof DealRoomServiceError && err.code === 'deal_not_draft') {
            return { outcome: 'held', room: await service.get(origin, room.id), plan, reasons: ['live'] };
          }
          throw err;
        }
      }

      const facts = factsToSet(room, options.facts);
      let factsNotSet = false;
      if (Object.keys(facts).length) {
        try {
          room = await service.update(origin, room.id, { facts, ...(live ? { confirmLive: true as const } : {}) });
        } catch (err) {
          if (live || !(err instanceof DealRoomServiceError) || err.code !== 'deal_not_draft') throw err;
          factsNotSet = true;
          room = await service.get(origin, room.id);
        }
      }
      return {
        outcome: 'written',
        room,
        plan,
        written,
        removed,
        live,
        manualSteps: serviceManualSteps({ version: options.version, created: found.created, live, plan, factsNotSet }),
      };
    },

    async activate(origin, roomId) {
      const room = await service.get(origin, roomId);
      if (room.status !== 'DRAFT') return { room, changed: false };
      return { room: await service.update(origin, roomId, { publish: true }), changed: true };
    },

    async check(origin, roomId) {
      try {
        return await service.get(origin, roomId);
      } catch (err) {
        if (err instanceof DealRoomServiceError && err.code === 'deal_not_found') return null;
        throw err;
      }
    },
  };
}
