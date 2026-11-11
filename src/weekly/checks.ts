import { CronExpressionParser } from 'cron-parser';
import type { Evidence } from '../recommendations/types.js';
import type { Checked, ProjectSnapshot, ServiceSnapshot, WorkspaceSnapshot } from '../railway/types.js';
import { isDatabaseImage } from '../railway/types.js';
import type { Category, CheckCoverage, CheckStatus, FindingDraft, FindingScope, Severity } from './types.js';
import { fingerprint } from './types.js';

/** Railway's published cutoff: railway.json and railway.toml stop being read on this date. */
export const CONFIG_AS_CODE_CUTOFF = '2026-12-01';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the probes saw for one service in one environment during the window. */
export interface ProbeSummary {
  total: number;
  failed: number;
  /** Failures in a row, counting back from the latest probe. */
  failingNow: number;
  lastStatus: number | null;
  lastError: string | null;
  certificateExpiresAt: string | null;
  host: string;
}

/** What GitHub says about a service's repository and deployed commit. */
export interface RepoFacts {
  defaultBranch: string;
  /** Commits on the default branch that the deployed commit does not have. */
  behindBy: Checked<number>;
  criticalAlerts: Checked<number>;
}

export interface CustomCheckResult {
  checkId: string;
  name: string;
  host: string;
  projectId: string;
  projectName: string;
  summary: ProbeSummary | null;
}

export interface CheckContext {
  now: Date;
  snapshot: WorkspaceSnapshot;
  /** Keyed by `environmentId:serviceId`. Null when no probe has ever run. */
  probes: Map<string, ProbeSummary> | null;
  /** Keyed by `environmentId:serviceId`. Not checked when the GitHub App is not configured. */
  github: Checked<Map<string, Checked<RepoFacts>>>;
  customChecks: CustomCheckResult[];
}

interface Outcome {
  status: CheckStatus;
  findings?: FindingDraft[];
}

interface ServiceCheck {
  key: string;
  category: Category;
  label: string;
  run(service: ServiceSnapshot, ctx: CheckContext): Outcome;
}

interface ProjectCheck {
  key: string;
  category: Category;
  label: string;
  run(project: ProjectSnapshot, ctx: CheckContext): Outcome;
}

const OK: Outcome = { status: 'checked' };
const NOT_APPLICABLE: Outcome = { status: 'not_applicable' };
const skipped = (reason: string): Outcome => ({ status: { notChecked: reason } });

export const isDatabase = (service: ServiceSnapshot): boolean => isDatabaseImage(service.repo, service.image);

const hasDomain = (service: ServiceSnapshot): boolean => service.serviceDomains.length + service.customDomains.length > 0;
const isLive = (service: ServiceSnapshot): boolean => service.activeDeployments.length > 0;
const key = (service: Pick<ServiceSnapshot, 'environmentId' | 'serviceId'>) => `${service.environmentId}:${service.serviceId}`;
const day = (iso: string): string => iso.slice(0, 10);
const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;
const daysBetween = (from: string, to: Date): number => Math.max(0, Math.floor((to.getTime() - Date.parse(from)) / DAY_MS));

function scopeOf(service: ServiceSnapshot): FindingScope {
  return {
    projectId: service.projectId,
    projectName: service.projectName,
    environmentId: service.environmentId,
    environmentName: service.environmentName,
    serviceId: service.serviceId,
    serviceName: service.serviceName,
  };
}

const sourceOf = (service: ServiceSnapshot, what: string): string =>
  `Railway ${what} · ${service.projectName} / ${service.serviceName} (${service.environmentName})`;

interface DraftInput {
  check: ServiceCheck | ProjectCheck;
  signature: string;
  severity: Severity;
  title: string;
  cause?: string;
  recommendation: string;
  evidence: Evidence[];
  metric?: number;
  /** A change in the repository can address it. */
  fixable?: boolean;
}

function serviceFinding(service: ServiceSnapshot, input: DraftInput): FindingDraft {
  const scope = scopeOf(service);
  const fixable = input.fixable === true && service.repo !== null;
  return {
    fingerprint: fingerprint(scope, input.check.category, `${input.check.key}:${input.signature}`),
    scope,
    category: input.check.category,
    check: input.check.key,
    severity: input.severity,
    title: input.title,
    cause: input.cause ?? '',
    recommendation: input.recommendation,
    actionType: fixable ? 'fix_via_agent' : 'investigate',
    evidence: input.evidence,
    metric: input.metric,
    repo: service.repo,
    branch: service.branch,
  };
}

const one = (finding: FindingDraft): Outcome => ({ status: 'checked', findings: [finding] });

// Outages ------------------------------------------------------------------------------------

