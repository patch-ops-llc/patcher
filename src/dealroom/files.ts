import { createHash } from 'node:crypto';
import { markdownProblems, slugify, splitProposal, tablesToLists } from '../sales/markdown.js';
import { SLUG } from '../sales/types.js';

/**
 * A proposal in the deal room's own file layout (design 6.5, `prepareUpdate`): numbered
 * `proposal/NN-name.md` sections, each with a `title:` line, and an `overview.md`. This is
 * code, not a model step: the sections are the approved proposal's own, cut at its headings,
 * so what a person approved is what the files say.
 *
 * Every file is checked against what is known of the app's renderer before anything is
 * opened: links with the allowed schemes only, no images, no raw HTML. Tables become lists,
 * because the renderer is not known to draw them.
 *
 * Not written: the `proposal/NN-name.json` visuals (timeline, payment schedule). Their
 * accepted shapes are defined in the app's source, which this code has not been checked
 * against, and a file in a wrong shape would be worse than none. `visualsFor` is where
 * they are added once the shapes are confirmed.
 */
export interface DealRoomFile {
  /** Relative to the deal's folder, for example `proposal/01-summary.md`. */
  path: string;
  content: string;
  hash: string;
}

export interface PreparedUpdate {
  /** The content folder, on the pull request route. Empty on the service API route. */
  slug: string;
  files: DealRoomFile[];
  /** One hash over every path and content, which the approval is bound to. */
  filesHash: string;
  sections: number;
  /** Why the files cannot be published as they are. Empty when they can. */
  problems: string[];
}

export const MAX_FILES = 30;
const MAX_FILE_BYTES = 100_000;
const OVERVIEW_HEADING = /^(summary|overview|executive summary)$/i;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** One hash over every path and content hash, in order. What an approval of the files is bound to. */
export const filesHashOf = (files: { path: string; hash: string }[]): string => sha256(JSON.stringify(files.map((f) => [f.path, f.hash])));

/** A heading as a frontmatter value that any YAML reader, or a plain line reader, takes the same way. */
export function frontmatterTitle(heading: string): string {
  const safe = heading
    .replace(/[^A-Za-z0-9 ,.'&()/+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '');
  return (safe || 'Section').slice(0, 80);
}

/** The visuals a proposal's data supports. None yet: see the note at the top of this file. */
export function visualsFor(): DealRoomFile[] {
  return [];
}

/** `slug` names the content folder on the pull request route. The service API route has none to give. */
export function prepareFiles(input: { slug?: string; title: string; contentMd: string }): PreparedUpdate {
  const problems: string[] = [];
  if (input.slug !== undefined && !SLUG.test(input.slug)) problems.push('The deal room slug is not valid.');
  const doc = splitProposal(input.contentMd);
  const files: DealRoomFile[] = [];
  const add = (path: string, content: string) => files.push({ path, content, hash: sha256(content) });

  const title = frontmatterTitle(doc.title || input.title);
  const opening = doc.intro || doc.sections.find((s) => OVERVIEW_HEADING.test(s.heading.trim()))?.body || '';
  if (opening.trim()) add('overview.md', `# ${title}\n\n${tablesToLists(opening).trim()}\n`);

  const used = new Set<string>();
  doc.sections.forEach((section, index) => {
    const number = String(index + 1).padStart(2, '0');
    let name = slugify(section.heading);
    while (used.has(name)) name = `${name}-${number}`;
    used.add(name);
    add(`proposal/${number}-${name}.md`, `---\ntitle: ${frontmatterTitle(section.heading)}\n---\n\n${tablesToLists(section.body).trim()}\n`);
  });
  files.push(...visualsFor());

  if (!doc.sections.length) problems.push('The proposal has no sections (headings that start with "## "), so there is nothing to put in the room.');
  if (files.length > MAX_FILES) problems.push(`The proposal would make ${files.length} files; the most is ${MAX_FILES}.`);
  for (const file of files) {
    if (!/^[a-z0-9][a-z0-9./-]*$/.test(file.path) || file.path.includes('..') || file.path.includes('//')) problems.push(`${file.path}: not a path the deal room uses.`);
    if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) problems.push(`${file.path}: too long.`);
    for (const problem of markdownProblems(file.content.replace(/^---\n[\s\S]*?\n---\n/, ''))) problems.push(`${file.path}: contains ${problem}, which the deal room does not show.`);
  }

  return {
    slug: input.slug ?? '',
    files,
    filesHash: filesHashOf(files),
    sections: doc.sections.length,
    problems,
  };
}
