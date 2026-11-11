import { createHash } from 'node:crypto';
import type { DealRoomFile } from './files.js';
import type { RoomFile } from './service.js';

/**
 * What writing a proposal's files to a room would do, worked out from the files and from
 * what the room holds now. Pure: it reads nothing and writes nothing.
 *
 * The rules:
 *   - A file with the text the room already shows is not sent.
 *   - `overview.md` is written only when the room has none, or the bot wrote the one it has.
 *     An overview a person wrote, or one in the repository, is left as it is.
 *   - A section file replaces what is stored at its path. When a person wrote what is stored,
 *     the path is listed in `personEdits`: the write may go ahead only with a person's yes.
 *   - A section file of an earlier version that the new proposal does not have is removed
 *     when it is stored in the app. One that exists only in the repository cannot be removed
 *     through the API and is named for a person to delete.
 *   - Two section files may not share a name ("02-scope" and "05-scope"). Where one of them
 *     cannot be removed by this write, the plan says so and nothing is written.
 */
export type ChangeAuthor = 'service' | 'person' | 'repository';

export interface RoomChange {
  path: string;
  /** add: new in the room. replace: other text is there. same: nothing to do. remove: taken out. keep: left as it is. */
  change: 'add' | 'replace' | 'same' | 'remove' | 'keep';
  /** Who wrote what the room has at the path now. Null when it has nothing. */
  by: ChangeAuthor | null;
}

export interface WritePlan {
  files: { path: string; body: string }[];
  remove: string[];
  changes: RoomChange[];
  /** Paths where a person's text would be replaced or removed. */
  personEdits: string[];
  /** Files of the proposal that are not written because the room's own copy stays. */
  leftAlone: string[];
  /** Earlier section files that live in the repository, which the API cannot remove. */
  repositoryStale: string[];
  /** Why the plan cannot be carried out at all. Empty when it can. */
  problems: string[];
  /** Over what would be sent and whose text it replaces. A confirmation is bound to it. */
  hash: string;
}

const SECTION = /^proposal\/(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(md|json)$/;
const WRITABLE = /^(?:overview\.md|proposal\/\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;
const MAX_PATH = 120;
const MAX_BODY = 400_000;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const authorOf = (file: RoomFile): ChangeAuthor => (file.stored ? (file.updatedBy === 'service' ? 'service' : 'person') : 'repository');
const sectionKey = (path: string): string | null => SECTION.exec(path)?.[2] ?? null;

export function planWrite(prepared: DealRoomFile[], existing: RoomFile[]): WritePlan {
  const have = new Map(existing.map((f) => [f.path, f]));
  const wanted = new Set(prepared.map((f) => f.path));
  const plan: Omit<WritePlan, 'hash'> = { files: [], remove: [], changes: [], personEdits: [], leftAlone: [], repositoryStale: [], problems: [] };

  for (const file of prepared) {
    if (!WRITABLE.test(file.path) || file.path.length > MAX_PATH) {
      plan.problems.push(`${file.path}: not a path the deal room accepts.`);
      continue;
    }
    if (!file.content.trim() || file.content.length > MAX_BODY) {
      plan.problems.push(`${file.path}: ${file.content.trim() ? 'too long for the deal room' : 'empty'}.`);
      continue;
    }
    const current = have.get(file.path);
    if (!current) {
      plan.files.push({ path: file.path, body: file.content });
      plan.changes.push({ path: file.path, change: 'add', by: null });
      continue;
    }
    const by = authorOf(current);
    if (current.body === file.content) {
      plan.changes.push({ path: file.path, change: 'same', by });
      continue;
    }
    if (file.path === 'overview.md' && by !== 'service') {
      plan.leftAlone.push(file.path);
      plan.changes.push({ path: file.path, change: 'keep', by });
      continue;
    }
    plan.files.push({ path: file.path, body: file.content });
    plan.changes.push({ path: file.path, change: 'replace', by });
    if (by === 'person') plan.personEdits.push(file.path);
  }

  // Section files of an earlier version.
  const stale = existing.filter((f) => SECTION.test(f.path) && !wanted.has(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  /** Section files the room still has after the write, by name. */
  const remaining = new Map<string, string>();
  for (const file of prepared) {
    const key = sectionKey(file.path);
    if (key) remaining.set(key, file.path);
  }
  const staysAfter = new Set<string>();
  for (const file of stale.filter((f) => f.path.endsWith('.md'))) {
    const by = authorOf(file);
    if (file.stored) {
      plan.remove.push(file.path);
      plan.changes.push({ path: file.path, change: 'remove', by });
      if (by === 'person') plan.personEdits.push(file.path);
    }
    // The repository's copy shows again once the stored one is gone, and cannot be removed here.
    if (file.inRepository) {
      plan.repositoryStale.push(file.path);
      staysAfter.add(file.path);
      if (!file.stored) plan.changes.push({ path: file.path, change: 'keep', by });
      const key = sectionKey(file.path)!;
      const clash = remaining.get(key);
      if (clash) {
        plan.problems.push(
          `Two section files would share the name "${key}": ${file.path}, which is in the deal room repository, and ${clash}. Delete the older file in the repository, or rename the section in the proposal.`,
        );
      } else {
        remaining.set(key, file.path);
      }
    }
  }
  // A visual sits above its section. It goes when its section goes, and stays otherwise.
  for (const file of stale.filter((f) => f.path.endsWith('.json'))) {
    const by = authorOf(file);
    const section = file.path.replace(/\.json$/, '.md');
    const sectionStays = wanted.has(section) || staysAfter.has(section);
    if (sectionStays || !file.stored) {
      plan.changes.push({ path: file.path, change: 'keep', by });
      continue;
    }
    plan.remove.push(file.path);
    plan.changes.push({ path: file.path, change: 'remove', by });
    if (by === 'person') plan.personEdits.push(file.path);
  }

  plan.personEdits.sort();
  plan.changes.sort((a, b) => a.path.localeCompare(b.path));
  const hash = sha256(JSON.stringify([plan.files.map((f) => [f.path, sha256(f.body)]), plan.remove, plan.personEdits]));
  return { ...plan, hash };
}