const deploymentState: ServiceCheck = {
  key: 'outage.deployment',
  category: 'outage',
  label: 'Latest deployment crashed or failed',
  run(service) {
    const latest = service.latestDeployment;
    if (!latest) return NOT_APPLICABLE;
    const crashed = latest.status === 'CRASHED' || latest.instanceStatuses.some((s) => s === 'CRASHED');
    const failedAndDown = latest.status === 'FAILED' && !isLive(service);
    if (!crashed && !failedAndDown) return OK;
    const step = service.failedStep.ok ? service.failedStep.value : null;
    const evidence: Evidence[] = [
      { quote: `Latest deployment is ${latest.status} since ${day(latest.statusUpdatedAt ?? latest.createdAt)}.`, source: sourceOf(service, 'deployments') },
    ];
    if (step) evidence.push({ quote: `${step.step}: ${step.error}`, source: sourceOf(service, 'deployment events') });
    return one(
      serviceFinding(service, {
        check: deploymentState,
        signature: crashed ? 'crashed' : 'failed',
        severity: 'critical',
        title: crashed
          ? `crashed on ${day(latest.statusUpdatedAt ?? latest.createdAt)} and is not running`
          : `has not deployed since a failure on ${day(latest.createdAt)}; nothing is running`,
        cause: step ? `The ${step.step.toLowerCase().replace(/_/g, ' ')} step failed.` : '',
        recommendation: crashed
          ? 'Find the cause of the crash in the deploy logs and fix it in the repository.'
          : 'Fix the failing step so the service deploys again.',
        evidence,
        fixable: true,
      }),
    );
  },
};

const crashes: ServiceCheck = {
  key: 'outage.crashes',
  category: 'outage',
  label: 'Crashes and restarts during the week',
  run(service, ctx) {
    if (!service.events.ok) return skipped(service.events.reason);
    const { crashes: count, restarts, lastCrashAt } = service.events.value;
    if (count === 0) return OK;
    return one(
      serviceFinding(service, {
        check: crashes,
        signature: 'crashes',
        severity: count >= 3 ? 'critical' : 'warning',
        title: `crashed ${plural(count, 'time')} in the last ${ctx.snapshot.windowDays} days`,
        recommendation: 'Read the logs around each crash and fix the cause in the repository.',
        evidence: [
          {
            quote: `${plural(count, 'crash', 'crashes')} and ${plural(restarts, 'restart')} since ${day(ctx.snapshot.windowStart)}${lastCrashAt ? `; last crash ${lastCrashAt.slice(0, 16).replace('T', ' ')} UTC` : ''}.`,
            source: sourceOf(service, 'events'),
          },
        ],
        metric: count,
        fixable: true,
      }),
    );
  },
};

const probeHealth: ServiceCheck = {
  key: 'outage.probe',
  category: 'outage',
  label: 'Health probe failures and uptime',
  run(service, ctx) {
    // A database's domain does not speak HTTP, and a service with nothing running is already
    // reported by the deployment check.
    if (!hasDomain(service) || isDatabase(service) || !isLive(service)) return NOT_APPLICABLE;
    if (service.sleeps) return skipped('The service sleeps when idle, and a probe would keep it awake');
    if (!ctx.probes) return skipped('No probe has run yet');
    const summary = ctx.probes.get(key(service));
    if (!summary || summary.total === 0) return skipped('No probe results for this service yet');
    const uptime = 1 - summary.failed / summary.total;
    const last = summary.lastStatus ? `HTTP ${summary.lastStatus}` : (summary.lastError ?? 'no answer');
    const evidence: Evidence[] = [
      {
        quote: `${summary.failed} of ${plural(summary.total, 'probe')} failed (${(uptime * 100).toFixed(1)}% up). Latest: ${last}.`,
        source: `Patcher probe · ${summary.host}`,
      },
    ];
    if (summary.failingNow >= Math.min(3, summary.total)) {
      return one(
        serviceFinding(service, {
          check: probeHealth,
          signature: 'down',
          severity: 'critical',
          title: `is not answering health probes (${last})`,
          recommendation: 'Check whether the service is running and what its public address returns.',
          evidence,
          metric: summary.failed,
          fixable: true,
        }),
      );
    }
    if (summary.total >= 20 && uptime < 0.99) {
      return one(
        serviceFinding(service, {
          check: probeHealth,
          signature: 'uptime',
          severity: 'warning',
          title: `was up ${(uptime * 100).toFixed(1)}% of the last ${ctx.snapshot.windowDays} days`,
          recommendation: 'Look at when the probes failed and what was deployed or running at those times.',
          evidence,
          metric: summary.failed,
        }),
      );
    }
    return OK;
  },
};

const cronRuns: ServiceCheck = {
  key: 'outage.cron',
  category: 'outage',
  label: 'Cron services that did not run',
  run(service, ctx) {
    if (!service.cronSchedule) return NOT_APPLICABLE;
    if (!service.lastCronRunAt.ok) return skipped(service.lastCronRunAt.reason);
    let expected: Date;
    try {
      expected = CronExpressionParser.parse(service.cronSchedule, { currentDate: ctx.now, tz: 'UTC' }).prev().toDate();
    } catch {
      return skipped('The cron schedule could not be read');
    }
    const last = service.lastCronRunAt.value;
    // Ten minutes of slack for a run that is starting now.
    if (ctx.now.getTime() - expected.getTime() < 10 * 60_000) return OK;
    if (last && Date.parse(last) >= expected.getTime() - 60_000) return OK;
    return one(
      serviceFinding(service, {
        check: cronRuns,
        signature: 'missed',
        severity: 'warning',
        title: `did not run on schedule (${service.cronSchedule})`,
        recommendation: 'Check why the scheduled run did not start, and whether the previous run is still going.',
        evidence: [
          {
            quote: `Expected a run at ${expected.toISOString().slice(0, 16).replace('T', ' ')} UTC; last run ${last ? `${last.slice(0, 16).replace('T', ' ')} UTC` : 'never'}.`,
            source: sourceOf(service, 'cron executions'),
          },
        ],
      }),
    );
  },
};

