import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProbeRefused, createProber, isPublicAddress, parseProbeUrl } from '../src/probes/probe.js';
import type { ProbeOutcome, ProbeTarget } from '../src/probes/probe.js';
import { customCheckResults, probeSummaries, runProbes, serviceProbeTargets } from '../src/probes/run.js';
import { syncInventory } from '../src/railway/inventory.js';
import { addCheck, addLink, createProject } from '../src/registry/registry.js';
import { ACME_PROD, API, NOW, databaseService, fakeRailway, service, workspace } from './fixtures/railway.js';
import { OWNER, harness, resetDb, seedPeople, testIntegrations, testPool } from './helpers.js';

describe('what a probe may reach', () => {
  it('tells public addresses from private, loopback, link-local and metadata ones', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      'not-an-address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('refuses anything but a plain https address on a public host', () => {
    expect(parseProbeUrl('https://status.example.com/health?deep=1').href).toBe('https://status.example.com/health?deep=1');
    const refused: [string, string][] = [
      ['http://status.example.com/', 'Only https addresses are probed'],
      ['ftp://status.example.com/', 'Only https addresses are probed'],
      ['https://user:pass@status.example.com/', 'Addresses with credentials are not probed'],
      ['https://localhost/', 'Internal host names are not probed'],
      ['https://api.railway.internal/health', 'Internal host names are not probed'],
      ['https://127.0.0.1/', 'Private addresses are not probed'],
      ['https://[::1]/', 'Private addresses are not probed'],
      ['https://169.254.169.254/latest/meta-data', 'Private addresses are not probed'],
      ['not a url', 'Not a valid address'],
    ];
    for (const [url, message] of refused) {
      expect(() => parseProbeUrl(url), url).toThrow(ProbeRefused);
      expect(() => parseProbeUrl(url), url).toThrow(message);
    }
  });

  it('does not connect when a public-looking name resolves to a private address', async () => {
    const probe = createProber({ resolve: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]) });
    expect(await probe({ url: 'https://rebind.example.com/' })).toMatchObject({ ok: false, status: null, error: 'The host resolves to a private address' });
    const unknown = createProber({ resolve: () => Promise.reject(new Error('ENOTFOUND')) });
    expect(await unknown({ url: 'https://gone.example.com/' })).toMatchObject({ ok: false, error: 'The host name did not resolve', host: 'gone.example.com' });
    expect(await createProber()({ url: 'http://status.example.com/' })).toMatchObject({ ok: false, error: 'Only https addresses are probed' });
  });
});

