import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/log.js';
import { silentLogger } from '../src/log.js';
import { RailwayApiError, createRailwayClient } from '../src/railway/client.js';
import { collectSnapshot } from '../src/railway/collect.js';
import { listInstances, listRailwayProjects, syncInventory } from '../src/railway/inventory.js';
import { READ_QUERIES, assertReadOnly } from '../src/railway/queries.js';
import { withTx } from '../src/db/pool.js';
import { ACME, ACME_PROD, ACME_REPO, ACME_STAGING, API, DB, GLOBEX_PROD, NOW, SYNC, fakeRailway, healthyWorkspace } from './fixtures/railway.js';
import { resetDb, testPool } from './helpers.js';

const TOKEN = 'test-token-not-a-real-one-0123456789';

function fetchStub(responses: (Response | Error)[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error('no more responses'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('Railway queries', () => {
  it('are all queries, and none can read a variable value', () => {
    for (const [name, text] of Object.entries(READ_QUERIES)) {
      expect(text.trimStart().startsWith('query'), name).toBe(true);
      expect(text, name).not.toMatch(/mutation|subscription|decryptVariables|variablesForServiceDeployment/);
    }
    // Variables are read from the one field that has names and no values.
    expect(READ_QUERIES.environment).toMatch(/variables\(first: \d+\) \{ pageInfo \{ hasNextPage \} edges \{ node \{ name serviceId \} \} \}/);
    expect(READ_QUERIES.environment).not.toMatch(/\bvalue\b/);
  });

  it('refuses anything that writes or returns variable values', () => {
    const refused = [
      'mutation m { serviceInstanceRedeploy(serviceId: "s", environmentId: "e") }',
      'query q { variables(projectId: "p", environmentId: "e") }',
      'query q { variablesForServiceDeployment(projectId: "p", environmentId: "e", serviceId: "s") }',
      'query q { environment(id: "e") { config(decryptVariables: true) } }',
      'query q { environment(id: "e") { variables { edges { node { name value } } } } }',
      'subscription s { deploymentLogs(deploymentId: "d") { message } }',
      '{ projects { edges { node { id } } } }',
    ];
    for (const text of refused) expect(() => assertReadOnly('test', text), text).toThrow();
    expect(() => assertReadOnly('test', 'query q { metrics { measurement values { ts value } } }')).not.toThrow();
  });
});

describe('Railway client', () => {
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  beforeEach(() => {
    sleeps.length = 0;
  });

  it('sends only a named query, with the token as a bearer header', async () => {
    const { impl, requests } = fetchStub([json({ data: { projects: { edges: [] } } })]);
    const client = createRailwayClient({ token: TOKEN, log: silentLogger, fetch: impl, sleep });
    await expect(client.query('projects', { after: null })).resolves.toEqual({ projects: { edges: [] } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://backboard.railway.com/graphql/v2');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(requests[0]!.init.body as string) as { query: string; variables: unknown };
    expect(body.query).toBe(READ_QUERIES.projects);
    expect(body.variables).toEqual({ after: null });
  });

  it('retries a server error and a network failure, then gives up', async () => {
    const ok = fetchStub([new Response('bad gateway', { status: 502 }), new Error('socket hang up'), json({ data: { ok: true } })]);
    const client = createRailwayClient({ token: TOKEN, log: silentLogger, fetch: ok.impl, sleep });
    await expect(client.query('projects')).resolves.toEqual({ ok: true });
    expect(ok.requests).toHaveLength(3);

    const down = fetchStub([502, 502, 502].map((status) => new Response('x', { status })));
    const failing = createRailwayClient({ token: TOKEN, log: silentLogger, fetch: down.impl, sleep });
    await expect(failing.query('projects')).rejects.toThrow('Railway returned HTTP 502');
    expect(down.requests).toHaveLength(3);
  });

  it('waits as long as a 429 asks, and does not retry a refused token or a GraphQL error', async () => {
    const limited = fetchStub([new Response('', { status: 429, headers: { 'retry-after': '2' } }), json({ data: { ok: true } })]);
    const client = createRailwayClient({ token: TOKEN, log: silentLogger, fetch: limited.impl, sleep });
    await expect(client.query('projects')).resolves.toEqual({ ok: true });
    expect(sleeps).toContain(2000);

    const refused = fetchStub([new Response('', { status: 401 })]);
    await expect(createRailwayClient({ token: TOKEN, log: silentLogger, fetch: refused.impl, sleep }).query('projects')).rejects.toThrow(
      'Railway refused the token (HTTP 401)',
    );
    expect(refused.requests).toHaveLength(1);

    const graphql = fetchStub([json({ errors: [{ message: 'Not Authorized' }] })]);
    await expect(createRailwayClient({ token: TOKEN, log: silentLogger, fetch: graphql.impl, sleep }).query('projects')).rejects.toThrow(
      'Railway: Not Authorized',
    );
    expect(graphql.requests).toHaveLength(1);
  });

  it('stops before the hourly allowance is used up', async () => {
    const reset = new Date(Date.now() + 30 * 60_000).toISOString();
    const { impl, requests } = fetchStub([
      json({ data: { ok: true } }, { headers: { 'x-ratelimit-remaining': '200', 'x-ratelimit-reset': reset } }),
      json({ data: { ok: true } }),
    ]);
    const client = createRailwayClient({ token: TOKEN, log: silentLogger, fetch: impl, sleep, reserveRequests: 250 });
    await client.query('projects');
    await expect(client.query('projects')).rejects.toBeInstanceOf(RailwayApiError);
    expect(requests).toHaveLength(1);
  });

  it('never puts the token in an error or a log line', async () => {
    const lines: string[] = [];
    const record = (message: string, fields?: unknown) => lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
    const log: Logger = { debug: record, info: record, warn: record, error: record, child: () => log };
    const { impl } = fetchStub([new Response('x', { status: 500 }), new Response('x', { status: 500 }), new Response('x', { status: 500 })]);
    const error = await createRailwayClient({ token: TOKEN, log, fetch: impl, sleep })
      .query('projects')
      .catch((err: unknown) => err as Error);
    expect(lines.length).toBeGreaterThan(0);
    expect(`${(error as Error).message} ${lines.join(' ')}`).not.toContain(TOKEN);
  });
});

describe('collectors', () => {
  it('turn a healthy workspace into one snapshot per service instance', async () => {
    const railway = fakeRailway();
    const { snapshot, unread } = await collectSnapshot(railway, { now: NOW, log: silentLogger });
    expect(unread).toEqual([]);
    expect(snapshot.projects.map((p) => p.name)).toEqual(['Acme Portal', 'Globex Sync']);
    expect(snapshot.services.map((s) => `${s.projectName}/${s.environmentName}/${s.serviceName}`)).toEqual([
      'Acme Portal/production/api',
      'Acme Portal/production/Postgres',
      'Acme Portal/staging/api',
      'Globex Sync/production/sync',
    ]);
    const api = snapshot.services[0]!;
    expect(api).toMatchObject({
      repo: ACME_REPO,
      branch: 'main',
      healthcheckPath: '/health',
      serviceDomains: ['acme-api.example.test'],
      variableNames: { ok: true, value: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] },
      http: { ok: true, value: { total: 1000, serverErrors: 0 } },
      latencyP95Ms: { ok: true, value: 180 },
      resources: { ok: true },
    });
    expect(snapshot.services[1]!.volumes).toEqual([
      { id: 'v-1', name: 'pgdata', mountPath: '/var/lib/postgresql/data', sizeMb: 5000, usedMb: 1200, state: 'READY' },
    ]);
    expect(snapshot.requests).toBe(railway.calls.length);
    // Nothing but the fixed read queries was asked for.
    expect(new Set(railway.calls.map((c) => c.name))).toEqual(
      new Set(['projects', 'usage', 'projectEvents', 'environment', 'deployments', 'metrics', 'errorLogs', 'httpByStatus', 'httpDuration', 'tcpProxies']),
    );
  });

  it('report a part that fails as not checked, with the reason, and carry on', async () => {
    const railway = fakeRailway({
      metrics: () => {
        throw new Error('Railway returned HTTP 502');
      },
      httpByStatus: () => {
        throw new Error('Railway: Problem processing request');
      },
    });
    const { snapshot } = await collectSnapshot(railway, { now: NOW, log: silentLogger });
    const api = snapshot.services[0]!;
    expect(api.resources).toEqual({ ok: false, reason: 'Railway returned HTTP 502' });
    expect(api.http).toEqual({ ok: false, reason: 'Railway: Problem processing request' });
    expect(api.latencyP95Ms).toEqual({ ok: true, value: 180 });
    expect(api.errorLogs.ok).toBe(true);
  });

  it('list an environment that cannot be read instead of dropping it silently', async () => {
    const healthy = healthyWorkspace();
    const railway = fakeRailway({
      environment: (v) => {
        if (v.id === ACME_STAGING) throw new Error('Railway: Not Authorized');
        return healthy.environment(v);
      },
    });
    const { snapshot, unread } = await collectSnapshot(railway, { now: NOW, log: silentLogger });
    expect(unread).toEqual([
      { projectId: ACME, projectName: 'Acme Portal', environmentId: ACME_STAGING, environmentName: 'staging', reason: 'Railway: Not Authorized' },
    ]);
    expect(snapshot.services.some((s) => s.environmentId === ACME_STAGING)).toBe(false);
  });

  it('group error lines by signature, inside the window, without what is not an error', async () => {
    const line = (timestamp: string, message: string, serviceId = API) => ({ timestamp, message, severity: 'error', tags: { serviceId } });
    const railway = fakeRailway({
      errorLogs: (v) => ({
        environmentLogs:
          v.environmentId === ACME_PROD
            ? [
                line('2026-02-20T10:00:00Z', 'TypeError: cannot read properties of undefined (order 100)'),
                line('2026-03-08T10:00:00Z', 'TypeError: cannot read properties of undefined (order 4821)'),
                line('2026-03-08T11:00:00Z', 'TypeError: cannot read properties of undefined (order 4822)'),
                line('2026-03-08T11:00:01Z', '    at handler (/app/src/orders.js:41:17)'),
                line('2026-03-08T12:00:00Z', '2026-03-08 12:00:00.000 UTC [27] LOG:  checkpoint starting: time', DB),
                line('2026-03-08T12:00:01Z', '2026-03-08 12:00:01.000 UTC [27] ERROR:  relation "orders" does not exist at character 15', DB),
                line('2026-03-08T12:30:00Z', 'warn: config option is deprecated'),
                line('2026-03-08T13:00:00Z', 'Payment failed for ada@example.com with token sk_live_abcdefghijklmnop'),
              ]
            : [],
      }),
    });
    const { snapshot } = await collectSnapshot(railway, { now: NOW, log: silentLogger });
    const api = snapshot.services.find((s) => s.environmentId === ACME_PROD && s.serviceId === API)!;
    expect(api.errorLogs).toEqual({
      ok: true,
      value: {
        groups: [
          {
            signature: 'TypeError: cannot read properties of undefined (order <n>)',
            count: 2,
            firstAt: '2026-03-08T10:00:00Z',
            lastAt: '2026-03-08T11:00:00Z',
          },
          { signature: 'Payment failed for [email] with token [token]', count: 1, firstAt: '2026-03-08T13:00:00Z', lastAt: '2026-03-08T13:00:00Z' },
        ],
        lines: 3,
        truncated: false,
        since: '2026-03-02T14:00:00.000Z',
      },
    });
    const db = snapshot.services.find((s) => s.serviceId === DB)!;
    expect(db.errorLogs.ok && db.errorLogs.value.groups.map((g) => g.signature)).toEqual([
      'relation <str> does not exist at character <n>',
    ]);
  });

  it('read crashes, vulnerability notices and the failed step of a failed deployment', async () => {
    const healthy = healthyWorkspace();
    const railway = fakeRailway({
      projectEvents: (v) => ({
        events: {
          edges:
            v.projectId === ACME
              ? [
                  { node: { object: 'Deployment', action: 'crashed', severity: 'CRITICAL', createdAt: '2026-03-07T01:00:00Z', environmentId: ACME_PROD, payload: { serviceId: API } } },
                  { node: { object: 'Deployment', action: 'crashed', severity: 'CRITICAL', createdAt: '2026-03-08T01:00:00Z', environmentId: ACME_PROD, payload: { serviceId: API } } },
                  { node: { object: 'Deployment', action: 'crashed', severity: 'CRITICAL', createdAt: '2026-01-01T01:00:00Z', environmentId: ACME_PROD, payload: { serviceId: API } } },
                  { node: { object: 'PostgresVuln', action: 'triggered', severity: 'WARNING', createdAt: '2026-02-01T00:00:00Z', environmentId: ACME_PROD, payload: { serviceId: DB, cveIds: ['CVE-2099-0001', 'CVE-2099-0002'], severity: 'high' } } },
                  { node: { object: 'PostgresVuln', action: 'resolved', severity: 'INFO', createdAt: '2026-02-10T00:00:00Z', environmentId: ACME_PROD, payload: { serviceId: DB, cveId: 'CVE-2099-0002' } } },
                ]
              : [],
          pageInfo: { hasNextPage: false },
        },
      }),
      environment: (v) => {
        const data = healthy.environment(v) as { environment: { serviceInstances: { edges: { node: Record<string, unknown> }[] } } | null };
        if (v.id === GLOBEX_PROD && data.environment) {
          const node = data.environment.serviceInstances.edges[0]!.node;
          node.latestDeployment = { id: 'd-failed', status: 'FAILED', createdAt: '2026-03-06T09:00:00Z', statusUpdatedAt: '2026-03-06T09:03:00Z', deploymentStopped: false, meta: {}, instances: [] };
        }
        return data;
      },
      deploymentEvents: (v) => ({
        deploymentEvents: {
          edges:
            v.id === 'd-failed'
              ? [
                  { node: { step: 'BUILD_IMAGE', createdAt: '2026-03-06T09:01:00Z', completedAt: '2026-03-06T09:03:00Z', payload: { error: 'npm ERR! missing script: build, token=abcdef123456 was used' } } },
                ]
              : [],
        },
      }),
    });
    const { snapshot } = await collectSnapshot(railway, { now: NOW, log: silentLogger });
    const api = snapshot.services.find((s) => s.environmentId === ACME_PROD && s.serviceId === API)!;
    expect(api.events).toEqual({ ok: true, value: { crashes: 2, restarts: 0, lastCrashAt: '2026-03-08T01:00:00Z' } });
    const db = snapshot.services.find((s) => s.serviceId === DB)!;
    expect(db.vulnerabilities.ok && db.vulnerabilities.value.map((v) => v.cveIds)).toEqual([['CVE-2099-0001']]);
    const sync = snapshot.services.find((s) => s.serviceId === SYNC)!;
    expect(sync.failedStep).toEqual({ ok: true, value: { step: 'BUILD_IMAGE', error: 'npm ERR! missing script: build, token=[redacted] was used' } });
  });

  it('waits and retries when Railway says too many metric queries are running', async () => {
    const healthy = healthyWorkspace();
    let refusals = 2;
    const waits: number[] = [];
    const railway = fakeRailway({
      metrics: (v) => {
        if (refusals > 0) {
          refusals -= 1;
          throw new Error('Railway: Too many metric queries are running at once. Please retry in 120 seconds.');
        }
        return healthy.metrics(v);
      },
    });
    const { snapshot } = await collectSnapshot(railway, {
      now: NOW,
      log: silentLogger,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits.length).toBe(2);
    expect(snapshot.services.every((s) => s.resources.ok)).toBe(true);
  });

  it('with inventoryOnly, list services with one request per environment and nothing else', async () => {
    const railway = fakeRailway();
    const { snapshot } = await collectSnapshot(railway, { now: NOW, log: silentLogger, inventoryOnly: true });
    expect(railway.calls.map((c) => c.name).sort()).toEqual(['environment', 'environment', 'environment', 'projects']);
    expect(snapshot.services).toHaveLength(4);
    expect(snapshot.services[0]!.resources.ok).toBe(false);
  });
});

describe('inventory', () => {
  const pool = testPool();
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  const sync = async (railway = fakeRailway(), now = NOW) => {
    const { snapshot, unread } = await collectSnapshot(railway, { now, log: silentLogger, inventoryOnly: true });
    return withTx(pool, (tx) => syncInventory(tx, snapshot, unread, now));
  };

  it('records the first inventory without calling everything new', async () => {
    expect(await sync()).toEqual({ changes: [], initial: true });
    expect((await listRailwayProjects(pool)).map((p) => [p.name, p.services, p.repos])).toEqual([
      ['Acme Portal', 2, [ACME_REPO]],
      ['Globex Sync', 1, ['example-org/globex-sync']],
    ]);
    const instances = await listInstances(pool);
    expect(instances).toHaveLength(4);
    expect(instances.find((i) => i.serviceId === API && i.environmentId === ACME_PROD)!.details).toMatchObject({
      domains: ['acme-api.example.test'],
      healthcheckPath: '/health',
      repo: ACME_REPO,
    });
  });

  it('reports what was added, renamed and removed since the last inventory', async () => {
    await sync();
    const healthy = healthyWorkspace();
    const later = new Date(NOW.getTime() + 7 * 24 * 3600 * 1000);
    const changed = fakeRailway({
      projects: () => {
        const data = healthy.projects({}) as { projects: { edges: { node: { id: string; name: string; services: { edges: { node: { id: string; name: string } }[] } } }[] } };
        const acme = data.projects.edges[0]!.node;
        acme.services.edges[0]!.node.name = 'api-v2';
        acme.services.edges.push({ node: { id: 's-worker', name: 'worker' } });
        data.projects.edges.pop();
        return data;
      },
    });
    const { changes, initial } = await sync(changed, later);
    expect(initial).toBe(false);
    expect(changes.map((c) => `${c.kind} ${c.change} ${c.name}`).sort()).toEqual([
      'environment removed production',
      'project removed Globex Sync',
      'service added worker',
      'service removed sync',
      'service renamed api-v2',
    ]);
    expect(changes.find((c) => c.change === 'renamed')).toMatchObject({ previousName: 'api', projectName: 'Acme Portal' });
    expect((await listRailwayProjects(pool)).map((p) => p.name)).toEqual(['Acme Portal']);
  });

  it('does not call an environment removed when it only could not be read', async () => {
    await sync();
    const healthy = healthyWorkspace();
    const partial = fakeRailway({
      environment: (v) => {
        if (v.id === GLOBEX_PROD) throw new Error('Railway returned HTTP 502');
        return healthy.environment(v);
      },
    });
    const { changes } = await sync(partial, new Date(NOW.getTime() + 3600_000));
    expect(changes).toEqual([]);
    expect((await listInstances(pool)).some((i) => i.environmentId === GLOBEX_PROD)).toBe(true);
  });
});