// Bugs ---------------------------------------------------------------------------------------

const MIN_LOG_LINES = 5;
const MAX_LOG_FINDINGS = 3;

const errorLogs: ServiceCheck = {
  key: 'bugs.error_logs',
  category: 'bugs',
  label: 'Error-level log lines by signature',
  run(service) {
    if (!service.errorLogs.ok) return skipped(service.errorLogs.reason);
    const logs = service.errorLogs.value;
    const atLeast = logs.truncated ? 'at least ' : '';
    const findings = logs.groups
      .filter((g) => g.count >= MIN_LOG_LINES)
      .slice(0, MAX_LOG_FINDINGS)
      .map((group) =>
        serviceFinding(service, {
          check: errorLogs,
          signature: group.signature,
          severity: group.count >= 50 ? 'warning' : 'info',
          title: `logged the same error ${atLeast}${plural(group.count, 'time')}: ${group.signature.slice(0, 70)}`,
          recommendation: 'Find where this error is raised and fix the cause, or lower its level if it is expected.',
          evidence: [
            {
              quote: group.signature,
              source: `${sourceOf(service, 'error logs')} · ${atLeast}${group.count} lines, ${group.firstAt.slice(0, 16).replace('T', ' ')} to ${group.lastAt.slice(0, 16).replace('T', ' ')} UTC`,
            },
          ],
          metric: group.count,
          fixable: true,
        }),
      );
    return { status: 'checked', findings };
  },
};

const serverErrors: ServiceCheck = {
  key: 'bugs.http_5xx',
  category: 'bugs',
  label: 'HTTP 5xx rate',
  run(service, ctx) {
    if (!hasDomain(service)) return NOT_APPLICABLE;
    if (!service.http.ok) return skipped(service.http.reason);
    const { total, serverErrors: errors, byStatus } = service.http.value;
    if (total < 50 || errors === 0) return OK;
    const rate = errors / total;
    if (rate < 0.01) return OK;
    const codes = Object.entries(byStatus)
      .filter(([code]) => Number(code) >= 500)
      .map(([code, n]) => `${code}: ${n}`)
      .join(', ');
    return one(
      serviceFinding(service, {
        check: serverErrors,
        signature: '5xx',
        severity: rate >= 0.25 ? 'critical' : rate >= 0.05 ? 'warning' : 'info',
        title: `answered ${percent(rate)} of requests with a server error`,
        recommendation: 'Find which routes return 5xx in the HTTP logs and fix the failing handler.',
        evidence: [
          {
            quote: `${errors} of ${total} requests in the last ${ctx.snapshot.windowDays} days returned 5xx (${codes}).`,
            source: sourceOf(service, 'HTTP metrics'),
          },
        ],
        metric: Math.round(rate * 1000) / 10,
        fixable: true,
      }),
    );
  },
};

// Capacity -----------------------------------------------------------------------------------

const memory: ServiceCheck = {
  key: 'capacity.memory',
  category: 'capacity',
  label: 'Memory against its limit',
  run(service) {
    if (!service.resources.ok) return service.latestDeployment ? skipped(service.resources.reason) : NOT_APPLICABLE;
    const use = service.resources.value;
    if (!use.memoryLimitGb) return skipped('Railway reported no memory limit for this service');
    const ratio = use.memoryMaxGb / use.memoryLimitGb;
    if (ratio < 0.9) return OK;
    return one(
      serviceFinding(service, {
        check: memory,
        signature: 'memory',
        severity: 'warning',
        title: `used ${percent(ratio)} of its memory limit`,
        cause: 'A leak, a larger workload, or a limit that is too low.',
        recommendation: 'Check for memory growth over time; fix the leak or raise the limit.',
        evidence: [
          {
            quote: `Peak ${use.memoryMaxGb.toFixed(2)} GB against a limit of ${use.memoryLimitGb.toFixed(2)} GB; average ${use.memoryAvgGb.toFixed(2)} GB.`,
            source: sourceOf(service, 'metrics'),
          },
        ],
        metric: Math.round(ratio * 100),
        fixable: true,
      }),
    );
  },
};

const cpu: ServiceCheck = {
  key: 'capacity.cpu',
  category: 'capacity',
  label: 'CPU against its limit',
  run(service) {
    if (!service.resources.ok) return service.latestDeployment ? skipped(service.resources.reason) : NOT_APPLICABLE;
    const use = service.resources.value;
    if (!use.cpuLimit) return skipped('Railway reported no CPU limit for this service');
    const ratio = use.cpuAvg / use.cpuLimit;
    if (ratio < 0.8) return OK;
    return one(
      serviceFinding(service, {
        check: cpu,
        signature: 'cpu',
        severity: 'warning',
        title: `averaged ${percent(ratio)} of its CPU limit`,
        recommendation: 'Find what is using the CPU; optimise it, add replicas or raise the limit.',
        evidence: [
          {
            quote: `Average ${use.cpuAvg.toFixed(2)} vCPU, peak ${use.cpuMax.toFixed(2)}, limit ${use.cpuLimit.toFixed(0)}.`,
            source: sourceOf(service, 'metrics'),
          },
        ],
        metric: Math.round(ratio * 100),
      }),
    );
  },
};

