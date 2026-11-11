import { SignJWT } from 'jose';
import { parseGitHubPrivateKey } from '../github/client.js';
import { SLUG } from '../sales/types.js';

/**
 * The only code that writes to GitHub, and it can do one thing: open a pull request on the
 * deal room repository that adds or changes files under `content/<slug>/`.
 *
 * What makes that true, in this file:
 *   - It uses its own GitHub App credentials, separate from the read-only audit app, and asks
 *     for an installation token narrowed to the one repository with `contents: write` and
 *     `pull_requests: write` and nothing else.
 *   - Every file path must sit under `content/<slug>/`. A path with `..` or an unexpected
 *     character is refused before any request is made.
 *   - Commits are created on a new branch under `patcher/`. No request updates an existing
 *     ref, so the default branch is never pushed to.
 *   - There is no merge call, no delete call and no call that closes a pull request. `write`
 *     refuses any path that is not one of the four it needs.
 */
export const DEALROOM_GITHUB_API_URL = 'https://api.github.com';

export class DealRoomError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface DealRoomRepoOptions {
  appId: string;
  privateKey: string;
  installationId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface OpenPullRequestInput {
  repo: string;
  slug: string;
  /** Must start with `patcher/`. */
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  /** Paths relative to the repository root. Each must be under `content/<slug>/`. */
  files: { path: string; content: string }[];
}

export interface OpenedPullRequest {
  url: string;
  number: number;
  headSha: string;
  base: string;
  /** True when an earlier attempt had already pushed the branch and this call only finished the job. */
  reused: boolean;
}

export interface DealRoomRepo {
  /** Paths of the files under `content/<slug>/`, relative to that folder. Empty when the folder does not exist. */
  listFolder(repo: string, slug: string): Promise<string[]>;
  openPullRequest(input: OpenPullRequestInput): Promise<OpenedPullRequest>;
  pullRequest(repo: string, number: number): Promise<{ state: 'open' | 'merged' | 'closed'; headSha: string | null }>;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^patcher\/[a-z0-9][a-z0-9/-]{0,90}$/;
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const WRITE_PATHS = /^\/repos\/[^/]+\/[^/]+\/(git\/trees|git\/commits|git\/refs|pulls)$/;
const MAX_FILES = 40;

/** The folder a deal's content lives in. Everything this client writes is inside it. */
export const contentPrefix = (slug: string): string => `content/${slug}/`;

export function assertContentPath(slug: string, path: string): void {
  if (!SLUG.test(slug)) throw new DealRoomError('The deal room slug is not valid.');
  const prefix = contentPrefix(slug);
  if (!path.startsWith(prefix) || path.length <= prefix.length || !FILE_PATH.test(path) || path.includes('..') || path.includes('//') || path.endsWith('/')) {
    throw new DealRoomError(`Refused to write outside content/${slug}/: ${path.slice(0, 120)}`);
  }
}

export function createDealRoomRepo(options: DealRoomRepoOptions): DealRoomRepo {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? DEALROOM_GITHUB_API_URL).replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const key = parseGitHubPrivateKey(options.privateKey);
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  const send = async (method: 'GET' | 'POST', path: string, auth: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | unknown[] }> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${auth}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'patcher-dealroom',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DealRoomError(`GitHub did not answer (${err instanceof Error ? err.name : 'error'})`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown> | unknown[] };
  };

  const fail = (what: string, result: { status: number; body: Record<string, unknown> | unknown[] }): never => {
    const message = !Array.isArray(result.body) && typeof result.body.message === 'string' ? result.body.message : 'request failed';
    throw new DealRoomError(`GitHub: ${what}: ${message.slice(0, 160)} (HTTP ${result.status})`, result.status);
  };

  const repoName = (repo: string): string => {
    if (!REPO.test(repo)) throw new DealRoomError(`Not a repository name: ${repo.slice(0, 80)}`);
    return repo.split('/')[1]!;
  };

