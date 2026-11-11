import { z } from 'zod';
import { estimateTokens } from '../ai/models.js';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import type { Checked, ProjectSnapshot, ServiceSnapshot, WorkspaceSnapshot } from '../railway/types.js';
import { isDatabaseImage } from '../railway/types.js';
import type { ProbeSummary } from './checks.js';
import { projectScope, serviceScope } from './checks.js';
import type { Finding, TrackedFinding } from './findings.js';
import type { ActionType, Assessment } from './types.js';
import { CATEGORIES } from './types.js';
import { cleanLine, cleanText, numbersGrounded, quoteGrounded } from './wording.js';

/**
 * Step 1 of the analysis (design 7.3): one request per service that has something wrong
 * with it. The model is given that service's collector output, its findings and its
 * redacted log patterns, and drafts for each finding a headline, the likely cause, the
 * next step and the kind of action. One service per request, so one client's data never
 * shares a prompt with another's. The requests go out as one batch, at half price.
 */

const entry = z.strictObject({
  finding: z.string().max(12),
  headline: z.string().max(600),
  cause: z.string().max(3000),
  recommendation: z.string().max(3000),
  action: z.enum(['fix_via_agent', 'investigate', 'none']),
  quote: z.string().max(3000),
});
// Lengths here only stop a runaway reply. Each entry is held to the real limits one by
// one below, so one long headline costs that entry and not the whole service.
const output = z.strictObject({ assessments: z.array(entry).max(60) });
export type ServiceOutput = z.infer<typeof output>;

export const SERVICE_TASK: TaskSpec<ServiceOutput> = {
  feature: 'audit',
  task: 'audit-service',
  tool: {
    name: 'record_assessments',
    description: 'Record, for each finding of this service, what it most likely means and what should be done about it.',
  },
  schema: output,
  maxTokens: 6000,
  effort: 'low',
};

export const MAX_HEADLINE = 110;
const MAX_TEXT = 400;
const MAX_FINDINGS = 12;
const MAX_EVIDENCE = 6;
/** A workspace with more troubled services than this gets the worst ones assessed; the rest keep the rule's wording. */
export const MAX_GROUPS = 200;

export interface ServiceGroup {
  /** The request's id in the batch. */
  customId: string;
  /** Reference used in the prompt ("F1") to finding id. */
  refs: Record<string, string>;
  user: string;
}

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : 'unknown date');
const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const round = (n: number): string => (n >= 10 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ''));

function part<T>(label: string, value: Checked<T>, say: (v: T) => string | null): string[] {
  if (!value.ok) return [`${label}: not read (${flat(value.reason, 120)})`];
  const text = say(value.value);
  return text ? [`${label}: ${text}`] : [];
}