const outOfMemory: ServiceCheck = {
  key: 'capacity.oom',
  category: 'capacity',
  label: 'Out-of-memory kills',
  run: () => skipped('Railway does not report out-of-memory kills through its API; crashes are counted under Outages'),
};

const volumeFill: ServiceCheck = {
  key: 'capacity.volume',
  category: 'capacity',
  label: 'Volume fill',
  run(service) {
    if (!service.volumes.length) return NOT_APPLICABLE;
    const findings = service.volumes
      .filter((v) => v.sizeMb > 0 && v.usedMb / v.sizeMb >= 0.8)
      .map((volume) => {
        const ratio = volume.usedMb / volume.sizeMb;
        return serviceFinding(service, {
          check: volumeFill,
          signature: `volume:${volume.id}`,
          severity: ratio >= 0.9 ? 'critical' : 'warning',
          title: `volume is ${percent(ratio)} full`,
          recommendation: 'Grow the volume or remove data before it fills; a full volume stops a database.',
          evidence: [
            {
              quote: `${volume.name} at ${volume.mountPath}: ${(volume.usedMb / 1000).toFixed(1)} GB of ${(volume.sizeMb / 1000).toFixed(1)} GB used.`,
              source: sourceOf(service, 'volumes'),
            },
          ],
          metric: Math.round(ratio * 100),
        });
      });
    return { status: 'checked', findings };
  },
};

const postgres: ServiceCheck = {
  key: 'capacity.postgres',
  category: 'capacity',
  label: 'Postgres size and connections',
  run: (service) =>
    isDatabase(service)
      ? skipped('Needs a connection to the database, which Patcher does not open; volume fill is checked instead')
      : NOT_APPLICABLE,
};

const latency: ServiceCheck = {
  key: 'capacity.latency',
  category: 'capacity',
  label: 'Response time',
  run(service, ctx) {
    if (!hasDomain(service)) return NOT_APPLICABLE;
    if (!service.latencyP95Ms.ok) return skipped(service.latencyP95Ms.reason);
    const p95 = service.latencyP95Ms.value;
    if (p95 === null || p95 < 2000) return OK;
    return one(
      serviceFinding(service, {
        check: latency,
        signature: 'p95',
        severity: 'warning',
        title: `is slow: 95% of requests take up to ${(p95 / 1000).toFixed(1)} s`,
        recommendation: 'Find the slow routes in the HTTP logs and the queries behind them.',
        evidence: [
          { quote: `Daily p95 response time averaged ${p95} ms over the last ${ctx.snapshot.windowDays} days.`, source: sourceOf(service, 'HTTP metrics') },
        ],
        metric: p95,
        fixable: true,
      }),
    );
  },
};

// Deploy hygiene -----------------------------------------------------------------------------

const failedBuilds: ServiceCheck = {
  key: 'deploy.failed_builds',
  category: 'deploy',
  label: 'Failed builds',
  run(service, ctx) {
    const latest = service.latestDeployment;
    if (!latest) return NOT_APPLICABLE;
    if (!service.deployments.ok) return skipped(service.deployments.reason);
    const failedThisWeek = service.deployments.value.filter((d) => d.status === 'FAILED').length;
    const latestFailed = latest.status === 'FAILED';
    // With nothing running it is an outage, reported by `outage.deployment`.
    if (latestFailed && !isLive(service)) return OK;
    if (!latestFailed && failedThisWeek === 0) return OK;
    const running = service.activeDeployments.map((d) => d.createdAt).sort().at(-1);
    const stale = running ? daysBetween(running, ctx.now) : null;
    const step = service.failedStep.ok ? service.failedStep.value : null;
    const evidence: Evidence[] = [
      {
        quote: latestFailed
          ? `Latest deployment failed on ${day(latest.createdAt)}${running ? `; the running build is from ${day(running)}` : ''}.`
          : `${plural(failedThisWeek, 'deployment')} failed since ${day(ctx.snapshot.windowStart)}; the latest succeeded.`,
        source: sourceOf(service, 'deployments'),
      },
    ];
    if (step) evidence.push({ quote: `${step.step}: ${step.error}`, source: sourceOf(service, 'deployment events') });
    return one(
      serviceFinding(service, {
        check: failedBuilds,
        signature: 'failed',
        severity: latestFailed ? 'warning' : 'info',
        title: latestFailed
          ? `latest deployment failed${stale !== null ? `; no successful deploy in ${plural(stale, 'day')}` : ''}`
          : `had ${plural(failedThisWeek, 'failed deployment')} this week`,
        cause: step ? `The ${step.step.toLowerCase().replace(/_/g, ' ')} step failed.` : '',
        recommendation: 'Fix the failing step so new commits reach production.',
        evidence,
        metric: failedThisWeek,
        fixable: true,
      }),
    );
  },
};

const needsApproval: ServiceCheck = {
  key: 'deploy.needs_approval',
  category: 'deploy',
  label: 'Deployments waiting for approval',
  run(service, ctx) {
    const latest = service.latestDeployment;
    if (!latest) return NOT_APPLICABLE;
    if (latest.status !== 'NEEDS_APPROVAL') return OK;
    const waiting = daysBetween(latest.createdAt, ctx.now);
    return one(
      serviceFinding(service, {
        check: needsApproval,
        signature: 'needs_approval',
        severity: waiting >= 7 ? 'warning' : 'info',
        title: `has a deployment waiting for approval since ${day(latest.createdAt)}`,
        cause: 'Railway holds deployments of commits by authors it does not recognise.',
        recommendation: 'Approve or reject the deployment in Railway.',
        evidence: [{ quote: `Latest deployment is NEEDS_APPROVAL, created ${day(latest.createdAt)}.`, source: sourceOf(service, 'deployments') }],
      }),
    );
  },
};

