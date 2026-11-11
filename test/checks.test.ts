import { describe, expect, it } from 'vitest';
import type { ServiceSnapshot } from '../src/railway/types.js';
import { checked, notChecked } from '../src/railway/types.js';
import type { CheckContext, ProbeSummary, RepoFacts } from '../src/weekly/checks.js';
import { evaluate, serviceScope } from '../src/weekly/checks.js';
import { isErrorLine, isFragment, logSignature, redact } from '../src/weekly/redact.js';
import type { FindingDraft } from '../src/weekly/types.js';
import { fingerprint, subject } from '../src/weekly/types.js';
import { ACME, ACME_PROD, ACME_STAGING, API, NOW, databaseService, service, workspace } from './fixtures/railway.js';

function context(services: ServiceSnapshot[], overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    now: NOW,
    snapshot: workspace(services),
    probes: null,
    github: notChecked('the GitHub App is not configured'),
    customChecks: [],
    ...overrides,
  };
}

const findingsOf = (services: ServiceSnapshot[], overrides: Partial<CheckContext> = {}): FindingDraft[] =>
  evaluate(context(services, overrides)).findings;

const only = (findings: FindingDraft[], check: string): FindingDraft => {
  const found = findings.filter((f) => f.check === check);
  expect(found.map((f) => f.title)).toHaveLength(1);
  return found[0]!;
};

const probe = (overrides: Partial<ProbeSummary> = {}): ProbeSummary => ({
  total: 2000,
  failed: 0,
  failingNow: 0,
  lastStatus: 200,
  lastError: null,
  certificateExpiresAt: '2026-06-01T00:00:00.000Z',
  host: 'acme-api.example.test',
  ...overrides,
});

const probes = (summary: ProbeSummary, s: ServiceSnapshot = service()) => new Map([[serviceScope(s.environmentId, s.serviceId), summary]]);

describe('a healthy workspace', () => {
  it('produces no findings', () => {
    expect(findingsOf([service(), databaseService()], { probes: probes(probe()) })).toEqual([]);
  });
});

