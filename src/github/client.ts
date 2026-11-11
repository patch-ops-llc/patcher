import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

/**
 * Read-only GitHub App client, built from GitHub's REST reference: an app JWT is exchanged
 * for an installation token, which reads the three things the audit needs. The app needs
 * the repository permissions Metadata: read, Contents: read and Dependabot alerts: read,
 * and no write permission.
 */
export const GITHUB_API_URL = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GitHubClient {
  defaultBranch(repo: string): Promise<string>;
  /** Commits on `head` that `base` does not have. */
  commitsAhead(repo: string, base: string, head: string): Promise<number>;
  openCriticalAlerts(repo: string): Promise<number>;
}

export interface GitHubClientOptions {
  appId: string;
  /** PEM, as downloaded from the app's settings. `\n` written as two characters is accepted. */
  privateKey: string;
  installationId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Throws if the key is not a usable private key, so a bad value is caught at boot. */
export function parseGitHubPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.replace(/\\n/g, '\n'));
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? GITHUB_API_URL).replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const key = parseGitHubPrivateKey(options.privateKey);
  let cached: { token: string; expiresAt: number } | undefined;

  const call = async (path: string, auth: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${auth}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'patcher-audit',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GitHubApiError(`GitHub did not answer (${err instanceof Error ? err.name : 'error'})`, 0);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const message = typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : 'request failed';
      throw new GitHubApiError(`GitHub: ${message.slice(0, 160)} (HTTP ${response.status})`, response.status);
    }
    return body;
  };

  const installationToken = async (): Promise<string> => {
    if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.token;
    const seconds = Math.floor(now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.appId)
      // Backdated a minute for clock drift, and well inside GitHub's ten-minute limit.
      .setIssuedAt(seconds - 60)
      .setExpirationTime(seconds + 9 * 60)
      .sign(key);
    const body = (await call(
      `/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
      jwt,
      'POST',
    )) as { token?: string; expires_at?: string };
    if (!body.token) throw new GitHubApiError('GitHub: the installation token response had no token', 200);
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at ?? '') || now() + 55 * 60_000 };
    return cached.token;
  };

  const get = async (path: string): Promise<unknown> => call(path, await installationToken());

  const repoPath = (repo: string): string => {
    if (!REPO.test(repo)) throw new GitHubApiError(`Not a repository name: ${repo.slice(0, 80)}`, 0);
    return `/repos/${repo}`;
  };

  return {
    async defaultBranch(repo) {
      const body = (await get(repoPath(repo))) as { default_branch?: string };
      if (!body.default_branch) throw new GitHubApiError('GitHub: the repository has no default branch', 200);
      return body.default_branch;
    },

    async commitsAhead(repo, base, head) {
      const body = (await get(
        `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      )) as { ahead_by?: number };
      if (typeof body.ahead_by !== 'number') throw new GitHubApiError('GitHub: the comparison had no commit count', 200);
      return body.ahead_by;
    },

    async openCriticalAlerts(repo) {
      const body = await get(`${repoPath(repo)}/dependabot/alerts?state=open&severity=critical&per_page=100`);
      if (!Array.isArray(body)) throw new GitHubApiError('GitHub: the alert list was not a list', 200);
      return body.length;
    },
  };
}