const behindDefault: ServiceCheck = {
  key: 'deploy.behind_default',
  category: 'deploy',
  label: 'Production behind the default branch',
  run(service, ctx) {
    if (!service.repo || !service.commitHash) return NOT_APPLICABLE;
    if (!ctx.github.ok) return skipped(ctx.github.reason);
    const facts = ctx.github.value.get(key(service));
    if (!facts) return skipped('GitHub was not asked about this repository');
    if (!facts.ok) return skipped(facts.reason);
    if (!facts.value.behindBy.ok) return skipped(facts.value.behindBy.reason);
    const behind = facts.value.behindBy.value;
    if (behind === 0) return OK;
    return one(
      serviceFinding(service, {
        check: behindDefault,
        signature: 'behind',
        severity: behind >= 10 ? 'warning' : 'info',
        title: `is ${plural(behind, 'commit')} behind ${facts.value.defaultBranch}`,
        recommendation: 'Deploy the default branch, or confirm the service is meant to track another branch.',
        evidence: [
          {
            quote: `Deployed commit ${service.commitHash.slice(0, 7)}${service.branch ? ` from ${service.branch}` : ''} is ${plural(behind, 'commit')} behind ${facts.value.defaultBranch}.`,
            source: `GitHub compare · ${service.repo}`,
            url: `https://github.com/${service.repo}/compare/${service.commitHash}...${facts.value.defaultBranch}`,
          },
        ],
        metric: behind,
      }),
    );
  },
};

const siblings = (service: ServiceSnapshot, ctx: CheckContext): ServiceSnapshot[] =>
  ctx.snapshot.services.filter((s) => s.serviceId === service.serviceId && s.environmentId !== service.environmentId);

const isPrimary = (service: ServiceSnapshot, others: ServiceSnapshot[]): boolean =>
  service.environmentName.toLowerCase() === 'production' ||
  (!others.some((o) => o.environmentName.toLowerCase() === 'production') &&
    others.every((o) => service.environmentName.localeCompare(o.environmentName) < 0));

const environmentDrift: ServiceCheck = {
  key: 'deploy.drift',
  category: 'deploy',
  label: 'Staging and production drift',
  run(service, ctx) {
    const others = siblings(service, ctx);
    if (!others.length || !service.commitHash) return NOT_APPLICABLE;
    // Reported once, on the production side.
    if (!isPrimary(service, others)) return OK;
    const different = others.filter((o) => o.commitHash && o.commitHash !== service.commitHash);
    if (!different.length) return OK;
    return one(
      serviceFinding(service, {
        check: environmentDrift,
        signature: 'commit',
        severity: 'info',
        title: `runs a different commit than ${different.map((o) => o.environmentName).join(', ')}`,
        recommendation: 'Confirm the difference is intended, or deploy the same commit to both.',
        evidence: [
          {
            quote: [service, ...different].map((s) => `${s.environmentName}: ${s.commitHash!.slice(0, 7)}`).join('; '),
            source: sourceOf(service, 'deployments'),
          },
        ],
      }),
    );
  },
};

const variableDrift: ServiceCheck = {
  key: 'deploy.variable_drift',
  category: 'deploy',
  label: 'Variables missing in one environment (names only)',
  run(service, ctx) {
    const others = siblings(service, ctx);
    if (!others.length) return NOT_APPLICABLE;
    if (!service.variableNames.ok) return skipped(service.variableNames.reason);
    if (!isPrimary(service, others)) return OK;
    const mine = new Set(service.variableNames.value.filter((n) => !n.startsWith('RAILWAY_')));
    const findings: FindingDraft[] = [];
    for (const other of others) {
      if (!other.variableNames.ok) continue;
      const theirs = new Set(other.variableNames.value.filter((n) => !n.startsWith('RAILWAY_')));
      const missingThere = [...mine].filter((n) => !theirs.has(n));
      const missingHere = [...theirs].filter((n) => !mine.has(n));
      if (!missingThere.length && !missingHere.length) continue;
      const parts = [
        missingThere.length ? `set in ${service.environmentName} but not ${other.environmentName}: ${missingThere.join(', ')}` : '',
        missingHere.length ? `set in ${other.environmentName} but not ${service.environmentName}: ${missingHere.join(', ')}` : '',
      ].filter(Boolean);
      findings.push(
        serviceFinding(service, {
          check: variableDrift,
          signature: `variables:${other.environmentId}`,
          severity: 'info',
          title: `has ${plural(missingThere.length + missingHere.length, 'variable')} set in only one of ${service.environmentName} and ${other.environmentName}`,
          recommendation: 'Set the missing variables, or confirm each is meant for one environment only.',
          evidence: [{ quote: `Variable names ${parts.join('; ')}.`, source: sourceOf(service, 'variable names') }],
          metric: missingThere.length + missingHere.length,
        }),
      );
    }
    return { status: 'checked', findings };
  },
};