/** What the collectors read about one service, as short lines. Names of variables are left out; values were never read. */
export function serviceFacts(service: ServiceSnapshot, probe: ProbeSummary | undefined): string[] {
  const database = isDatabaseImage(service.repo, service.image);
  const latest = service.latestDeployment;
  return [
    `Project: ${service.projectName}`,
    `Service: ${service.serviceName}`,
    `Environment: ${service.environmentName}`,
    `Runs: ${
      database
        ? 'a stock database image'
        : service.repo
          ? `code from a repository${service.branch ? `, branch ${service.branch}` : ''}${service.rootDirectory ? `, directory ${service.rootDirectory}` : ''}`
          : service.image
            ? 'a container image'
            : 'unknown source'
    }`,
    latest
      ? `Latest deployment: ${latest.status}, created ${day(latest.createdAt)}${latest.stopped ? ', stopped' : ''}`
      : 'Latest deployment: none',
    `Deployments serving now: ${service.activeDeployments.length}`,
    ...part('Deployments in the window', service.deployments, (list) => {
      if (!list.length) return 'none';
      const byStatus = new Map<string, number>();
      for (const d of list) byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
      return `${list.length} (${[...byStatus].map(([status, n]) => `${status} ${n}`).join(', ')})`;
    }),
    ...part('Failed build or deploy step', service.failedStep, (step) => (step ? `${step.step}. ${flat(step.error, 300)}` : null)),
    ...part('Crashes in the window', service.events, (e) =>
      e.crashes || e.restarts ? `${e.crashes} crashes, ${e.restarts} restarts${e.lastCrashAt ? `, last crash ${day(e.lastCrashAt)}` : ''}` : 'none',
    ),
    ...part('Processor and memory', service.resources, (r) =>
      r.samples
        ? `CPU average ${round(r.cpuAvg)} and peak ${round(r.cpuMax)} vCPU${r.cpuLimit ? ` of ${round(r.cpuLimit)}` : ''}; memory average ${round(r.memoryAvgGb)} and peak ${round(r.memoryMaxGb)} GB${r.memoryLimitGb ? ` of ${round(r.memoryLimitGb)}` : ''}`
        : 'no samples',
    ),
    ...part('HTTP requests in the window', service.http, (h) =>
      h.total ? `${h.total}, of which ${h.serverErrors} answered with a server error` : null,
    ),
    ...part('Response time, 95th percentile', service.latencyP95Ms, (ms) => (ms === null ? null : `${Math.round(ms)} ms`)),
    ...(probe
      ? [
          `Health probes in the window: ${probe.total}, ${probe.failed} failed${probe.failingNow ? `, failing now ${probe.failingNow} in a row` : ''}${
            probe.lastStatus ? `, last status ${probe.lastStatus}` : ''
          }${probe.lastError ? `, last error ${flat(probe.lastError, 120)}` : ''}`,
        ]
      : []),
    ...service.volumes.map((v) => `Volume ${v.name}: ${Math.round(v.usedMb)} of ${Math.round(v.sizeMb)} MB used`),
    `Health check path: ${service.healthcheckPath ?? 'none configured'}`,
    ...(service.cronSchedule ? [`Cron schedule: ${service.cronSchedule}`] : []),
    ...(service.sleeps ? ['Sleeps when idle: yes'] : []),
    ...(service.configFile ? [`Config file read by the latest deployment: ${service.configFile}`] : []),
    `Public domains: ${service.serviceDomains.length + service.customDomains.length}`,
    ...part('Public database proxy', service.tcpProxies, (p) => (p.length ? 'yes' : null)),
    ...part('Vulnerability notices from Railway', service.vulnerabilities, (v) =>
      v.length ? `${v.length} (${[...new Set(v.flatMap((n) => n.cveIds))].slice(0, 12).join(', ')})` : null,
    ),
  ];
}

function projectFacts(project: ProjectSnapshot | undefined, name: string): string[] {
  return [
    `Project: ${name}`,
    'Scope: the project as a whole, not one service',
    ...(project
      ? part('Usage against earlier weeks', project.usage, (u) =>
          u.length ? u.map((m) => `${m.measurement} ${round(m.current)} now, ${round(m.priorWeeklyAverage)} weekly before`).join('; ') : null,
        )
      : []),
  ];
}

/** The service's error-log patterns, most frequent first, up to the token cap. */
export function logLines(service: ServiceSnapshot | undefined, tokenCap: number): string {
  if (!service) return 'No logs belong to a project-level finding.';
  const logs = service.errorLogs;
  if (!logs.ok) return `Not read (${flat(logs.reason, 120)}).`;
  if (!logs.value.groups.length) return 'No error-level lines in the window.';
  const lines: string[] = [];
  let used = 0;
  const groups = [...logs.value.groups].sort((a, b) => b.count - a.count);
  for (const group of groups) {
    const line = `${group.count} times, ${day(group.firstAt)} to ${day(group.lastAt)}: ${group.signature}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > tokenCap) break;
    lines.push(line);
    used += cost;
  }
  const left = groups.length - lines.length;
  if (left > 0) lines.push(`(${left} less frequent patterns are not shown)`);
  if (logs.value.truncated) lines.push('(the service logged more error lines than were read; counts are a lower bound)');
  return lines.join('\n');
}

function findingLines(ref: string, f: TrackedFinding): string[] {
  const open = f.isNew ? 'new this week' : `open for ${f.weeksOpen} weeks${f.growing ? ', growing' : ''}`;
  return [
    `${ref} · ${f.severity} · ${CATEGORIES[f.category]} · ${open}`,
    `found: ${flat(f.rule.title, 300)}`,
    ...(f.rule.cause ? [`rule's cause: ${flat(f.rule.cause, 400)}`] : []),
    `rule's recommendation: ${flat(f.rule.recommendation, 400)}`,
    `fix by agent: ${f.rule.actionType === 'fix_via_agent' ? 'allowed' : 'not allowed'}`,
    'evidence:',
    ...(f.evidence.length
      ? f.evidence.slice(0, MAX_EVIDENCE).map((e) => `- ${flat(e.quote, 400)}`)
      : [`- ${flat(f.rule.title, 300)}`]),
    '',
  ];
}

const scopeOf = (f: Pick<Finding, 'scope'>): string =>
  f.scope.serviceId ? serviceScope(f.scope.environmentId ?? '', f.scope.serviceId) : projectScope(f.scope.projectId);

