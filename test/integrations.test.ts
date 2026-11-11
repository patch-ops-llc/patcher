import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadWorkerConfig } from '../src/config.js';
import { CursorApiError, TERMINAL_RUN_STATUSES, createCursorClient } from '../src/cursor/client.js';
import { GitHubApiError, createGitHubClient, parseGitHubPrivateKey } from '../src/github/client.js';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that answers from a list and remembers what it was asked. No network. */
function fixtureFetch(answers: ((call: Recorded) => { status?: number; body: unknown })[]) {
  const calls: Recorded[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Recorded = {
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = answers[calls.length - 1];
    if (!answer) return Promise.reject(new Error(`unexpected request ${call.method} ${call.url}`));
    const { status = 200, body } = answer(call);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const AGENT_ID = 'bc-00000000-0000-4000-8000-000000000001';
const START = { agentId: AGENT_ID, name: 'Patcher fix · Acme Portal', prompt: 'Fix the crash in the order handler.', repo: 'example-org/acme-portal', startingRef: 'main' };

describe('Cursor Cloud Agents client', () => {
  it('starts an agent on a branch of its own that opens a pull request and merges nothing', async () => {
    const { fetch, calls } = fixtureFetch([
      () => ({ body: { agent: { id: AGENT_ID, url: `https://cursor.com/agents/${AGENT_ID}` }, run: { id: 'run-1' } } }),
    ]);
    const client = createCursorClient({ apiKey: 'key-for-tests', model: 'model-x', fetch });
    expect(await client.startAgent(START)).toEqual({ agentId: AGENT_ID, runId: 'run-1', url: `https://cursor.com/agents/${AGENT_ID}` });
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'https://api.cursor.com/v1/agents',
        headers: { authorization: 'Bearer key-for-tests', 'content-type': 'application/json' },
        body: {
          agentId: AGENT_ID,
          name: 'Patcher fix · Acme Portal',
          prompt: { text: 'Fix the crash in the order handler.' },
          repos: [{ url: 'https://github.com/example-org/acme-portal', startingRef: 'main' }],
          workOnCurrentBranch: false,
          autoCreatePR: true,
          model: { id: 'model-x' },
        },
      },
    ]);
  });

  it('leaves the model to the account default when none is set', async () => {
    const { fetch, calls } = fixtureFetch([() => ({ body: { agent: { id: AGENT_ID, latestRunId: 'run-9' } } })]);
    const started = await createCursorClient({ apiKey: 'k', fetch }).startAgent({ ...START, startingRef: undefined });
    expect(started).toEqual({ agentId: AGENT_ID, runId: 'run-9', url: `https://cursor.com/agents/${AGENT_ID}` });
    expect(calls[0]!.body).not.toHaveProperty('model');
    expect((calls[0]!.body as { repos: unknown[] }).repos).toEqual([{ url: 'https://github.com/example-org/acme-portal' }]);
  });

  it('treats an agent id that already exists as that agent, not as a failure', async () => {
    const { fetch, calls } = fixtureFetch([
      () => ({ status: 409, body: { error: { code: 'agent_id_conflict', message: 'Agent already exists' } } }),
      () => ({ body: { id: AGENT_ID, url: `https://cursor.com/agents/${AGENT_ID}`, latestRunId: 'run-1' } }),
    ]);
    const started = await createCursorClient({ apiKey: 'k', fetch }).startAgent(START);
    expect(started.runId).toBe('run-1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.cursor.com/v1/agents',
      `GET https://api.cursor.com/v1/agents/${AGENT_ID}`,
    ]);
  });

  it('reports a refusal with its status and code, and never the key', async () => {
    const { fetch } = fixtureFetch([() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Invalid API key' } } })]);
    const error = await createCursorClient({ apiKey: 'secret-key-value', fetch })
      .startAgent(START)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CursorApiError);
    expect((error as CursorApiError).message).toBe('Cursor: Invalid API key (HTTP 401, unauthorized)');
    expect((error as CursorApiError).status).toBe(401);
    expect(JSON.stringify(error)).not.toContain('secret-key-value');
  });

  it('says when Cursor did not answer, and rejects a response without ids', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(createCursorClient({ apiKey: 'k', fetch: down }).startAgent(START)).rejects.toThrow('Cursor did not answer (TypeError)');
    const { fetch } = fixtureFetch([() => ({ body: {} })]);
    await expect(createCursorClient({ apiKey: 'k', fetch }).startAgent(START)).rejects.toThrow('the response had no agent or run id');
  });

  it('reads a run: status, result and the pull request of each branch', async () => {
    const { fetch, calls } = fixtureFetch([
      () => ({
        body: {
          id: 'run-1',
          status: 'FINISHED',
          result: 'Opened a pull request.',
          git: { branches: [{ repoUrl: 'https://github.com/example-org/acme-portal', branch: 'cursor/fix', prUrl: 'https://github.com/example-org/acme-portal/pull/7' }] },
        },
      }),
      () => ({ body: { id: 'run-1' } }),
    ]);
    const client = createCursorClient({ apiKey: 'k', baseUrl: 'http://localhost:9999/', fetch });
    expect(await client.getRun(AGENT_ID, 'run-1')).toEqual({
      status: 'FINISHED',
      result: 'Opened a pull request.',
      branches: [{ repoUrl: 'https://github.com/example-org/acme-portal', branch: 'cursor/fix', prUrl: 'https://github.com/example-org/acme-portal/pull/7' }],
    });
    expect(calls[0]!.url).toBe(`http://localhost:9999/v1/agents/${AGENT_ID}/runs/run-1`);
    // A sparse answer reads as still running, so a run is never ended by a missing field.
    expect(await client.getRun(AGENT_ID, 'run-1')).toEqual({ status: 'RUNNING', result: null, branches: [] });
    expect(TERMINAL_RUN_STATUSES.has('RUNNING')).toBe(false);
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(['CANCELLED', 'ERROR', 'EXPIRED', 'FINISHED']);
  });
});

