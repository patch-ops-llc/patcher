import type { RailwayReader } from '../../src/railway/client.js';
import type { ReadQueryName } from '../../src/railway/queries.js';
import type { ServiceSnapshot, WorkspaceSnapshot } from '../../src/railway/types.js';
import { checked } from '../../src/railway/types.js';

/**
 * A made-up workspace. Every name, id, domain and log line here is invented; nothing in the
 * tests comes from a real Railway project.
 */
export const NOW = new Date('2026-03-09T14:00:00Z');
export const WINDOW_START = '2026-03-02T14:00:00.000Z';

export const ACME = 'p-acme';
export const GLOBEX = 'p-globex';
export const ACME_PROD = 'e-acme-prod';
export const ACME_STAGING = 'e-acme-staging';
export const GLOBEX_PROD = 'e-globex-prod';
export const API = 's-api';
export const DB = 's-db';
export const SYNC = 's-sync';
export const ACME_REPO = 'example-org/acme-portal';
export const GLOBEX_REPO = 'example-org/globex-sync';

const edges = <T>(items: T[], hasNextPage = false) => ({ edges: items.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor: null } });

function instance(overrides: Record<string, unknown>) {
  return {
    id: 'i-1',
    serviceId: API,
    serviceName: 'api',
    createdAt: '2025-06-01T00:00:00.000Z',
    healthcheckPath: '/health',
    cronSchedule: null,
    sleepApplication: false,
    rootDirectory: null,
    railwayConfigFile: null,
    source: { repo: ACME_REPO, image: null },
    resolvedFileConfig: null,
    domains: { serviceDomains: [{ domain: 'acme-api.example.test' }], customDomains: [] },
    latestDeployment: {
      id: 'd-1',
      status: 'SUCCESS',
      createdAt: '2026-03-05T10:00:00.000Z',
      statusUpdatedAt: '2026-03-05T10:02:00.000Z',
      deploymentStopped: false,
      meta: { repo: ACME_REPO, branch: 'main', commitHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' },
      instances: [{ status: 'RUNNING' }],
    },
    activeDeployments: [{ id: 'd-1', status: 'SUCCESS', createdAt: '2026-03-05T10:00:00.000Z' }],
    ...overrides,
  };
}

const database = (id: string) =>
  instance({
    id,
    serviceId: DB,
    serviceName: 'Postgres',
    healthcheckPath: null,
    source: { repo: null, image: 'ghcr.io/example/postgres-ssl:16' },
    domains: { serviceDomains: [], customDomains: [] },
    latestDeployment: {
      id: `d-${id}`,
      status: 'SUCCESS',
      createdAt: '2025-06-01T00:00:00.000Z',
      statusUpdatedAt: '2025-06-01T00:01:00.000Z',
      deploymentStopped: false,
      meta: { image: 'ghcr.io/example/postgres-ssl:16' },
      instances: [{ status: 'RUNNING' }],
    },
    activeDeployments: [{ id: `d-${id}`, status: 'SUCCESS', createdAt: '2025-06-01T00:00:00.000Z' }],
  });

export type Handler = (variables: Record<string, unknown>) => unknown;

/** The answers of a healthy workspace, by query name. A test replaces the ones it cares about. */
export function healthyWorkspace(): Record<ReadQueryName, Handler> {
  const environments: Record<string, unknown> = {
    [ACME_PROD]: {
      id: ACME_PROD,
      name: 'production',
      projectId: ACME,
      serviceInstances: edges([instance({ id: 'i-api-prod' }), database('i-db-prod')]),
      volumeInstances: edges([
        { id: 'v-1', serviceId: DB, mountPath: '/var/lib/postgresql/data', sizeMB: 5000, currentSizeMB: 1200, state: 'READY', volume: { name: 'pgdata' } },
      ]),
      variables: edges([
        { name: 'DATABASE_URL', serviceId: API },
        { name: 'STRIPE_SECRET_KEY', serviceId: API },
        { name: 'POSTGRES_PASSWORD', serviceId: DB },
      ]),
    },
    [ACME_STAGING]: {
      id: ACME_STAGING,
      name: 'staging',
      projectId: ACME,
      serviceInstances: edges([
        instance({ id: 'i-api-staging', domains: { serviceDomains: [{ domain: 'acme-api-staging.example.test' }], customDomains: [] } }),
      ]),
      volumeInstances: edges([]),
      variables: edges([
        { name: 'DATABASE_URL', serviceId: API },
        { name: 'STRIPE_SECRET_KEY', serviceId: API },
      ]),
    },
    [GLOBEX_PROD]: {
      id: GLOBEX_PROD,
      name: 'production',
      projectId: GLOBEX,
      serviceInstances: edges([
        instance({
          id: 'i-sync-prod',
          serviceId: SYNC,
          serviceName: 'sync',
          source: { repo: GLOBEX_REPO, image: null },
          domains: { serviceDomains: [], customDomains: [] },
          healthcheckPath: null,
          latestDeployment: {
            id: 'd-sync',
            status: 'SUCCESS',
            createdAt: '2026-03-01T10:00:00.000Z',
            statusUpdatedAt: '2026-03-01T10:02:00.000Z',
            deploymentStopped: false,
            meta: { repo: GLOBEX_REPO, branch: 'main', commitHash: 'ffffffffffffffffffffffffffffffffffffffff' },
            instances: [{ status: 'RUNNING' }],
          },
          activeDeployments: [{ id: 'd-sync', status: 'SUCCESS', createdAt: '2026-03-01T10:00:00.000Z' }],
        }),
      ]),
      volumeInstances: edges([]),
      variables: edges([{ name: 'HUBSPOT_TOKEN', serviceId: SYNC }]),
    },
  };

  const series = (measurement: string, serviceId: string, value: number) => ({
    measurement,
    tags: { serviceId },
    values: Array.from({ length: 24 }, (_, i) => ({ ts: 1_772_000_000 + i * 3600, value })),
  });

  return {
    projects: () => ({
      projects: edges([
        {
          id: ACME,
          name: 'Acme Portal',
          workspaceId: 'w-1',
          deletedAt: null,
          environments: edges([
            { id: ACME_PROD, name: 'production', isEphemeral: false },
            { id: ACME_STAGING, name: 'staging', isEphemeral: false },
          ]),
          services: edges([
            { id: API, name: 'api' },
            { id: DB, name: 'Postgres' },
          ]),
        },
        {
          id: GLOBEX,
          name: 'Globex Sync',
          workspaceId: 'w-1',
          deletedAt: null,
          environments: edges([{ id: GLOBEX_PROD, name: 'production', isEphemeral: false }]),
          services: edges([{ id: SYNC, name: 'sync' }]),
        },
      ]),
    }),
    environment: (v) => ({ environment: environments[String(v.id)] ?? null }),
    deployments: () => ({ deployments: edges([{ id: 'd-1', status: 'SUCCESS', createdAt: '2026-03-05T10:00:00.000Z', serviceId: API }]) }),
    deploymentEvents: () => ({ deploymentEvents: edges([]) }),
    cronExecutions: () => ({ deploymentInstanceExecutions: edges([]) }),
    projectEvents: () => ({ events: edges([]) }),
    metrics: (v) => ({
      metrics:
        v.environmentId === GLOBEX_PROD
          ? [series('CPU_USAGE', SYNC, 0.2), series('MEMORY_USAGE_GB', SYNC, 0.3), series('MEMORY_LIMIT_GB', SYNC, 8), series('CPU_LIMIT', SYNC, 8)]
          : [
              series('CPU_USAGE', API, 0.4),
              series('MEMORY_USAGE_GB', API, 0.5),
              series('MEMORY_LIMIT_GB', API, 8),
              series('CPU_LIMIT', API, 8),
              series('CPU_USAGE', DB, 0.1),
              series('MEMORY_USAGE_GB', DB, 0.4),
              series('MEMORY_LIMIT_GB', DB, 8),
              series('CPU_LIMIT', DB, 8),
            ],
    }),
    errorLogs: () => ({ environmentLogs: [] }),
    httpByStatus: () => ({ httpMetricsGroupedByStatus: [{ statusCode: 200, samples: [{ ts: 1, value: 1000 }] }] }),
    httpDuration: () => ({ httpDurationMetrics: { samples: [{ ts: 1, p50: 40, p95: 180 }] } }),
    tcpProxies: () => ({ tcpProxies: [] }),
    usage: () => ({ usage: [] }),
  };
}

export interface FakeRailway extends RailwayReader {
  calls: { name: ReadQueryName; variables: Record<string, unknown> }[];
  handlers: Record<ReadQueryName, Handler>;
}

export function fakeRailway(overrides: Partial<Record<ReadQueryName, Handler>> = {}): FakeRailway {
  const handlers = { ...healthyWorkspace(), ...overrides };
  const calls: FakeRailway['calls'] = [];
  return {
    calls,
    handlers,
    query<T>(name: ReadQueryName, variables: Record<string, unknown> = {}): Promise<T> {
      calls.push({ name, variables });
      try {
        return Promise.resolve(handlers[name](variables) as T);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

/** One healthy service as the checks see it. */
export function service(overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    projectId: ACME,
    projectName: 'Acme Portal',
    environmentId: ACME_PROD,
    environmentName: 'production',
    serviceId: API,
    serviceName: 'api',
    instanceId: 'i-api-prod',
    createdAt: '2025-06-01T00:00:00.000Z',
    repo: ACME_REPO,
    image: null,
    branch: 'main',
    commitHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    rootDirectory: null,
    healthcheckPath: '/health',
    cronSchedule: null,
    sleeps: false,
    configFile: null,
    serviceDomains: ['acme-api.example.test'],
    customDomains: [],
    latestDeployment: {
      id: 'd-1',
      status: 'SUCCESS',
      createdAt: '2026-03-05T10:00:00.000Z',
      statusUpdatedAt: '2026-03-05T10:02:00.000Z',
      stopped: false,
      instanceStatuses: ['RUNNING'],
    },
    activeDeployments: [{ id: 'd-1', status: 'SUCCESS', createdAt: '2026-03-05T10:00:00.000Z' }],
    variableNames: checked(['DATABASE_URL', 'STRIPE_SECRET_KEY']),
    volumes: [],
    deployments: checked([{ id: 'd-1', status: 'SUCCESS', createdAt: '2026-03-05T10:00:00.000Z' }]),
    failedStep: checked(null),
    events: checked({ crashes: 0, restarts: 0, lastCrashAt: null }),
    vulnerabilities: checked([]),
    resources: checked({ cpuAvg: 0.4, cpuMax: 1, cpuLimit: 8, memoryAvgGb: 0.5, memoryMaxGb: 0.7, memoryLimitGb: 8, networkTxGb: 1, samples: 168 }),
    http: checked({ total: 1000, serverErrors: 0, byStatus: { '200': 1000 } }),
    latencyP95Ms: checked(180),
    errorLogs: checked({ groups: [], lines: 0, truncated: false, since: WINDOW_START }),
    tcpProxies: checked([]),
    lastCronRunAt: checked(null),
    ...overrides,
  };
}

export function databaseService(overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return service({
    serviceId: DB,
    serviceName: 'Postgres',
    instanceId: 'i-db-prod',
    repo: null,
    image: 'ghcr.io/example/postgres-ssl:16',
    branch: null,
    commitHash: null,
    healthcheckPath: null,
    serviceDomains: [],
    http: { ok: false, reason: 'The service has no public domain' },
    latencyP95Ms: { ok: false, reason: 'The service has no public domain' },
    variableNames: checked(['POSTGRES_PASSWORD']),
    ...overrides,
  });
}

export function workspace(services: ServiceSnapshot[], overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  const projects = new Map<string, WorkspaceSnapshot['projects'][number]>();
  for (const s of services) {
    const project = projects.get(s.projectId) ?? { id: s.projectId, name: s.projectName, environments: [], services: [], usage: checked([]) };
    if (!project.environments.some((e) => e.id === s.environmentId)) project.environments.push({ id: s.environmentId, name: s.environmentName });
    if (!project.services.some((x) => x.id === s.serviceId)) project.services.push({ id: s.serviceId, name: s.serviceName });
    projects.set(s.projectId, project);
  }
  return {
    workspaceId: 'w-1',
    takenAt: NOW.toISOString(),
    windowStart: WINDOW_START,
    windowDays: 7,
    projects: [...projects.values()],
    services,
    requests: 0,
    ...overrides,
  };
}