describe('outages', () => {
  it('reports a crashed latest deployment as critical, with the failed step as the cause', () => {
    const crashed = service({
      latestDeployment: { id: 'd-2', status: 'CRASHED', createdAt: '2026-03-08T10:00:00Z', statusUpdatedAt: '2026-03-08T10:05:00Z', stopped: false, instanceStatuses: ['CRASHED'] },
      activeDeployments: [],
    });
    const finding = only(findingsOf([crashed]), 'outage.deployment');
    expect(finding).toMatchObject({ severity: 'critical', category: 'outage', actionType: 'fix_via_agent', repo: 'example-org/acme-portal', branch: 'main' });
    expect(finding.title).toBe('crashed on 2026-03-08 and is not running');

    const failed = service({
      latestDeployment: { id: 'd-2', status: 'FAILED', createdAt: '2026-03-08T10:00:00Z', statusUpdatedAt: '2026-03-08T10:05:00Z', stopped: false, instanceStatuses: [] },
      activeDeployments: [],
      failedStep: checked({ step: 'BUILD_IMAGE', error: 'missing script: build' }),
    });
    const down = only(findingsOf([failed]), 'outage.deployment');
    expect(down.title).toBe('has not deployed since a failure on 2026-03-08; nothing is running');
    expect(down.evidence.map((e) => e.quote)).toContain('BUILD_IMAGE: missing script: build');
  });

  it('does not call a failed deploy an outage while an older deployment still serves', () => {
    const failedButLive = service({
      latestDeployment: { id: 'd-2', status: 'FAILED', createdAt: '2026-03-08T10:00:00Z', statusUpdatedAt: '2026-03-08T10:05:00Z', stopped: false, instanceStatuses: [] },
      deployments: checked([
        { id: 'd-2', status: 'FAILED', createdAt: '2026-03-08T10:00:00Z' },
        { id: 'd-1', status: 'SUCCESS', createdAt: '2026-03-05T10:00:00Z' },
      ]),
    });
    const found = findingsOf([failedButLive]);
    expect(found.filter((f) => f.check === 'outage.deployment')).toEqual([]);
    expect(only(found, 'deploy.failed_builds')).toMatchObject({ severity: 'warning', category: 'deploy' });
  });

  it('counts crashes during the week: warning, then critical from three', () => {
    const twice = only(findingsOf([service({ events: checked({ crashes: 2, restarts: 1, lastCrashAt: '2026-03-08T01:00:00Z' }) })]), 'outage.crashes');
    expect(twice).toMatchObject({ severity: 'warning', title: 'crashed 2 times in the last 7 days', metric: 2 });
    expect(twice.evidence[0]!.quote).toBe('2 crashes and 1 restart since 2026-03-02; last crash 2026-03-08 01:00 UTC.');
    const often = only(findingsOf([service({ events: checked({ crashes: 6, restarts: 0, lastCrashAt: '2026-03-08T01:00:00Z' }) })]), 'outage.crashes');
    expect(often.severity).toBe('critical');
  });

  it('reports a service that fails its probes now as down, and a week of misses as low uptime', () => {
    const down = only(findingsOf([service()], { probes: probes(probe({ failed: 40, failingNow: 12, lastStatus: 503 })) }), 'outage.probe');
    expect(down).toMatchObject({ severity: 'critical', title: 'is not answering health probes (HTTP 503)' });
    const flaky = only(findingsOf([service()], { probes: probes(probe({ failed: 60 })) }), 'outage.probe');
    expect(flaky).toMatchObject({ severity: 'warning', title: 'was up 97.0% of the last 7 days' });
    // One failed probe out of two thousand is neither.
    expect(findingsOf([service()], { probes: probes(probe({ failed: 1 })) })).toEqual([]);
  });

  it('does not probe databases or sleeping services, and says so rather than calling them healthy', () => {
    const sleeping = service({ sleeps: true });
    const { findings, coverage } = evaluate(context([sleeping, databaseService({ serviceDomains: ['db.example.test'] })], { probes: new Map() }));
    expect(findings.filter((f) => f.check === 'outage.probe')).toEqual([]);
    expect(coverage.find((c) => c.key === 'outage.probe')).toMatchObject({
      checked: 0,
      notApplicable: 1,
      notChecked: 1,
      reasons: { 'The service sleeps when idle, and a probe would keep it awake': 1 },
    });
  });

  it('reports a cron service that missed its last run', () => {
    const cron = service({ cronSchedule: '0 * * * *', serviceDomains: [], lastCronRunAt: checked('2026-03-09T09:00:05Z') });
    expect(only(findingsOf([cron]), 'outage.cron')).toMatchObject({ severity: 'warning', title: 'did not run on schedule (0 * * * *)' });
    const onTime = service({ cronSchedule: '0 * * * *', serviceDomains: [], lastCronRunAt: checked('2026-03-09T13:00:04Z') });
    expect(findingsOf([onTime]).filter((f) => f.check === 'outage.cron')).toEqual([]);
  });
});

describe('bugs', () => {
  it('reports repeated error signatures, most frequent first, three at most', () => {
    const group = (signature: string, count: number) => ({ signature, count, firstAt: '2026-03-03T00:00:00Z', lastAt: '2026-03-08T00:00:00Z' });
    const noisy = service({
      errorLogs: checked({
        groups: [group('TypeError: x is undefined', 120), group('Timeout calling <url>', 30), group('Bad input', 9), group('Rare', 6), group('Once', 1)],
        lines: 166,
        truncated: false,
        since: null,
      }),
    });
    const found = findingsOf([noisy]).filter((f) => f.check === 'bugs.error_logs');
    expect(found.map((f) => [f.severity, f.title])).toEqual([
      ['warning', 'logged the same error 120 times: TypeError: x is undefined'],
      ['info', 'logged the same error 30 times: Timeout calling <url>'],
      ['info', 'logged the same error 9 times: Bad input'],
    ]);
    expect(found[0]).toMatchObject({ actionType: 'fix_via_agent', metric: 120 });
    // Each signature is its own finding, so one can be fixed or muted without the others.
    expect(new Set(found.map((f) => f.fingerprint)).size).toBe(3);
  });

  it('grades the 5xx rate and ignores a service with too little traffic to judge', () => {
    const rate = (total: number, errors: number) =>
      findingsOf([service({ http: checked({ total, serverErrors: errors, byStatus: { '200': total - errors, '500': errors } }) })]).filter(
        (f) => f.check === 'bugs.http_5xx',
      );
    expect(rate(1000, 5)).toEqual([]);
    expect(rate(1000, 20)[0]).toMatchObject({ severity: 'info', title: 'answered 2% of requests with a server error' });
    expect(rate(1000, 80)[0]!.severity).toBe('warning');
    expect(rate(1000, 400)[0]!.severity).toBe('critical');
    expect(rate(20, 10)).toEqual([]);
  });
});

