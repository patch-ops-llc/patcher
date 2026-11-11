/**
 * A dry run of the weekly audit against the live Railway workspace.
 *
 *   RAILWAY_API_TOKEN=... npx tsx scripts/audit-dry-run.ts --out /path/outside/the/repo.md
 *
 * It runs the real read-only collectors, one pass of the health probes and the real checks
 * and ranking. It uses no database, posts nothing to Slack, proposes no fixes and starts no
 * agents. The output names real projects and services, so write it outside the repository.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../src/log.js';
import { createProber } from '../src/probes/probe.js';
import type { ProbeOutcome } from '../src/probes/probe.js';
import { createRailwayClient } from '../src/railway/client.js';
import { collectSnapshot } from '../src/railway/collect.js';
import { notChecked } from '../src/railway/types.js';
import type { ProbeSummary } from '../src/weekly/checks.js';
import { evaluate, isDatabase, serviceScope } from '../src/weekly/checks.js';
import { rank } from '../src/weekly/findings.js';
import type { AuditReport, ReportFinding } from '../src/weekly/report.js';
import { TOP_FINDINGS, renderMarkdown, topLine } from '../src/weekly/report.js';
import { subject } from '../src/weekly/types.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const token = process.env.RAILWAY_API_TOKEN;
  const out = flag('--out');
  if (!token) throw new Error('RAILWAY_API_TOKEN is not set');
  if (!out) throw new Error('Pass --out with a path outside the repository');
  const outPath = path.resolve(out);
  if (!path.relative(process.cwd(), outPath).startsWith('..')) {
    throw new Error('The output names real projects. Write it outside the repository.');
  }

  const log = createLogger('warn', { service: 'audit-dry-run' });
  const now = new Date();
  const railway = createRailwayClient({ token, log });
  const { snapshot, unread } = await collectSnapshot(railway, { now, log });

  // The scheduled audit has a week of five-minute probes behind it. A dry run has none, so
  // each public service is probed once here, and one that fails is probed twice more: the
  // check calls a service down after three failures in a row. It cannot show uptime.
  const probes = new Map<string, ProbeSummary>();
  const probe = createProber();
  if (!args.includes('--no-probes')) {
    const targets = snapshot.services.flatMap((service) => {
      const domain = service.customDomains[0]?.domain ?? service.serviceDomains[0];
      if (!domain || service.sleeps || isDatabase(service) || !service.activeDeployments.length) return [];
      const healthPath = service.healthcheckPath?.startsWith('/') ? service.healthcheckPath : null;
      return [{ service, url: `https://${domain}${healthPath ?? '/'}`, failFrom: healthPath ? 400 : 500 }];
    });
    let pending = targets;
    for (let pass = 0; pass < 3 && pending.length; pass += 1) {
      if (pass > 0) await new Promise((resolve) => setTimeout(resolve, 15_000));
      const failed: typeof targets = [];
      let next = 0;
      const batch = pending;
      const worker = async () => {
        while (next < batch.length) {
          const target = batch[next]!;
          next += 1;
          const outcome: ProbeOutcome = await probe({ url: target.url, failFrom: target.failFrom });
          const scope = serviceScope(target.service.environmentId, target.service.serviceId);
          const before = probes.get(scope);
          probes.set(scope, {
            total: (before?.total ?? 0) + 1,
            failed: (before?.failed ?? 0) + (outcome.ok ? 0 : 1),
            failingNow: outcome.ok ? 0 : (before?.failingNow ?? 0) + 1,
            lastStatus: outcome.status,
            lastError: outcome.error,
            certificateExpiresAt: outcome.certificateExpiresAt?.toISOString() ?? null,
            host: outcome.host,
          });
          if (!outcome.ok) failed.push(target);
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      pending = failed;
    }
  }

  const evaluation = evaluate({
    now,
    snapshot,
    probes: probes.size ? probes : null,
    github: notChecked('the GitHub App is not configured'),
    customChecks: [],
  });

  const findings: ReportFinding[] = rank(evaluation.findings).map((draft) => ({
    id: draft.fingerprint,
    subject: subject(draft.scope),
    title: draft.title,
    severity: draft.severity,
    category: draft.category,
    check: draft.check,
    projectName: draft.scope.projectName,
    environmentName: draft.scope.environmentName ?? null,
    serviceName: draft.scope.serviceName ?? null,
    cause: draft.cause,
    recommendation: draft.recommendation,
    actionType: draft.actionType,
    evidence: draft.evidence,
    weeksOpen: 1,
    isNew: true,
    growing: false,
    fix:
      draft.actionType === 'fix_via_agent'
        ? { status: 'unavailable', reason: 'dry run: no registry and no Cursor key, so no fix is proposed' }
        : { status: 'none' },
  }));

  const troubled = new Set(
    evaluation.findings
      .filter((f) => f.severity !== 'info' && f.scope.serviceId)
      .map((f) => serviceScope(f.scope.environmentId ?? '', f.scope.serviceId ?? '')),
  );
  const configured = { configured: true, missing: [] };
  const report: AuditReport = {
    version: 1,
    generatedAt: now.toISOString(),
    windowStart: snapshot.windowStart,
    windowDays: snapshot.windowDays,
    counts: {
      projects: snapshot.projects.length,
      services: snapshot.services.length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
      healthy: snapshot.services.filter((s) => !troubled.has(serviceScope(s.environmentId, s.serviceId))).length,
      muted: 0,
      accepted: 0,
      resolved: 0,
    },
    findings,
    top: findings.slice(0, TOP_FINDINGS).map((f) => ({ findingId: f.id, line: topLine(f), recommendationId: null })),
    inventory: { initial: true, changes: [] },
    coverage: evaluation.coverage,
    unread,
    integrations: {
      railway: configured,
      github: { configured: false, missing: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] },
      cursor: { configured: false, missing: ['CURSOR_API_KEY'] },
    },
    railwayRequests: snapshot.requests,
  };

  const configFiles = snapshot.services
    .filter((s) => s.configFile)
    .map((s) => `- ${s.projectName} / ${s.serviceName} (${s.environmentName}): \`${s.configFile ?? ''}\`${s.repo ? `, from ${s.repo}` : ''}`)
    .sort();

  const body = [
    renderMarkdown(report),
    '## Services whose latest deployment read a config-as-code file',
    '',
    ...(configFiles.length ? configFiles : ['None.']),
    '',
    '## Run',
    '',
    `- Railway requests: ${snapshot.requests}`,
    `- Probes: ${probes.size} services probed (once; up to three times when failing)`,
    `- Environments read: ${snapshot.projects.reduce((n, p) => n + p.environments.length, 0) - unread.length}, unread: ${unread.length}`,
    '',
  ].join('\n');
  await writeFile(outPath, body);
  process.stdout.write(
    `${report.counts.projects} projects, ${report.counts.services} services, ${findings.length} findings, ${snapshot.requests} Railway requests\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