/**
 * One request per service (or project, for project-wide findings) that has at least one
 * finding above informational. A healthy service costs nothing: it is never sent. The
 * findings arrive in the rules' order, so the worst services come first.
 */
export function buildServiceGroups(input: {
  snapshot: WorkspaceSnapshot;
  probes: Map<string, ProbeSummary> | null;
  findings: TrackedFinding[];
  logTokenCap: number;
}): ServiceGroup[] {
  const byScope = new Map<string, TrackedFinding[]>();
  for (const finding of input.findings) {
    const scope = scopeOf(finding);
    byScope.set(scope, [...(byScope.get(scope) ?? []), finding]);
  }
  const services = new Map(input.snapshot.services.map((s) => [serviceScope(s.environmentId, s.serviceId), s]));
  const projects = new Map(input.snapshot.projects.map((p) => [projectScope(p.id), p]));

  const groups: ServiceGroup[] = [];
  for (const [scope, all] of byScope) {
    if (!all.some((f) => f.severity !== 'info')) continue;
    if (groups.length >= MAX_GROUPS) break;
    const findings = all.slice(0, MAX_FINDINGS);
    const service = services.get(scope);
    const refs: Record<string, string> = {};
    const blocks: string[] = [];
    findings.forEach((finding, index) => {
      const ref = `F${index + 1}`;
      refs[ref] = finding.id;
      blocks.push(...findingLines(ref, finding));
    });
    const facts = service
      ? serviceFacts(service, input.probes?.get(scope))
      : projectFacts(projects.get(scope), findings[0]!.scope.projectName);
    groups.push({
      customId: `s${groups.length + 1}`,
      refs,
      user: [
        dataBlock('service', facts.join('\n')),
        dataBlock('findings', blocks.join('\n')),
        dataBlock('logs', logLines(service, input.logTokenCap)),
        `Assess the findings by calling ${SERVICE_TASK.tool.name}.`,
      ].join('\n\n'),
    });
  }
  return groups;
}

export interface CheckedAssessments {
  accepted: { findingId: string; assessment: Assessment }[];
  /** Entries that were not used, and why. The rule's wording stands for those findings. */
  dropped: { ref: string; reason: string }[];
  /** Entries used with the rule's headline, because the drafted one failed a check. */
  reworded: number;
}

/**
 * Decides which drafted entries are used. An entry must name a finding of this request, and
 * rest on a line of that finding's evidence. Its headline must fit, and may state only numbers
 * that the finding states. The model may say a fix is not what is needed; it cannot offer a
 * fix where the rule does not allow one.
 */
export function checkAssessments(
  reply: ServiceOutput,
  refs: Record<string, string>,
  findings: Map<string, Finding>,
  meta: { runId: string; model: string; promptVersion: string },
): CheckedAssessments {
  const result: CheckedAssessments = { accepted: [], dropped: [], reworded: 0 };
  const seen = new Set<string>();
  for (const item of reply.assessments) {
    const ref = item.finding.trim();
    const findingId = refs[ref];
    const finding = findingId ? findings.get(findingId) : undefined;
    if (!findingId || !finding) {
      result.dropped.push({ ref: ref.slice(0, 12), reason: 'not a finding of this service' });
      continue;
    }
    if (seen.has(findingId)) {
      result.dropped.push({ ref, reason: 'assessed twice' });
      continue;
    }
    seen.add(findingId);
    if (!quoteGrounded(item.quote, finding.evidence, finding.rule.title)) {
      result.dropped.push({ ref, reason: 'its quote is not in the evidence' });
      continue;
    }
    const recommendation = cleanText(item.recommendation, MAX_TEXT);
    if (recommendation.length < 8) {
      result.dropped.push({ ref, reason: 'no recommendation' });
      continue;
    }
    const grounds = [finding.rule.title, ...finding.evidence.flatMap((e) => [e.quote, e.source])];
    let headline = cleanLine(item.headline, MAX_HEADLINE);
    if (headline.length < 8 || !numbersGrounded(headline, grounds)) {
      headline = finding.rule.title;
      result.reworded += 1;
    }
    const action: ActionType =
      item.action === 'fix_via_agent' && finding.rule.actionType !== 'fix_via_agent' ? 'investigate' : item.action;
    result.accepted.push({
      findingId,
      assessment: {
        runId: meta.runId,
        headline,
        cause: cleanText(item.cause, MAX_TEXT),
        recommendation,
        action,
        quote: cleanText(item.quote, MAX_TEXT),
        model: meta.model,
        promptVersion: meta.promptVersion,
      },
    });
  }
  return result;
}