describe('capacity', () => {
  it('reports memory and CPU near their limits, a full volume and slow responses', () => {
    const strained = service({
      resources: checked({ cpuAvg: 7, cpuMax: 8, cpuLimit: 8, memoryAvgGb: 6, memoryMaxGb: 7.6, memoryLimitGb: 8, networkTxGb: 3, samples: 168 }),
      latencyP95Ms: checked(4200),
      volumes: [{ id: 'v-9', name: 'uploads', mountPath: '/data', sizeMb: 1000, usedMb: 930, state: 'READY' }],
    });
    const found = findingsOf([strained]);
    expect(only(found, 'capacity.memory').title).toBe('used 95% of its memory limit');
    expect(only(found, 'capacity.cpu').title).toBe('averaged 88% of its CPU limit');
    expect(only(found, 'capacity.volume')).toMatchObject({ severity: 'critical', title: 'volume is 93% full' });
    expect(only(found, 'capacity.latency').title).toBe('is slow: 95% of requests take up to 4.2 s');
  });

  it('says what it cannot see: out-of-memory kills and Postgres internals', () => {
    const { coverage, findings } = evaluate(context([service(), databaseService()]));
    expect(findings).toEqual([]);
    expect(coverage.find((c) => c.key === 'capacity.oom')).toMatchObject({ checked: 0, notChecked: 2 });
    expect(coverage.find((c) => c.key === 'capacity.postgres')).toMatchObject({ checked: 0, notChecked: 1, notApplicable: 1 });
  });
});

describe('deploy hygiene', () => {
  const facts = (overrides: Partial<RepoFacts> = {}): CheckContext['github'] =>
    checked(new Map([[serviceScope(ACME_PROD, API), checked({ defaultBranch: 'main', behindBy: checked(0), criticalAlerts: checked(0), ...overrides })]]));

  it('reports production behind the default branch only when GitHub was asked', () => {
    expect(only(findingsOf([service()], { github: facts({ behindBy: checked(14) }) }), 'deploy.behind_default')).toMatchObject({
      severity: 'warning',
      title: 'is 14 commits behind main',
    });
    const { findings, coverage } = evaluate(context([service()]));
    expect(findings).toEqual([]);
    expect(coverage.find((c) => c.key === 'deploy.behind_default')).toMatchObject({
      checked: 0,
      notChecked: 1,
      reasons: { 'the GitHub App is not configured': 1 },
    });
  });

  it('compares staging with production by commit and by variable names, never values', () => {
    const production = service();
    const staging = service({
      environmentId: ACME_STAGING,
      environmentName: 'staging',
      instanceId: 'i-api-staging',
      commitHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      variableNames: checked(['DATABASE_URL', 'FEATURE_FLAG_NEW_CHECKOUT', 'RAILWAY_PUBLIC_DOMAIN']),
    });
    const found = findingsOf([production, staging]);
    expect(only(found, 'deploy.drift')).toMatchObject({ severity: 'info', title: 'runs a different commit than staging' });
    const drift = only(found, 'deploy.variable_drift');
    expect(drift.title).toBe('has 2 variables set in only one of production and staging');
    const quotes = drift.evidence.map((e) => e.quote).join(' ');
    expect(quotes).toContain('STRIPE_SECRET_KEY');
    expect(quotes).toContain('FEATURE_FLAG_NEW_CHECKOUT');
    // Railway's own variables differ by design and are not drift.
    expect(quotes).not.toContain('RAILWAY_PUBLIC_DOMAIN');
  });

  it('reports a missing health check, a deployment waiting for approval and a config-as-code file', () => {
    const found = findingsOf([
      service({
        healthcheckPath: null,
        configFile: '/railway.json',
        latestDeployment: { id: 'd-3', status: 'NEEDS_APPROVAL', createdAt: '2026-02-20T10:00:00Z', statusUpdatedAt: null, stopped: false, instanceStatuses: [] },
      }),
    ]);
    expect(only(found, 'deploy.healthcheck').severity).toBe('info');
    expect(only(found, 'deploy.needs_approval')).toMatchObject({ severity: 'warning', title: 'has a deployment waiting for approval since 2026-02-20' });
    const config = only(found, 'deploy.config_as_code');
    expect(config).toMatchObject({ severity: 'warning', actionType: 'fix_via_agent' });
    expect(config.title).toBe('still reads /railway.json, which Railway stops reading on 2026-12-01');
    expect(config.evidence.some((e) => e.url === 'https://docs.railway.com/config-as-code')).toBe(true);
  });
});

