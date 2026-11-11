/**
 * What the collectors hand to the checks. A part that could not be read is `{ ok: false }`
 * with the reason, so a check can say "not checked" instead of assuming all is well.
 */
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export const checked = <T>(value: T): Checked<T> => ({ ok: true, value });
export const notChecked = <T = never>(reason: string): Checked<T> => ({ ok: false, reason });

export interface DeploymentSummary {
  id: string;
  status: string;
  createdAt: string;
}

export interface FailedStep {
  step: string;
  /** Redacted. */
  error: string;
}

export interface ServiceEvents {
  crashes: number;
  restarts: number;
  lastCrashAt: string | null;
}

export interface ResourceUse {
  cpuAvg: number;
  cpuMax: number;
  cpuLimit: number | null;
  memoryAvgGb: number;
  memoryMaxGb: number;
  memoryLimitGb: number | null;
  networkTxGb: number;
  samples: number;
}

export interface HttpSummary {
  total: number;
  serverErrors: number;
  /** Requests by status code. */
  byStatus: Record<string, number>;
}

export interface LogGroup {
  /** Normalized and redacted; never a raw log line. */
  signature: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface ErrorLogs {
  groups: LogGroup[];
  lines: number;
  /** True when the environment had more error lines than one request returns. */
  truncated: boolean;
  /** Oldest line read, which is where the window starts when truncated. */
  since: string | null;
}

export interface CustomDomain {
  domain: string;
  certificateStatus: string | null;
  certificateExpiresAt: string | null;
}

export interface VolumeSnapshot {
  id: string;
  name: string;
  mountPath: string;
  sizeMb: number;
  usedMb: number;
  state: string | null;
}

export interface TcpProxy {
  domain: string;
  proxyPort: number;
  applicationPort: number;
}

export interface VulnerabilityNotice {
  object: string;
  cveIds: string[];
  severity: string | null;
  at: string;
}

export interface ServiceSnapshot {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  serviceId: string;
  serviceName: string;
  instanceId: string;
  createdAt: string | null;
  repo: string | null;
  image: string | null;
  branch: string | null;
  commitHash: string | null;
  rootDirectory: string | null;
  healthcheckPath: string | null;
  cronSchedule: string | null;
  sleeps: boolean;
  /** Path of the railway.json or railway.toml the latest deployment read, if any. */
  configFile: string | null;
  serviceDomains: string[];
  customDomains: CustomDomain[];
  latestDeployment: {
    id: string;
    status: string;
    createdAt: string;
    statusUpdatedAt: string | null;
    stopped: boolean;
    instanceStatuses: string[];
  } | null;
  /** Deployments serving traffic now, which can be older than the latest one. */
  activeDeployments: DeploymentSummary[];
  /** Names only. Values are never requested. */
  variableNames: Checked<string[]>;
  volumes: VolumeSnapshot[];
  deployments: Checked<DeploymentSummary[]>;
  failedStep: Checked<FailedStep | null>;
  events: Checked<ServiceEvents>;
  vulnerabilities: Checked<VulnerabilityNotice[]>;
  resources: Checked<ResourceUse>;
  http: Checked<HttpSummary>;
  latencyP95Ms: Checked<number | null>;
  errorLogs: Checked<ErrorLogs>;
  tcpProxies: Checked<TcpProxy[]>;
  lastCronRunAt: Checked<string | null>;
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  environments: { id: string; name: string }[];
  services: { id: string; name: string }[];
  /** Usage this window against the average of the weeks before it, per measurement. */
  usage: Checked<{ measurement: string; current: number; priorWeeklyAverage: number }[]>;
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  takenAt: string;
  windowStart: string;
  windowDays: number;
  projects: ProjectSnapshot[];
  services: ServiceSnapshot[];
  /** Railway requests made, for the run log. */
  requests: number;
}

const DATABASE_IMAGE = /postgres|postgis|pgvector|timescale|mysql|mariadb|mongo|redis|valkey|clickhouse|memcached|rabbitmq|minio/i;

/** A service that runs a stock database image rather than code from a repository. */
export const isDatabaseImage = (repo: string | null, image: string | null): boolean => !repo && DATABASE_IMAGE.test(image ?? '');