const healthCheck: ServiceCheck = {
  key: 'deploy.healthcheck',
  category: 'deploy',
  label: 'No health check configured',
  run(service) {
    if (!hasDomain(service) || isDatabase(service) || !service.latestDeployment) return NOT_APPLICABLE;
    if (service.healthcheckPath) return OK;
    return one(
      serviceFinding(service, {
        check: healthCheck,
        signature: 'none',
        severity: 'info',
        title: 'has no health check, so a broken deploy can replace a working one',
        recommendation: 'Add a health endpoint and set it as the health check path in Railway.',
        evidence: [{ quote: 'healthcheckPath is not set on the service.', source: sourceOf(service, 'service settings') }],
      }),
    );
  },
};

const configAsCode: ServiceCheck = {
  key: 'deploy.config_as_code',
  category: 'deploy',
  label: 'railway.json or railway.toml still in use',
  run(service, ctx) {
    if (!service.latestDeployment) return NOT_APPLICABLE;
    if (!service.configFile) return OK;
    const past = ctx.now.toISOString().slice(0, 10) >= CONFIG_AS_CODE_CUTOFF;
    return one(
      serviceFinding(service, {
        check: configAsCode,
        signature: 'config_file',
        severity: 'warning',
        title: past
          ? `last read ${service.configFile}, which Railway stopped reading on ${CONFIG_AS_CODE_CUTOFF}`
          : `still reads ${service.configFile}, which Railway stops reading on ${CONFIG_AS_CODE_CUTOFF}`,
        cause: 'Config as Code is deprecated; build and deploy settings in the file override the dashboard only until the cutoff.',
        recommendation:
          'Move the build and deploy settings in the file to the service settings or to .railway/railway.ts before the cutoff, then remove the file.',
        evidence: [
          { quote: `The latest deployment read its settings from ${service.configFile}.`, source: sourceOf(service, 'deployment') },
          {
            quote: `Existing railway.json / railway.toml files continue to work for services that already use them until ${CONFIG_AS_CODE_CUTOFF} (hard cutoff).`,
            source: 'Railway docs',
            url: 'https://docs.railway.com/config-as-code',
          },
        ],
        fixable: true,
      }),
    );
  },
};

// Security -----------------------------------------------------------------------------------

const dependencyAlerts: ServiceCheck = {
  key: 'security.dependency_alerts',
  category: 'security',
  label: 'Open critical dependency alerts',
  run(service, ctx) {
    if (!service.repo) return NOT_APPLICABLE;
    if (!ctx.github.ok) return skipped(ctx.github.reason);
    const facts = ctx.github.value.get(key(service));
    if (!facts) return skipped('GitHub was not asked about this repository');
    if (!facts.ok) return skipped(facts.reason);
    if (!facts.value.criticalAlerts.ok) return skipped(facts.value.criticalAlerts.reason);
    const count = facts.value.criticalAlerts.value;
    if (count === 0) return OK;
    return one(
      serviceFinding(service, {
        check: dependencyAlerts,
        signature: 'critical',
        severity: 'warning',
        title: `has ${plural(count, 'open critical dependency alert')}`,
        recommendation: 'Update the affected dependencies.',
        evidence: [
          {
            quote: `${plural(count, 'open Dependabot alert')} of critical severity.`,
            source: `GitHub Dependabot · ${service.repo}`,
            url: `https://github.com/${service.repo}/security/dependabot`,
          },
        ],
        metric: count,
        fixable: true,
      }),
    );
  },
};

const publicDatabase: ServiceCheck = {
  key: 'security.public_database',
  category: 'security',
  label: 'Databases exposed on a public proxy',
  run(service) {
    if (!isDatabase(service)) return NOT_APPLICABLE;
    if (!service.tcpProxies.ok) return skipped(service.tcpProxies.reason);
    const proxies = service.tcpProxies.value;
    if (!proxies.length) return OK;
    return one(
      serviceFinding(service, {
        check: publicDatabase,
        signature: 'tcp_proxy',
        severity: 'info',
        title: 'database is reachable from the internet through a public proxy',
        cause: 'Railway database templates add a TCP proxy by default.',
        recommendation: 'Remove the TCP proxy if nothing outside Railway connects to it; services inside the project use the private network.',
        evidence: [
          {
            quote: proxies.map((p) => `${p.domain}:${p.proxyPort} forwards to port ${p.applicationPort}`).join('; '),
            source: sourceOf(service, 'TCP proxies'),
          },
        ],
      }),
    );
  },
};