describe('a probe against a local server', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const route: Record<string, () => void> = {
        '/health': () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"db":"up"}'),
        '/degraded': () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":false}'),
        '/text': () => res.writeHead(200).end('hello'),
        '/login': () => res.writeHead(401).end(),
        '/broken': () => res.writeHead(503).end(),
        '/big': () => res.writeHead(200).end('x'.repeat(100_000)),
        '/slow': () => void setTimeout(() => res.writeHead(200).end(), 2000),
      };
      (route[req.url ?? ''] ?? (() => res.writeHead(404).end()))();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const probe = (path: string, target: Omit<ProbeTarget, 'url'> = {}, timeoutMs = 3000) =>
    createProber({ allowLocal: true, timeoutMs })({ url: `${base}${path}`, ...target });

  it('counts an answer below 500 as up at the root, and only success on a health path', async () => {
    expect(await probe('/login')).toMatchObject({ ok: true, status: 401, error: null, host: '127.0.0.1' });
    expect(await probe('/login', { failFrom: 400 })).toMatchObject({ ok: false, status: 401, error: 'HTTP 401' });
    expect(await probe('/broken')).toMatchObject({ ok: false, status: 503, error: 'HTTP 503' });
    const up = await probe('/health', { failFrom: 400 });
    expect(up).toMatchObject({ ok: true, status: 200, certificateExpiresAt: null });
    expect(up.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('checks the expected status and JSON of a project check', async () => {
    expect(await probe('/health', { expectStatus: 200, expectJson: { ok: true } })).toMatchObject({ ok: true });
    expect(await probe('/degraded', { expectStatus: 200, expectJson: { ok: true } })).toMatchObject({ ok: false, error: '"ok" was not the expected value' });
    expect(await probe('/text', { expectJson: { ok: true } })).toMatchObject({ ok: false, error: 'The response was not JSON' });
    expect(await probe('/login', { expectStatus: 401 })).toMatchObject({ ok: true, status: 401 });
    expect(await probe('/health', { expectStatus: 204 })).toMatchObject({ ok: false, error: 'HTTP 200' });
    expect(await probe('/big', { expectJson: { ok: true } })).toMatchObject({ ok: false, error: 'The response was too large to check' });
  });

  it('gives up after the time limit', async () => {
    expect(await probe('/slow', {}, 200)).toMatchObject({ ok: false, status: null, error: 'No answer in 0.2 s' });
  });

  it('refuses the same local server without the test switch', async () => {
    expect(await createProber()({ url: `${base}/health` })).toMatchObject({ ok: false, error: 'Only https addresses are probed' });
  });
});

describe('the probe schedule', () => {
  const pool = testPool();
  const SLEEPER = 's-sleeper';
  const WORKER = 's-worker';
  // Railway ids are UUIDs; the registry refuses a link to anything else.
  const RAILWAY_PROJECT = '11111111-2222-4333-8444-555555555555';

  const up = (host: string): ProbeOutcome => ({ ok: true, host, status: 200, latencyMs: 40, error: null, certificateExpiresAt: new Date('2026-06-01T00:00:00Z') });
  const down = (host: string): ProbeOutcome => ({ ok: false, host, status: 503, latencyMs: 12, error: 'HTTP 503', certificateExpiresAt: null });

  async function seedInventory() {
    const snapshot = workspace([
      service({ projectId: RAILWAY_PROJECT, healthcheckPath: '/healthz', customDomains: [{ domain: 'portal.example.test', certificateStatus: 'VALID', certificateExpiresAt: null }] }),
      databaseService({ projectId: RAILWAY_PROJECT, serviceDomains: ['db-proxy.example.test'] }),
      service({ projectId: RAILWAY_PROJECT, serviceId: SLEEPER, serviceName: 'preview', instanceId: 'i-sleeper', sleeps: true, serviceDomains: ['preview.example.test'] }),
      service({ projectId: RAILWAY_PROJECT, serviceId: WORKER, serviceName: 'worker', instanceId: 'i-worker', serviceDomains: [] }),
    ]);
    await syncInventory(pool, snapshot, [], NOW);
    return snapshot;
  }

  /** Inventory is fresh, so the schedule does not ask Railway again. */
  function withProber(probe: (target: ProbeTarget) => ProbeOutcome) {
    const seen: ProbeTarget[] = [];
    const h = harness(pool, {
      integrations: testIntegrations({
        railway: fakeRailway(),
        probe: (target) => {
          seen.push(target);
          return Promise.resolve(probe(target));
        },
      }),
    });
    return { h, seen };
  }

  beforeEach(async () => {
    await resetDb(pool);
    await seedPeople(pool);
  });
  afterAll(() => pool.end());

  it('probes each public web service once: not databases, sleeping services or services without a domain', async () => {
    await seedInventory();
    // The custom domain is the one people use, so it is the one probed.
    expect(await serviceProbeTargets(pool)).toEqual([
      { serviceId: API, environmentId: ACME_PROD, url: 'https://portal.example.test/healthz', failFrom: 400 },
    ]);
  });

  it('asks for the root when a service has no health path', async () => {
    await syncInventory(pool, workspace([service({ healthcheckPath: null })]), [], NOW);
    const [target] = await serviceProbeTargets(pool);
    expect(target).toMatchObject({ failFrom: 500 });
    expect(target!.url).toBe('https://acme-api.example.test/');
  });

  it('stores each result and summarises the week per service', async () => {
    await seedInventory();
    let failing = false;
    const { h, seen } = withProber((t) => (failing ? down(new URL(t.url).hostname) : up(new URL(t.url).hostname)));
    expect(await probeSummaries(pool, new Date(NOW.getTime() - 7 * 86_400_000))).toBeNull();

    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    expect(await runProbes(h.worker, at(0))).toBe('1 probed, 0 failed');
    failing = true;
    expect(await runProbes(h.worker, at(5))).toBe('1 probed, 1 failed');
    expect(await runProbes(h.worker, at(10))).toBe('1 probed, 1 failed');
    expect(seen).toHaveLength(3);

    const summary = (await probeSummaries(pool, new Date(NOW.getTime() - 7 * 86_400_000)))!.get(`${ACME_PROD}:${API}`)!;
    expect(summary).toMatchObject({ total: 3, failed: 2, failingNow: 2, lastStatus: 503, lastError: 'HTTP 503' });

    failing = false;
    await runProbes(h.worker, at(15));
    const recovered = (await probeSummaries(pool, new Date(NOW.getTime() - 7 * 86_400_000)))!.get(`${ACME_PROD}:${API}`)!;
    expect(recovered).toMatchObject({ total: 4, failed: 2, failingNow: 0, lastStatus: 200, certificateExpiresAt: '2026-06-01T00:00:00.000Z' });
  });

  it('probes project-specific checks with their expectations, and ties them to the Railway project', async () => {
    await seedInventory();
    const projectId = await createProject(pool, { name: 'Acme Portal' }, OWNER);
    await addLink(pool, projectId, 'railway_project', RAILWAY_PROJECT, OWNER);
    const checkId = await addCheck(pool, projectId, { name: 'Order sync', url: 'https://portal.example.test/api/sync-status', expectStatus: 200, expectJson: { ok: true } }, OWNER);
    const { h, seen } = withProber((t) => (t.url.includes('sync-status') ? down('portal.example.test') : up(new URL(t.url).hostname)));

    expect(await runProbes(h.worker, NOW)).toBe('2 probed, 1 failed');
    expect(seen.find((t) => t.url.includes('sync-status'))).toEqual({ url: 'https://portal.example.test/api/sync-status', expectStatus: 200, expectJson: { ok: true } });
    expect(await customCheckResults(pool, new Date(NOW.getTime() - 86_400_000))).toEqual([
      expect.objectContaining({ checkId, name: 'Order sync', host: 'portal.example.test', projectId: RAILWAY_PROJECT, projectName: 'Acme Portal', summary: expect.objectContaining({ total: 1, failed: 1, failingNow: 1 }) as unknown }),
    ]);
  });

  it('keeps 35 days of results', async () => {
    await seedInventory();
    const { h } = withProber((t) => up(new URL(t.url).hostname));
    await runProbes(h.worker, new Date(NOW.getTime() - 36 * 86_400_000));
    await runProbes(h.worker, new Date(NOW.getTime() - 34 * 86_400_000));
    // The inventory is older than a day by now, so this run also refreshes it from Railway.
    await runProbes(h.worker, NOW);
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM probe_results');
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('says so when there is nothing to probe', async () => {
    const h = harness(pool);
    expect(await runProbes(h.worker, NOW)).toBe('Nothing to probe: Railway is not configured, so there is no inventory.');
  });
});