describe('security', () => {
  it('reports dependency alerts, exposed databases, certificates and database vulnerability notices', () => {
    const web = service({
      customDomains: [
        { domain: 'app.acme.example', certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID', certificateExpiresAt: '2026-03-11T00:00:00Z' },
        { domain: 'old.acme.example', certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUE_FAILED', certificateExpiresAt: null },
      ],
    });
    const db = databaseService({
      tcpProxies: checked([{ domain: 'proxy.example.test', proxyPort: 12345, applicationPort: 5432 }]),
      vulnerabilities: checked([
        { object: 'PostgresVuln', cveIds: ['CVE-2099-0001'], severity: 'high', at: '2026-02-01T00:00:00Z' },
        { object: 'PostgresVuln', cveIds: ['CVE-2099-0003'], severity: 'high', at: '2026-02-01T00:00:00Z' },
      ]),
    });
    const github: CheckContext['github'] = checked(
      new Map([[serviceScope(ACME_PROD, API), checked({ defaultBranch: 'main', behindBy: checked(0), criticalAlerts: checked(3) })]]),
    );
    const found = findingsOf([web, db], { github });
    expect(only(found, 'security.dependency_alerts')).toMatchObject({ severity: 'warning', title: 'has 3 open critical dependency alerts' });
    expect(only(found, 'security.public_database')).toMatchObject({ severity: 'info', actionType: 'investigate' });
    expect(only(found, 'security.database_vulnerability').title).toBe('has 2 unpatched vulnerability notices from Railway (CVE-2099-0001, CVE-2099-0003)');
    const certs = found.filter((f) => f.check === 'security.certificate');
    expect(certs.map((f) => [f.severity, f.title]).sort()).toEqual([
      ['critical', 'certificate for app.acme.example expires in 1 day'],
      ['warning', 'certificate for old.acme.example is not valid (issue failed)'],
    ]);
  });
});

describe('cost', () => {
  it('reports a service that did nothing all week, but not a new one or a database', () => {
    const idle = service({
      http: checked({ total: 0, serverErrors: 0, byStatus: {} }),
      resources: checked({ cpuAvg: 0.0001, cpuMax: 0.001, cpuLimit: 8, memoryAvgGb: 0.1, memoryMaxGb: 0.1, memoryLimitGb: 8, networkTxGb: 0, samples: 168 }),
    });
    expect(only(findingsOf([idle]), 'cost.idle')).toMatchObject({ severity: 'info', category: 'cost' });
    expect(findingsOf([{ ...idle, createdAt: '2026-03-07T00:00:00Z' }])).toEqual([]);
    expect(findingsOf([databaseService({ resources: idle.resources })])).toEqual([]);
  });

  it('reports a project whose usage jumped against the weeks before', () => {
    const snapshot = workspace([service()]);
    snapshot.projects[0]!.usage = checked([
      // vCPU-minutes and GB-minutes for a week, and the weekly average of the three weeks before.
      { measurement: 'CPU_USAGE', current: 40_000, priorWeeklyAverage: 8_000 },
      { measurement: 'MEMORY_USAGE_GB', current: 80_000, priorWeeklyAverage: 20_000 },
    ]);
    const { findings } = evaluate({ ...context([]), snapshot });
    const growth = only(findings, 'cost.usage');
    expect(growth).toMatchObject({ severity: 'warning', category: 'cost' });
    expect(growth.scope).toMatchObject({ projectId: ACME, projectName: 'Acme Portal' });
    expect(growth.scope.serviceId).toBeUndefined();
    expect(growth.title).toMatch(/^cost about \$\d+ this week, up from \$\d+ a week$/);
  });
});

describe('project-specific checks', () => {
  it('reports a failing check against its project', () => {
    const { findings } = evaluate(
      context([service()], {
        customChecks: [
          { checkId: 'c-1', name: 'Sync is current', host: 'status.acme.example', projectId: ACME, projectName: 'Acme Portal', summary: probe({ total: 288, failed: 30, failingNow: 30, lastStatus: 500, host: 'status.acme.example' }) },
          { checkId: 'c-2', name: 'Queue is short', host: 'status.acme.example', projectId: ACME, projectName: 'Acme Portal', summary: probe({ total: 288 }) },
        ],
      }),
    );
    expect(only(findings, 'custom.check')).toMatchObject({ severity: 'critical', title: 'check "Sync is current" is failing (HTTP 500)', category: 'custom' });
  });
});

describe('coverage and fingerprints', () => {
  it('counts a collector failure as not checked, never as healthy', () => {
    const unknown = service({ resources: notChecked('Railway returned HTTP 502'), errorLogs: notChecked('Railway returned HTTP 502') });
    const { findings, coverage, checkedScopes } = evaluate(context([unknown]));
    expect(findings).toEqual([]);
    expect(coverage.find((c) => c.key === 'capacity.memory')).toMatchObject({ checked: 0, notChecked: 1, reasons: { 'Railway returned HTTP 502': 1 } });
    const scope = serviceScope(ACME_PROD, API);
    expect(checkedScopes.has(`capacity.memory|${scope}`)).toBe(false);
    expect(checkedScopes.has(`bugs.error_logs|${scope}`)).toBe(false);
    expect(checkedScopes.has(`outage.crashes|${scope}`)).toBe(true);
  });

  it('gives the same finding the same fingerprint every week, and a different one elsewhere', () => {
    const run = (overrides: Partial<ServiceSnapshot>, crashes: number) =>
      only(findingsOf([service({ ...overrides, events: checked({ crashes, restarts: 0, lastCrashAt: null }) })]), 'outage.crashes').fingerprint;
    // Renaming the service or a different count does not change which finding it is.
    expect(run({}, 2)).toBe(run({ serviceName: 'api-v2', projectName: 'Acme Portal 2' }, 9));
    expect(run({}, 2)).not.toBe(run({ environmentId: ACME_STAGING }, 2));
    expect(run({}, 2)).not.toBe(run({ serviceId: 's-other' }, 2));
    const scope = { projectId: ACME, projectName: 'Acme Portal', environmentId: ACME_PROD, serviceId: API };
    expect(fingerprint(scope, 'outage', 'crashes')).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(scope, 'outage', 'crashes')).not.toBe(fingerprint(scope, 'bugs', 'crashes'));
  });

  it('names a finding by project, service and environment, leaving out what is obvious', () => {
    const base = { projectId: ACME, projectName: 'Acme Portal' };
    expect(subject({ ...base, serviceName: 'api', environmentName: 'production' })).toBe('Acme Portal api');
    expect(subject({ ...base, serviceName: 'api', environmentName: 'staging' })).toBe('Acme Portal api (staging)');
    expect(subject({ ...base, serviceName: 'acme portal', environmentName: 'production' })).toBe('Acme Portal');
    expect(subject(base)).toBe('Acme Portal');
  });
});

describe('redaction', () => {
  it('removes credentials, connection strings, tokens and email addresses', () => {
    const cases: [string, string][] = [
      ['connect failed postgres://app:hunter2@db.internal:5432/app', 'connect failed [connection string]'],
      ['redis://default:p4ss@cache.example.test:6379', '[connection string]'],
      ['Authorization: Bearer abcdef0123456789abcdef', 'Authorization: [redacted] [token]'],
      ['api_key=sk_live_1234567890abcdef rejected', 'api_key=[redacted] rejected'],
      ['{"password":"correct horse","user":"ada"}', '{"password":[redacted],"user":"ada"}'],
      ['slack token xoxb-1234567890-abcdefghijkl was revoked', 'slack token [token] was revoked'],
      ['mail to grace.hopper@example.com bounced', 'mail to [email] bounced'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[private key]'],
      ['session 0123456789abcdef0123456789abcdef0123 expired', 'session [hex] expired'],
    ];
    for (const [input, expected] of cases) expect(redact(input), input).toBe(expected);
    expect(redact('GET /orders returned 500 in 31 ms')).toBe('GET /orders returned 500 in 31 ms');
  });

  it('reduces a log line to its shape, so the same error groups and no value survives', () => {
    const a = logSignature('2026-03-08T10:00:00.123Z ERROR Order 4821 for customer "Ada Lovelace" failed at https://api.example.test/orders/4821 (10.0.0.12:5432)');
    const b = logSignature('2026-03-09T11:30:00.456Z ERROR Order 77 for customer "Grace Hopper" failed at https://api.example.test/orders/77 (10.0.0.13:5432)');
    expect(a).toBe('Order <n> for customer <str> failed at <url> (<ip>)');
    expect(b).toBe(a);
    expect(logSignature('{"level":"error","msg":"payment 9f3b2c1a-1111-4222-8333-444455556666 declined","user":"ada@example.com"}')).toBe(
      'payment <id> declined',
    );
    expect(logSignature('\u001b[31mError: boom\u001b[0m\n    at main (/app/index.js:1:1)')).toBe('boom');
    // A customer or account number keeps no part of itself, so two customers are one signature.
    expect(logSignature('contact cust_number=ACM20417: rejected')).toBe(logSignature('contact cust_number=ZZT99120: rejected'));
    expect(logSignature('contact cust_number=ACM20417: rejected')).toBe('contact cust_number=<id>: rejected');
    expect(logSignature('account 77AB1234 not found')).toBe('account <id> not found');
    expect(logSignature('HTTP 500 from api v2 using sha256')).toBe('HTTP <n> from api v<n> using sha<n>');
    expect(logSignature('x'.repeat(500)).length).toBeLessThanOrEqual(160);
    expect(logSignature('Sync failed on Mon Mar 9 2026 10:00:00')).toBe(logSignature('Sync failed on Tue Mar 10 2026 11:30:00'));
  });

  it('tells an error from what only arrived on stderr', () => {
    const errors = [
      'TypeError: cannot read properties of undefined',
      '2026-03-08 12:00:01.000 UTC [27] ERROR:  relation "orders" does not exist',
      '2026-03-08 12:00:01.000 UTC [27] FATAL:  password authentication failed',
      '{"level":"error","msg":"boom"}',
      '{"level":50,"msg":"boom"}',
      'Unhandled rejection',
      '[import] [orders] failed: connection reset by peer',
      '║ ERROR order_export_failed ║',
    ];
    const notErrors = [
      '2026-03-08 12:00:00.000 UTC [27] LOG:  checkpoint starting: time',
      '2026-03-08 12:00:00.000 UTC [27] STATEMENT:  select 1',
      '1:M 08 Mar 2026 12:00:00.000 * Background saving started by pid 42',
      '[warn] slow query',
      'warning: something is odd',
      'npm warn deprecated left-pad@1.0.0',
      '(node:1) DeprecationWarning: Buffer() is deprecated',
      '{"level":"info","msg":"listening"}',
      '{"level":30,"msg":"listening"}',
      '[PID: 12] [scheduler] [WARN] missed execution at Mon Mar 09 2026',
      '║ ⚠ WARN cache_rebuilt_without_index ║',
    ];
    for (const line of errors) expect(isErrorLine(line), line).toBe(true);
    for (const line of notErrors) expect(isErrorLine(line), line).toBe(false);
  });

  it('does not treat the tail of a multi-line error as an error of its own', () => {
    for (const fragment of ['at handler (/app/src/orders.js:<n>)', '}', '),(', '$<n>, $<n>, $<n>,', '<str>, <str>, <str>', '++++++++++', 'subCategory: <str>,', 'Read more: <url>', '║ ║', 'insert into orders (id, name,', '║ tmp_rows) ║', '║ Restart the service to clear it. ║']) {
      expect(isFragment(fragment), fragment).toBe(true);
    }
    for (const real of ['TypeError: x is undefined', 'Payment failed for [email]', 'relation <str> does not exist at character <n>', 'SyntaxError: Unexpected token } in JSON at position <n>', '║ ✘ ALARM nightly_export_skipped ║']) {
      expect(isFragment(real), real).toBe(false);
    }
  });
});
