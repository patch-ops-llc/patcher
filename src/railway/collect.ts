import type { Logger } from '../log.js';
import { isErrorLine, isFragment, logSignature, redact } from '../weekly/redact.js';
import type { RailwayReader } from './client.js';
import type { ReadQueryName } from './queries.js';
import type {
  Checked,
  DeploymentSummary,
  ErrorLogs,
  FailedStep,
  HttpSummary,
  LogGroup,
  ProjectSnapshot,
  ResourceUse,
  ServiceEvents,
  ServiceSnapshot,
  TcpProxy,
  VulnerabilityNotice,
  WorkspaceSnapshot,
} from './types.js';
import { checked, notChecked } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_LOG_LIMIT = 2000;
const METRIC_QUERIES: ReadonlySet<ReadQueryName> = new Set(['metrics', 'httpByStatus', 'httpDuration', 'usage']);
const METRIC_CONCURRENCY = 4;
const METRIC_RETRIES = 2;
const METRIC_RETRY_WAIT_MS = 30_000;
const PRIOR_WEEKS = 3;
const EVENT_ACTIONS = ['crashed', 'restarted', 'triggered', 'resolved'];
const VULNERABILITY_OBJECTS = new Set(['PostgresVuln', 'RedisVuln']);

interface Edges<T> {
  edges?: { node: T }[] | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}
const nodes = <T>(connection: Edges<T> | null | undefined): T[] => (connection?.edges ?? []).map((e) => e.node);

interface ProjectNode {
  id: string;
  name: string;
  workspaceId: string | null;
  deletedAt: string | null;
  environments: Edges<{ id: string; name: string; isEphemeral: boolean }>;
  services: Edges<{ id: string; name: string }>;
}

interface InstanceNode {
  id: string;
  serviceId: string;
  serviceName: string;
  createdAt: string | null;
  healthcheckPath: string | null;
  cronSchedule: string | null;
  sleepApplication: boolean | null;
  rootDirectory: string | null;
  railwayConfigFile: string | null;
  source: { repo: string | null; image: string | null } | null;
  resolvedFileConfig: { configFile: string | null } | null;
  domains: {
    serviceDomains: { domain: string }[];
    customDomains: {
      domain: string;
      status: { certificateStatus: string | null; certificates: { expiresAt: string | null }[] | null } | null;
    }[];
  } | null;
  latestDeployment: {
    id: string;
    status: string;
    createdAt: string;
    statusUpdatedAt: string | null;
    deploymentStopped: boolean;
    meta: Record<string, unknown> | null;
    instances: { status: string }[] | null;
  } | null;
  activeDeployments: DeploymentSummary[] | null;
}

interface EnvironmentData {
  environment: {
    id: string;
    name: string;
    projectId: string;
    serviceInstances: Edges<InstanceNode>;
    volumeInstances: Edges<{
      id: string;
      serviceId: string | null;
      mountPath: string;
      sizeMB: number;
      currentSizeMB: number;
      state: string | null;
      volume: { name: string } | null;
    }>;
    variables: Edges<{ name: string; serviceId: string | null }>;
  } | null;
}

interface MetricSeries {
  measurement: string;
  tags: { serviceId: string | null } | null;
  values: { ts: number; value: number }[];
}

interface EventNode {
  object: string;
  action: string;
  severity: string;
  createdAt: string;
  environmentId: string | null;
  payload: Record<string, unknown> | null;
}