const certificates: ServiceCheck = {
  key: 'security.certificate',
  category: 'security',
  label: 'Certificates near expiry',
  run(service, ctx) {
    if (!hasDomain(service)) return NOT_APPLICABLE;
    const findings: FindingDraft[] = [];
    const expiring = (host: string, expiresAt: string, source: string) => {
      const daysLeft = Math.floor((Date.parse(expiresAt) - ctx.now.getTime()) / DAY_MS);
      if (daysLeft >= 14) return;
      findings.push(
        serviceFinding(service, {
          check: certificates,
          signature: `expiry:${host}`,
          severity: daysLeft < 3 ? 'critical' : 'warning',
          title: daysLeft < 0 ? `certificate for ${host} has expired` : `certificate for ${host} expires in ${plural(daysLeft, 'day')}`,
          recommendation: 'Check the domain in Railway; renewal is automatic and has not happened.',
          evidence: [{ quote: `Certificate for ${host} expires ${day(expiresAt)}.`, source }],
        }),
      );
    };
    for (const domain of service.customDomains) {
      if (domain.certificateStatus && domain.certificateStatus !== 'CERTIFICATE_STATUS_TYPE_VALID') {
        const status = domain.certificateStatus.replace('CERTIFICATE_STATUS_TYPE_', '').toLowerCase().replace(/_/g, ' ');
        findings.push(
          serviceFinding(service, {
            check: certificates,
            signature: `status:${domain.domain}`,
            severity: 'warning',
            title: `certificate for ${domain.domain} is not valid (${status})`,
            recommendation: 'Check the DNS records for the domain in Railway.',
            evidence: [{ quote: `Certificate status for ${domain.domain}: ${status}.`, source: sourceOf(service, 'domains') }],
          }),
        );
      } else if (domain.certificateExpiresAt) {
        expiring(domain.domain, domain.certificateExpiresAt, sourceOf(service, 'domains'));
      }
    }
    const probe = ctx.probes?.get(key(service));
    if (probe?.certificateExpiresAt && !service.customDomains.some((d) => d.domain === probe.host)) {
      expiring(probe.host, probe.certificateExpiresAt, `Patcher probe · ${probe.host}`);
    }
    return { status: 'checked', findings };
  },
};

const databaseVulnerabilities: ServiceCheck = {
  key: 'security.database_vulnerability',
  category: 'security',
  label: 'Database vulnerabilities flagged by Railway',
  run(service) {
    if (!isDatabase(service)) return NOT_APPLICABLE;
    if (!service.vulnerabilities.ok) return skipped(service.vulnerabilities.reason);
    const open = service.vulnerabilities.value;
    if (!open.length) return OK;
    const ids = [...new Set(open.flatMap((v) => v.cveIds))].sort();
    return one(
      serviceFinding(service, {
        check: databaseVulnerabilities,
        signature: 'cve',
        severity: 'warning',
        title: `has ${plural(ids.length, 'unpatched vulnerability notice')} from Railway (${ids.slice(0, 2).join(', ')}${ids.length > 2 ? ', …' : ''})`,
        recommendation: 'Apply the database image update Railway offers for this service.',
        evidence: [
          {
            quote: `Railway raised ${ids.join(', ')} on ${day(open[0]!.at)} and has not marked ${ids.length === 1 ? 'it' : 'them'} resolved.`,
            source: sourceOf(service, 'events'),
          },
        ],
        metric: ids.length,
      }),
    );
  },
};

// Cost ---------------------------------------------------------------------------------------

/** Railway list prices per unit-minute (per GB for egress), to turn usage into dollars. */
const PRICE: Record<string, number> = {
  CPU_USAGE: 20 / 43_200,
  MEMORY_USAGE_GB: 10 / 43_200,
  DISK_USAGE_GB: 0.15 / 43_200,
  NETWORK_TX_GB: 0.05,
};

const usageGrowth: ProjectCheck = {
  key: 'cost.usage',
  category: 'cost',
  label: 'Usage against prior weeks',
  run(project, ctx) {
    if (!project.usage.ok) return skipped(project.usage.reason);
    const cost = (pick: (row: { current: number; priorWeeklyAverage: number }) => number) =>
      project.usage.ok ? project.usage.value.reduce((sum, row) => sum + pick(row) * (PRICE[row.measurement] ?? 0), 0) : 0;
    const current = cost((r) => r.current);
    const prior = cost((r) => r.priorWeeklyAverage);
    if (prior <= 0 || current < prior * 1.5 || current - prior < 2) return OK;
    const scope: FindingScope = { projectId: project.id, projectName: project.name };
    return one({
      fingerprint: fingerprint(scope, 'cost', 'cost.usage:growth'),
      scope,
      category: 'cost',
      check: usageGrowth.key,
      severity: current - prior >= 10 ? 'warning' : 'info',
      title: `cost about $${current.toFixed(0)} this week, up from $${prior.toFixed(0)} a week`,
      cause: '',
      recommendation: 'Check which service grew in the Railway usage view and whether the growth is expected.',
      actionType: 'investigate',
      evidence: [
        {
          quote: `Estimated at list prices: $${current.toFixed(2)} in the last ${ctx.snapshot.windowDays} days against a weekly average of $${prior.toFixed(2)} over the three weeks before.`,
          source: `Railway usage · ${project.name}`,
        },
      ],
      metric: Math.round(current * 100) / 100,
    });
  },
};

const idle: ServiceCheck = {
  key: 'cost.idle',
  category: 'cost',
  label: 'Idle services',
  run(service, ctx) {
    if (isDatabase(service) || service.cronSchedule || service.sleeps || !isLive(service)) return NOT_APPLICABLE;
    if (service.createdAt && daysBetween(service.createdAt, ctx.now) < ctx.snapshot.windowDays) return NOT_APPLICABLE;
    if (!service.resources.ok) return skipped(service.resources.reason);
    if (hasDomain(service) && !service.http.ok) return skipped(service.http.reason);
    const use = service.resources.value;
    const requests = service.http.ok ? service.http.value.total : 0;
    if (requests > 0 || use.cpuAvg >= 0.001 || use.networkTxGb >= 0.001) return OK;
    return one(
      serviceFinding(service, {
        check: idle,
        signature: 'idle',
        severity: 'info',
        title: `looks idle: ${hasDomain(service) ? 'no requests and ' : ''}almost no CPU or traffic in ${ctx.snapshot.windowDays} days`,
        recommendation: 'Remove the service or let it sleep when idle, if nothing depends on it.',
        evidence: [
          {
            quote: `${hasDomain(service) ? `${requests} requests; ` : ''}average ${use.cpuAvg.toFixed(4)} vCPU; ${(use.networkTxGb * 1000).toFixed(2)} MB sent; ${use.memoryAvgGb.toFixed(2)} GB memory held.`,
            source: sourceOf(service, 'metrics'),
          },
        ],
      }),
    );
  },
};