  /** A token that can write contents and pull requests on this one repository, and nothing else. */
  const tokenFor = async (repo: string): Promise<string> => {
    const cached = tokens.get(repo);
    if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.token;
    const seconds = Math.floor(now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.appId)
      .setIssuedAt(seconds - 60)
      .setExpirationTime(seconds + 9 * 60)
      .sign(key);
    const result = await send('POST', `/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`, jwt, {
      repositories: [repoName(repo)],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    if (result.status >= 300) fail('the deal room app could not get a token for the repository', result);
    const body = result.body as { token?: string; expires_at?: string };
    if (!body.token) throw new DealRoomError('GitHub: the installation token response had no token');
    tokens.set(repo, { token: body.token, expiresAt: Date.parse(body.expires_at ?? '') || now() + 55 * 60_000 });
    return body.token;
  };

  const read = async (repo: string, path: string) => send('GET', `/repos/${repo}${path}`, await tokenFor(repo));

  const write = async (repo: string, path: string, body: unknown) => {
    const full = `/repos/${repo}${path}`;
    if (!WRITE_PATHS.test(full)) throw new DealRoomError(`Refused: ${path} is not a request this client makes.`);
    return send('POST', full, await tokenFor(repo), body);
  };

  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

  const listDir = async (repo: string, path: string, depth: number): Promise<string[]> => {
    const result = await read(repo, `/contents/${path}`);
    if (result.status === 404) return [];
    if (result.status >= 300) fail(`could not list ${path}`, result);
    if (!Array.isArray(result.body)) return [];
    const out: string[] = [];
    for (const entry of result.body.slice(0, 300)) {
      const item = obj(entry);
      const itemPath = str(item.path);
      if (!itemPath) continue;
      if (item.type === 'file') out.push(itemPath);
      else if (item.type === 'dir' && depth > 0 && FILE_PATH.test(itemPath)) out.push(...(await listDir(repo, itemPath, depth - 1)));
    }
    return out;
  };

  return {
    async listFolder(repo, slug) {
      repoName(repo);
      if (!SLUG.test(slug)) throw new DealRoomError('The deal room slug is not valid.');
      const prefix = contentPrefix(slug);
      return (await listDir(repo, prefix.slice(0, -1), 1)).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    },

    async openPullRequest(input) {
      repoName(input.repo);
      if (!BRANCH.test(input.branch)) throw new DealRoomError('Refused: the branch is not under patcher/.');
      if (!input.files.length) throw new DealRoomError('There is no file to put in the pull request.');
      if (input.files.length > MAX_FILES) throw new DealRoomError('Too many files for one pull request.');
      for (const file of input.files) assertContentPath(input.slug, file.path);

      const repoInfo = await read(input.repo, '');
      if (repoInfo.status >= 300) fail('could not read the repository', repoInfo);
      const base = str(obj(repoInfo.body).default_branch);
      if (!base) throw new DealRoomError('GitHub: the repository has no default branch');
      // The head of the default branch is read, never written.
      const baseRef = await read(input.repo, `/git/ref/heads/${encodeURIComponent(base)}`);
      if (baseRef.status >= 300) fail('could not read the default branch', baseRef);
      const baseSha = str(obj(obj(baseRef.body).object).sha);
      if (!baseSha) throw new DealRoomError('GitHub: the default branch has no commit');

      const openPull = async (reused: boolean): Promise<OpenedPullRequest> => {
        const created = await write(input.repo, '/pulls', { title: input.title.slice(0, 200), head: input.branch, base, body: input.body.slice(0, 60_000) });
        if (created.status >= 300) fail('could not open the pull request', created);
        const pull = obj(created.body);
        const url = str(pull.html_url);
        const headSha = str(obj(pull.head).sha);
        if (!url || typeof pull.number !== 'number' || !headSha) throw new DealRoomError('GitHub: the pull request response was incomplete');
        return { url, number: pull.number, headSha, base, reused };
      };

      // An earlier attempt may have pushed the branch and stopped before the pull request existed.
      const existing = await read(input.repo, `/git/ref/heads/${input.branch}`);
      if (existing.status !== 404) {
        if (existing.status >= 300) fail('could not check the branch', existing);
        const owner = input.repo.split('/')[0]!;
        const pulls = await read(input.repo, `/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branch}`)}&per_page=5`);
        if (pulls.status >= 300) fail('could not look for an existing pull request', pulls);
        const found = Array.isArray(pulls.body) ? obj(pulls.body[0]) : {};
        if (typeof found.number === 'number') {
          const url = str(found.html_url);
          const headSha = str(obj(found.head).sha);
          if (found.state !== 'open' || !url || !headSha) throw new DealRoomError('A pull request from this branch exists and is no longer open. Regenerate the proposal to open a new one.');
          return { url, number: found.number, headSha, base, reused: true };
        }
        // The branch is ours by name; before asking for review, confirm it touches nothing outside the deal's folder.
        const compare = await read(input.repo, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(input.branch)}`);
        if (compare.status >= 300) fail('could not compare the branch', compare);
        const changed = obj(compare.body).files;
        const outside = (Array.isArray(changed) ? changed : [null]).some((f) => !str(obj(f).filename)?.startsWith(contentPrefix(input.slug)));
        if (outside) throw new DealRoomError(`The branch ${input.branch} exists and changes files outside content/${input.slug}/. Nothing was opened.`);
        return openPull(true);
      }

      const baseCommit = await read(input.repo, `/git/commits/${baseSha}`);
      if (baseCommit.status >= 300) fail('could not read the head commit', baseCommit);
      const baseTree = str(obj(obj(baseCommit.body).tree).sha);
      if (!baseTree) throw new DealRoomError('GitHub: the head commit has no tree');

      const tree = await write(input.repo, '/git/trees', {
        base_tree: baseTree,
        tree: input.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
      });
      if (tree.status >= 300) fail('could not write the files', tree);
      const treeSha = str(obj(tree.body).sha);
      if (!treeSha) throw new DealRoomError('GitHub: the tree response had no sha');
      if (treeSha === baseTree) throw new DealRoomError('The deal room already has exactly this content, so there is nothing to open a pull request for.');

      const commit = await write(input.repo, '/git/commits', { message: input.commitMessage.slice(0, 300), tree: treeSha, parents: [baseSha] });
      if (commit.status >= 300) fail('could not create the commit', commit);
      const commitSha = str(obj(commit.body).sha);
      if (!commitSha) throw new DealRoomError('GitHub: the commit response had no sha');

      const ref = await write(input.repo, '/git/refs', { ref: `refs/heads/${input.branch}`, sha: commitSha });
      if (ref.status >= 300) fail('could not create the branch', ref);
      return openPull(false);
    },

    async pullRequest(repo, number) {
      repoName(repo);
      const result = await read(repo, `/pulls/${Math.trunc(number)}`);
      if (result.status >= 300) fail('could not read the pull request', result);
      const pull = obj(result.body);
      return { state: pull.merged === true ? 'merged' : pull.state === 'closed' ? 'closed' : 'open', headSha: str(obj(pull.head).sha) };
    },
  };
}