// Generated for this test run; it signs nothing outside it.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const T0 = Date.parse('2026-03-09T14:00:00Z');

describe('GitHub App client', () => {
  const token = (expiresInMinutes = 60) => () => ({
    status: 201,
    body: { token: 'ghs_installation_token', expires_at: new Date(T0 + expiresInMinutes * 60_000).toISOString() },
  });

  it('signs in as the app, then reads with the installation token', async () => {
    const { fetch, calls } = fixtureFetch([
      token(),
      () => ({ body: { default_branch: 'main' } }),
      () => ({ body: { ahead_by: 12 } }),
      () => ({ body: [{ number: 1 }, { number: 2 }] }),
    ]);
    const client = createGitHubClient({ appId: '4242', privateKey: PEM, installationId: '777', fetch, now: () => T0 });
    expect(await client.defaultBranch('example-org/acme-portal')).toBe('main');
    expect(await client.commitsAhead('example-org/acme-portal', 'abc123', 'main')).toBe(12);
    expect(await client.openCriticalAlerts('example-org/acme-portal')).toBe(2);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.github.com/app/installations/777/access_tokens',
      'GET https://api.github.com/repos/example-org/acme-portal',
      'GET https://api.github.com/repos/example-org/acme-portal/compare/abc123...main?per_page=1',
      'GET https://api.github.com/repos/example-org/acme-portal/dependabot/alerts?state=open&severity=critical&per_page=100',
    ]);
    // One token for all three reads, and every request after the first is a GET.
    expect(calls.slice(1).every((c) => c.headers.authorization === 'Bearer ghs_installation_token')).toBe(true);

    const jwt = calls[0]!.headers.authorization!.replace('Bearer ', '');
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, { currentDate: new Date(T0) });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.iss).toBe('4242');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
  });

  it('asks for a new installation token shortly before the old one ends', async () => {
    let now = T0;
    const { fetch, calls } = fixtureFetch([token(60), () => ({ body: { default_branch: 'main' } }), () => ({ body: { default_branch: 'main' } }), token(120), () => ({ body: { default_branch: 'main' } })]);
    const client = createGitHubClient({ appId: '1', privateKey: PEM, installationId: '2', fetch, now: () => now });
    await client.defaultBranch('a/b');
    now = T0 + 30 * 60_000;
    await client.defaultBranch('a/b');
    now = T0 + 57 * 60_000;
    await client.defaultBranch('a/b');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('accepts a key pasted with literal \\n, and refuses one that is not a key', () => {
    expect(parseGitHubPrivateKey(PEM.replace(/\n/g, '\\n')).type).toBe('private');
    expect(() => parseGitHubPrivateKey('not a key')).toThrow();
    expect(() => createGitHubClient({ appId: '1', privateKey: 'not a key', installationId: '2' })).toThrow();
  });

  it('reports a refusal with GitHub’s message, and never asks for a name that is not a repository', async () => {
    const { fetch, calls } = fixtureFetch([token(), () => ({ status: 403, body: { message: 'Resource not accessible by integration' } })]);
    const client = createGitHubClient({ appId: '1', privateKey: PEM, installationId: '2', fetch, now: () => T0 });
    const error = await client.openCriticalAlerts('example-org/acme-portal').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).message).toBe('GitHub: Resource not accessible by integration (HTTP 403)');
    await expect(client.defaultBranch('../../orgs/example-org')).rejects.toThrow('Not a repository name');
    expect(calls).toHaveLength(2);
  });
});