export const SERVICE_CHECKS: ServiceCheck[] = [
  deploymentState,
  crashes,
  probeHealth,
  cronRuns,
  errorLogs,
  serverErrors,
  memory,
  cpu,
  outOfMemory,
  volumeFill,
  postgres,
  latency,
  failedBuilds,
  needsApproval,
  behindDefault,
  environmentDrift,
  variableDrift,
  healthCheck,
  configAsCode,
  dependencyAlerts,
  publicDatabase,
  certificates,
  databaseVulnerabilities,
  idle,
];

export const PROJECT_CHECKS: ProjectCheck[] = [usageGrowth];

const CUSTOM = { key: 'custom.check', category: 'custom' as const, label: 'Project-specific checks' };

function customFindings(ctx: CheckContext, coverage: CheckCoverage, checkedScopes: Set<string>): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const check of ctx.customChecks) {
    const summary = check.summary;
    if (!summary || summary.total === 0) {
      coverage.notChecked += 1;
      coverage.reasons['No probe results for this check yet'] = (coverage.reasons['No probe results for this check yet'] ?? 0) + 1;
      continue;
    }
    coverage.checked += 1;
    checkedScopes.add(`${CUSTOM.key}|project:${check.projectId}`);
    if (summary.failingNow === 0 && summary.failed / summary.total <= 0.01) continue;
    const scope: FindingScope = { projectId: check.projectId, projectName: check.projectName };
    const last = summary.lastError ?? (summary.lastStatus ? `HTTP ${summary.lastStatus}` : 'no answer');
    findings.push({
      fingerprint: fingerprint(scope, 'custom', `custom.check:${check.checkId}`),
      scope,
      category: 'custom',
      check: CUSTOM.key,
      severity: summary.failingNow >= Math.min(3, summary.total) ? 'critical' : 'warning',
      title: summary.failingNow > 0 ? `check "${check.name}" is failing (${last})` : `check "${check.name}" failed ${summary.failed} of ${plural(summary.total, 'time')}`,
      cause: '',
      recommendation: 'Open the address the check calls and compare what it returns with what the check expects.',
      actionType: 'investigate',
      evidence: [
        { quote: `${summary.failed} of ${plural(summary.total, 'probe')} failed. Latest: ${last}.`, source: `Patcher check · ${check.name} · ${check.host}` },
      ],
      metric: summary.failed,
    });
  }
  return findings;
}

export interface Evaluation {
  findings: FindingDraft[];
  coverage: CheckCoverage[];
  /**
   * `check|scope` for every place a check actually ran. A finding from an earlier week is
   * resolved only if its check ran there this week and did not raise it again.
   */
  checkedScopes: Set<string>;
}

export const serviceScope = (environmentId: string, serviceId: string): string => `${environmentId}:${serviceId}`;
export const projectScope = (projectId: string): string => `project:${projectId}`;

/** Runs every check over the snapshot. Pure: no clock, network or database of its own. */
export function evaluate(ctx: CheckContext): Evaluation {
  const findings: FindingDraft[] = [];
  const coverage: CheckCoverage[] = [];
  const blank = (check: { key: string; category: Category; label: string }): CheckCoverage => ({
    key: check.key,
    category: check.category,
    label: check.label,
    checked: 0,
    notApplicable: 0,
    notChecked: 0,
    reasons: {},
  });
  const checkedScopes = new Set<string>();
  const record = (entry: CheckCoverage, outcome: Outcome, scope: string) => {
    if (outcome.status === 'checked') {
      entry.checked += 1;
      checkedScopes.add(`${entry.key}|${scope}`);
    }
    else if (outcome.status === 'not_applicable') entry.notApplicable += 1;
    else {
      entry.notChecked += 1;
      entry.reasons[outcome.status.notChecked] = (entry.reasons[outcome.status.notChecked] ?? 0) + 1;
    }
    if (outcome.findings) findings.push(...outcome.findings);
  };

  for (const check of SERVICE_CHECKS) {
    const entry = blank(check);
    for (const service of ctx.snapshot.services) {
      record(entry, check.run(service, ctx), serviceScope(service.environmentId, service.serviceId));
    }
    coverage.push(entry);
  }
  for (const check of PROJECT_CHECKS) {
    const entry = blank(check);
    for (const project of ctx.snapshot.projects) record(entry, check.run(project, ctx), projectScope(project.id));
    coverage.push(entry);
  }
  const custom = blank(CUSTOM);
  findings.push(...customFindings(ctx, custom, checkedScopes));
  coverage.push(custom);

  return { findings, coverage, checkedScopes };
}