export interface CollectOptions {
  now: Date;
  log: Logger;
  windowDays?: number;
  concurrency?: number;
  /**
   * Only list projects, environments and services (one request per environment), for the
   * inventory refresh between audits. Everything else is left as not checked.
   */
  inventoryOnly?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface UnreadEnvironment {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  reason: string;
}

export interface CollectResult {
  snapshot: WorkspaceSnapshot;
  /** Environments whose services could not be listed at all. */
  unread: UnreadEnvironment[];
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

async function attempt<T>(fn: () => Promise<T>): Promise<Checked<T>> {
  try {
    return checked(await fn());
  } catch (err) {
    return notChecked(reasonOf(err));
  }
}

const mapChecked = <T, U>(value: Checked<T>, fn: (v: T) => U): Checked<U> =>
  value.ok ? checked(fn(value.value)) : value;

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function resourceUse(series: MetricSeries[]): ResourceUse | null {
  const values = (measurement: string) =>
    series.filter((s) => s.measurement === measurement).flatMap((s) => s.values.map((v) => v.value));
  const cpu = values('CPU_USAGE');
  const memory = values('MEMORY_USAGE_GB');
  if (!cpu.length && !memory.length) return null;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const max = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);
  const limit = (measurement: string) => {
    const top = max(values(measurement));
    return top > 0 ? top : null;
  };
  return {
    cpuAvg: avg(cpu),
    cpuMax: max(cpu),
    cpuLimit: limit('CPU_LIMIT'),
    memoryAvgGb: avg(memory),
    memoryMaxGb: max(memory),
    memoryLimitGb: limit('MEMORY_LIMIT_GB'),
    networkTxGb: values('NETWORK_TX_GB').reduce((a, b) => a + b, 0),
    samples: Math.max(cpu.length, memory.length),
  };
}

function groupLogs(lines: { timestamp: string; message: string }[]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const line of lines) {
    // Railway marks everything a process writes to stderr as an error. Lines that say of
    // themselves that they are not one, and the tail of a multi-line error, are left out.
    if (!isErrorLine(line.message)) continue;
    const signature = logSignature(line.message);
    if (!signature || isFragment(signature)) continue;
    const group = groups.get(signature);
    if (!group) {
      groups.set(signature, { signature, count: 1, firstAt: line.timestamp, lastAt: line.timestamp });
    } else {
      group.count += 1;
      if (line.timestamp < group.firstAt) group.firstAt = line.timestamp;
      if (line.timestamp > group.lastAt) group.lastAt = line.timestamp;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function serviceEvents(events: EventNode[], serviceId: string, environmentId: string, since: string): ServiceEvents {
  const mine = events.filter(
    (e) =>
      e.object === 'Deployment' &&
      e.createdAt >= since &&
      e.payload?.serviceId === serviceId &&
      (e.environmentId === null || e.environmentId === environmentId),
  );
  const crashes = mine.filter((e) => e.action === 'crashed');
  return {
    crashes: crashes.length,
    restarts: mine.filter((e) => e.action === 'restarted').length,
    lastCrashAt: crashes.map((e) => e.createdAt).sort().at(-1) ?? null,
  };
}

/** Vulnerability notices Railway raised for a database service and has not marked resolved. */
function openVulnerabilities(events: EventNode[], serviceId: string, environmentId: string): VulnerabilityNotice[] {
  const mine = events
    .filter(
      (e) =>
        VULNERABILITY_OBJECTS.has(e.object) &&
        e.payload?.serviceId === serviceId &&
        (e.environmentId === null || e.environmentId === environmentId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const open = new Map<string, VulnerabilityNotice>();
  for (const event of mine) {
    const payload = event.payload ?? {};
    if (event.action === 'triggered') {
      const ids = Array.isArray(payload.cveIds) ? payload.cveIds.filter((x): x is string => typeof x === 'string') : [];
      const single = str(payload.cveId);
      for (const id of ids.length ? ids : single ? [single] : []) {
        open.set(id, { object: event.object, cveIds: [id], severity: str(payload.severity), at: event.createdAt });
      }
    } else if (event.action === 'resolved') {
      const id = str(payload.cveId);
      if (id) open.delete(id);
    }
  }
  return [...open.values()];
}

/**
 * Reads the whole workspace through the fixed read queries. Only the project list is
 * required; every other part is collected independently, and a part that fails is recorded
 * as not checked with the reason while the rest carries on.
 */
export async function collectSnapshot(reader: RailwayReader, options: CollectOptions): Promise<CollectResult> {
  const windowDays = options.windowDays ?? 7;
  const concurrency = options.concurrency ?? 4;
  const now = options.now;
  const endDate = now.toISOString();
  const startDate = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  let requests = 0;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Railway allows a client a fixed number of metric queries at once and refuses the rest.
  // They are queued here well below that number, and one that is still refused waits and
  // tries again before its check is given up as not checked.
  let metricSlots = METRIC_CONCURRENCY;
  const metricWaiters: (() => void)[] = [];
  const withMetricSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (metricSlots > 0) metricSlots -= 1;
    else await new Promise<void>((resolve) => metricWaiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = metricWaiters.shift();
      if (next) next();
      else metricSlots += 1;
    }
  };

  const query = <T>(name: ReadQueryName, variables: Record<string, unknown> = {}): Promise<T> => {
    const send = (): Promise<T> => {
      requests += 1;
      return reader.query<T>(name, variables);
    };
    if (!METRIC_QUERIES.has(name)) return send();
    return withMetricSlot(async () => {
      for (let tries = 0; ; tries += 1) {
        try {
          return await send();
        } catch (err) {
          if (tries >= METRIC_RETRIES || !/too many metric queries/i.test(reasonOf(err))) throw err;
          await sleep(METRIC_RETRY_WAIT_MS);
        }
      }
    });
  };

  const projectNodes: ProjectNode[] = [];
  let after: string | null = null;
  do {
    const page: { projects: Edges<ProjectNode> } = await query('projects', { after });
    projectNodes.push(...nodes(page.projects).filter((p) => !p.deletedAt));
    after = page.projects.pageInfo?.hasNextPage ? (page.projects.pageInfo.endCursor ?? null) : null;
  } while (after);

  const workspaceId = projectNodes.find((p) => p.workspaceId)?.workspaceId ?? '';

  const light = options.inventoryOnly === true;
  const LIGHT = 'Not read during an inventory refresh';
  const unless = <T>(fn: () => Promise<Checked<T>>): Promise<Checked<T>> => (light ? Promise.resolve(notChecked<T>(LIGHT)) : fn());

  const usageByProject = await unless(() => attempt(async () => {
    if (!workspaceId) throw new Error('The workspace id is not known');
    const priorStart = new Date(now.getTime() - (PRIOR_WEEKS + 1) * windowDays * DAY_MS).toISOString();
    type Usage = { usage: { measurement: string; value: number; tags: { projectId: string | null } | null }[] };
    const [current, prior] = await Promise.all([
      query<Usage>('usage', { workspaceId, startDate, endDate }),
      query<Usage>('usage', { workspaceId, startDate: priorStart, endDate: startDate }),
    ]);
    const out = new Map<string, Map<string, { current: number; prior: number }>>();
    const add = (rows: Usage['usage'], key: 'current' | 'prior') => {
      for (const row of rows) {
        const projectId = row.tags?.projectId;
        if (!projectId) continue;
        const byMeasurement = out.get(projectId) ?? new Map<string, { current: number; prior: number }>();
        const entry = byMeasurement.get(row.measurement) ?? { current: 0, prior: 0 };
        entry[key] += row.value;
        byMeasurement.set(row.measurement, entry);
        out.set(projectId, byMeasurement);
      }
    };
    add(current.usage, 'current');
    add(prior.usage, 'prior');
    return out;
  }));

  const projects: ProjectSnapshot[] = projectNodes.map((p) => ({
    id: p.id,
    name: p.name,
    environments: nodes(p.environments)
      .filter((e) => !e.isEphemeral)
      .map((e) => ({ id: e.id, name: e.name })),
    services: nodes(p.services),
    usage: mapChecked(usageByProject, (byProject) =>
      [...(byProject.get(p.id) ?? new Map<string, { current: number; prior: number }>()).entries()].map(
        ([measurement, v]) => ({ measurement, current: v.current, priorWeeklyAverage: v.prior / PRIOR_WEEKS }),
      ),
    ),
  }));

  const eventsByProject = new Map<string, Checked<EventNode[]>>();
  await inBatches(light ? [] : projects, concurrency, async (project) => {
    eventsByProject.set(
      project.id,
      await attempt(async () =>
        nodes((await query<{ events: Edges<EventNode> }>('projectEvents', { projectId: project.id, actions: EVENT_ACTIONS })).events),
      ),
    );
  });

  const services: ServiceSnapshot[] = [];
  const unread: UnreadEnvironment[] = [];
  const environments = projects.flatMap((project) => project.environments.map((environment) => ({ project, environment })));

  await inBatches(environments, concurrency, async ({ project, environment }) => {
    const environmentId = environment.id;
    const listed = await attempt(() => query<EnvironmentData>('environment', { id: environmentId }));
    if (!listed.ok || !listed.value.environment) {
      unread.push({
        projectId: project.id,
        projectName: project.name,
        environmentId,
        environmentName: environment.name,
        reason: listed.ok ? 'Railway returned no environment' : listed.reason,
      });
      return;
    }
    const env = listed.value.environment;
    const instances = nodes(env.serviceInstances);
    if (!instances.length) return;

    const [deployments, metrics, logs] = await Promise.all([
      unless(() => attempt(async () =>
        nodes(
          (
            await query<{ deployments: Edges<DeploymentSummary & { serviceId: string | null }> }>('deployments', {
              projectId: project.id,
              environmentId,
            })
          ).deployments,
        ),
      )),
      unless(() => attempt(async () => (await query<{ metrics: MetricSeries[] }>('metrics', { environmentId, startDate, endDate })).metrics)),
      unless(() => attempt(
        async () =>
          (
            await query<{
              environmentLogs: { timestamp: string; message: string; tags: { serviceId: string | null } | null }[];
            }>('errorLogs', { environmentId, anchorDate: endDate, limit: ERROR_LOG_LIMIT })
          ).environmentLogs,
      )),
    ]);

    const variablesTruncated = env.variables.pageInfo?.hasNextPage === true;
    const variables = nodes(env.variables);
    const volumes = nodes(env.volumeInstances);
    const events = eventsByProject.get(project.id) ?? notChecked(light ? LIGHT : 'Project events were not read');

    for (const instance of instances) {
      const serviceId = instance.serviceId;
      const latest = instance.latestDeployment;
      const meta = latest?.meta ?? {};
      const repo = instance.source?.repo ?? str(meta.repo);
      const image = instance.source?.image ?? null;
      const serviceDomains = (instance.domains?.serviceDomains ?? []).map((d) => d.domain);
      const customDomains = (instance.domains?.customDomains ?? []).map((d) => ({
        domain: d.domain,
        certificateStatus: d.status?.certificateStatus ?? null,
        certificateExpiresAt:
          (d.status?.certificates ?? [])
            .map((c) => c.expiresAt)
            .filter((x): x is string => Boolean(x))
            .sort()
            .at(-1) ?? null,
      }));
      const hasDomain = serviceDomains.length + customDomains.length > 0;
      const scope = { environmentId, serviceId };
      const window = { ...scope, startDate, endDate };

      const [http, latency, tcpProxies, failedStep, lastCronRunAt] = await Promise.all([
        light
          ? Promise.resolve(notChecked<HttpSummary>(LIGHT))
          : hasDomain
          ? attempt(async (): Promise<HttpSummary> => {
              const rows = (
                await query<{ httpMetricsGroupedByStatus: { statusCode: number; samples: { value: number }[] }[] }>(
                  'httpByStatus',
                  window,
                )
              ).httpMetricsGroupedByStatus;
              const byStatus: Record<string, number> = {};
              for (const row of rows) {
                byStatus[String(row.statusCode)] = Math.round(row.samples.reduce((a, s) => a + s.value, 0));
              }
              const entries = Object.entries(byStatus);
              return {
                total: entries.reduce((a, [, n]) => a + n, 0),
                serverErrors: entries.filter(([code]) => Number(code) >= 500).reduce((a, [, n]) => a + n, 0),
                byStatus,
              };
            })
          : Promise.resolve(notChecked<HttpSummary>('The service has no public domain')),
        light
          ? Promise.resolve(notChecked<number | null>(LIGHT))
          : hasDomain
          ? attempt(async (): Promise<number | null> => {
              const samples = (
                await query<{ httpDurationMetrics: { samples: { p95: number }[] } }>('httpDuration', window)
              ).httpDurationMetrics.samples.filter((s) => s.p95 > 0);
              return samples.length ? Math.round(samples.reduce((a, s) => a + s.p95, 0) / samples.length) : null;
            })
          : Promise.resolve(notChecked<number | null>('The service has no public domain')),
        light
          ? Promise.resolve(notChecked<TcpProxy[]>(LIGHT))
          : image && !repo
          ? attempt(async () => (await query<{ tcpProxies: TcpProxy[] }>('tcpProxies', scope)).tcpProxies)
          : Promise.resolve(checked<TcpProxy[]>([])),
        !light && latest && (latest.status === 'FAILED' || latest.status === 'CRASHED')
          ? attempt(async (): Promise<FailedStep | null> => {
              const steps = nodes(
                (
                  await query<{
                    deploymentEvents: Edges<{ step: string; payload: { error: string | null; reason: string | null } | null }>;
                  }>('deploymentEvents', { id: latest.id })
                ).deploymentEvents,
              );
              const failed = steps.find((s) => s.payload?.error);
              return failed ? { step: failed.step, error: redact(failed.payload?.error ?? '').slice(0, 300) } : null;
            })
          : Promise.resolve(checked<FailedStep | null>(null)),
        !light && instance.cronSchedule
          ? attempt(async (): Promise<string | null> => {
              const runs = nodes(
                (
                  await query<{ deploymentInstanceExecutions: Edges<{ createdAt: string }> }>('cronExecutions', scope)
                ).deploymentInstanceExecutions,
              );
              return runs.map((r) => r.createdAt).sort().at(-1) ?? null;
            })
          : Promise.resolve(checked<string | null>(null)),
      ]);

      services.push({
        projectId: project.id,
        projectName: project.name,
        environmentId,
        environmentName: env.name,
        serviceId,
        serviceName: instance.serviceName,
        instanceId: instance.id,
        createdAt: instance.createdAt,
        repo: repo ? repo.toLowerCase() : null,
        image,
        branch: str(meta.branch),
        commitHash: str(meta.commitHash),
        rootDirectory: instance.rootDirectory,
        healthcheckPath: instance.healthcheckPath,
        cronSchedule: instance.cronSchedule,
        sleeps: instance.sleepApplication === true,
        configFile: instance.resolvedFileConfig?.configFile ?? str(meta.configFile) ?? instance.railwayConfigFile,
        serviceDomains,
        customDomains,
        latestDeployment: latest
          ? {
              id: latest.id,
              status: latest.status,
              createdAt: latest.createdAt,
              statusUpdatedAt: latest.statusUpdatedAt,
              stopped: latest.deploymentStopped,
              instanceStatuses: (latest.instances ?? []).map((i) => i.status),
            }
          : null,
        activeDeployments: instance.activeDeployments ?? [],
        variableNames: variablesTruncated
          ? notChecked('The environment has more variables than one request returns')
          : checked(
              variables
                .filter((v) => v.serviceId === serviceId)
                .map((v) => v.name)
                .sort(),
            ),
        volumes: volumes
          .filter((v) => v.serviceId === serviceId)
          .map((v) => ({
            id: v.id,
            name: v.volume?.name ?? 'volume',
            mountPath: v.mountPath,
            sizeMb: v.sizeMB,
            usedMb: v.currentSizeMB,
            state: v.state,
          })),
        deployments: mapChecked(deployments, (all) =>
          all
            .filter((d) => d.serviceId === serviceId && d.createdAt >= startDate)
            .map((d) => ({ id: d.id, status: d.status, createdAt: d.createdAt })),
        ),
        failedStep,
        events: mapChecked(events, (all) => serviceEvents(all, serviceId, environmentId, startDate)),
        vulnerabilities: mapChecked(events, (all) => openVulnerabilities(all, serviceId, environmentId)),
        resources: metrics.ok
          ? (() => {
              const use = resourceUse(metrics.value.filter((s) => s.tags?.serviceId === serviceId));
              return use ? checked(use) : notChecked<ResourceUse>('Railway returned no metrics for this service');
            })()
          : metrics,
        http,
        latencyP95Ms: latency,
        errorLogs: mapChecked(logs, (lines): ErrorLogs => {
          // The log query has no start date: it returns the newest lines, however old.
          const oldest = lines.map((l) => l.timestamp).sort()[0] ?? null;
          const truncated = lines.length >= ERROR_LOG_LIMIT && oldest !== null && oldest > startDate;
          const mine = lines.filter((l) => l.tags?.serviceId === serviceId && l.timestamp >= startDate);
          const groups = groupLogs(mine);
          return {
            groups: groups.slice(0, 20),
            lines: groups.reduce((n, g) => n + g.count, 0),
            truncated,
            since: truncated ? oldest : startDate,
          };
        }),
        tcpProxies,
        lastCronRunAt,
      });
    }
  });

  services.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      a.environmentName.localeCompare(b.environmentName) ||
      a.serviceName.localeCompare(b.serviceName),
  );
  options.log.info('railway snapshot collected', {
    projects: projects.length,
    services: services.length,
    unreadEnvironments: unread.length,
    requests,
  });

  return {
    snapshot: { workspaceId, takenAt: endDate, windowStart: startDate, windowDays, projects, services, requests },
    unread,
  };
}