describe('worker configuration for the audit', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('starts without Railway, GitHub or Cursor, naming what each one is missing', () => {
    const config = loadWorkerConfig(base);
    expect(config.features.railway).toEqual({ configured: false, missing: ['RAILWAY_API_TOKEN'] });
    expect(config.features.cursor).toEqual({ configured: false, missing: ['CURSOR_API_KEY'] });
    expect(config.features.github).toEqual({ configured: false, missing: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] });
    expect(config.github).toBeUndefined();
  });

  it('names only the missing parts of a half-configured GitHub App', () => {
    const config = loadWorkerConfig({ ...base, GITHUB_APP_ID: '4242', GITHUB_APP_INSTALLATION_ID: '777' });
    expect(config.features.github).toEqual({ configured: false, missing: ['GITHUB_APP_PRIVATE_KEY'] });
    expect(config.github).toBeUndefined();
  });

  it('reports each one configured once its variables are set', () => {
    const config = loadWorkerConfig({
      ...base,
      RAILWAY_API_TOKEN: 'railway-token-for-tests',
      CURSOR_API_KEY: 'cursor-key-for-tests',
      CURSOR_AGENT_MODEL: 'model-x',
      GITHUB_APP_ID: '4242',
      GITHUB_APP_PRIVATE_KEY: PEM,
      GITHUB_APP_INSTALLATION_ID: '777',
    });
    expect(config.features.railway.configured).toBe(true);
    expect(config.features.cursor.configured).toBe(true);
    expect(config.features.github.configured).toBe(true);
    expect(config.github).toEqual({ appId: '4242', privateKey: PEM.trim(), installationId: '777' });
    expect(config.cursorAgentModel).toBe('model-x');
  });

  it('refuses an API address override in production', () => {
    for (const name of ['RAILWAY_API_URL', 'CURSOR_API_URL', 'GITHUB_API_URL']) {
      expect(() => loadWorkerConfig({ ...base, NODE_ENV: 'production', [name]: 'http://localhost:9999' })).toThrow(ConfigError);
      expect(loadWorkerConfig({ ...base, NODE_ENV: 'test', [name]: 'http://localhost:9999' })).toBeDefined();
    }
  });
});
