import type { Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { markError, markOk } from '../integrations/status.js';
import { collectSnapshot } from '../railway/collect.js';
import { lastInventorySync, listInstances, syncInventory } from '../railway/inventory.js';
import { isDatabaseImage } from '../railway/types.js';
import { listEnabledChecks } from '../registry/registry.js';
import type { CustomCheckResult, ProbeSummary } from '../weekly/checks.js';
import type { WorkerDeps } from '../worker/deps.js';
import type { ProbeOutcome, ProbeTarget } from './probe.js';

const HOUR_MS = 60 * 60 * 1000;
const INVENTORY_MAX_AGE_MS = 24 * HOUR_MS;
const RETENTION_DAYS = 35;
const CONCURRENCY = 8;

export interface ServiceProbeTarget extends ProbeTarget {
  serviceId: string;
  environmentId: string;
}

/** One address per service that answers HTTP: its first custom domain, else its Railway domain. */
export async function serviceProbeTargets(db: Queryable): Promise<ServiceProbeTarget[]> {
  const targets: ServiceProbeTarget[] = [];
  for (const instance of await listInstances(db)) {
    const domain = instance.details.domains[0];
    // Not probed: databases (their domain does not speak HTTP) and services that sleep when
    // idle (a probe every five minutes would keep them awake and billed).
    if (!domain || instance.details.sleeps || isDatabaseImage(instance.details.repo, instance.details.image)) continue;
    const path = instance.details.healthcheckPath;
    targets.push({
      serviceId: instance.serviceId,
      environmentId: instance.environmentId,
      url: `https://${domain}${path?.startsWith('/') ? path : '/'}`,
      // With a health path, anything but success is a failure. Without one the probe asks
      // for `/`, where a login redirect or a 404 still means the service answers.
      failFrom: path ? 400 : 500,
    });
  }
  return targets;
}

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

/**
 * Between audits the inventory is refreshed once a day, so a service added on Tuesday is
 * probed from Tuesday. It costs one Railway request per environment.
 */
export async function refreshInventoryIfStale(deps: WorkerDeps, now: Date): Promise<boolean> {
  const railway = deps.integrations.railway;
  if (!railway) return false;
  const last = await lastInventorySync(deps.pool);
  if (last && now.getTime() - last.getTime() < INVENTORY_MAX_AGE_MS) return false;
  try {
    const { snapshot, unread } = await collectSnapshot(railway, { now, log: deps.log, inventoryOnly: true });
    await withTx(deps.pool, (tx) => syncInventory(tx, snapshot, unread, now));
    await markOk(deps.pool, 'railway');
    return true;
  } catch (err) {
    await markError(deps.pool, 'railway', err instanceof Error ? err.message : String(err));
    deps.log.warn('inventory refresh failed', { err });
    return false;
  }
}

/** The `probe.health` schedule: one GET per public service and per project-specific check. */
export async function runProbes(deps: WorkerDeps, now: Date = new Date()): Promise<string> {
  await refreshInventoryIfStale(deps, now);
  const [services, checks] = await Promise.all([serviceProbeTargets(deps.pool), listEnabledChecks(deps.pool)]);
  if (!services.length && !checks.length) {
    return deps.integrations.railway
      ? 'Nothing to probe: no service has a public domain.'
      : 'Nothing to probe: Railway is not configured, so there is no inventory.';
  }

  let failed = 0;
  const save = async (ids: { serviceId?: string; environmentId?: string; checkId?: string }, outcome: ProbeOutcome) => {
    if (!outcome.ok) failed += 1;
    await deps.pool.query(
      `INSERT INTO probe_results (service_id, environment_id, check_id, host, at, ok, status, latency_ms, error, cert_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ids.serviceId ?? null,
        ids.serviceId ? (ids.environmentId ?? null) : null,
        ids.checkId ?? null,
        outcome.host,
        now,
        outcome.ok,
        outcome.status,
        outcome.latencyMs,
        outcome.error?.slice(0, 200) ?? null,
        outcome.certificateExpiresAt,
      ],
    );
  };

  await inBatches(services, CONCURRENCY, async (target) => {
    await save({ serviceId: target.serviceId, environmentId: target.environmentId }, await deps.integrations.probe(target));
  });
  await inBatches(checks, CONCURRENCY, async (check) => {
    const outcome = await deps.integrations.probe({
      url: check.url,
      expectStatus: check.expectStatus,
      expectJson: check.expectJson ?? undefined,
    });
    await save({ checkId: check.id }, outcome);
  });

  await deps.pool.query(`DELETE FROM probe_results WHERE at < $1::timestamptz - make_interval(days => $2)`, [now, RETENTION_DAYS]);
  return `${services.length + checks.length} probed, ${failed} failed`;
}

interface SummaryRow {
  service_id: string | null;
  environment_id: string | null;
  check_id: string | null;
  total: string;
  failed: string;
  failing_now: string;
  last_status: number | null;
  last_error: string | null;
  host: string;
  cert: Date | null;
}

const summaryOf = (row: SummaryRow): ProbeSummary => ({
  total: Number(row.total),
  failed: Number(row.failed),
  failingNow: Number(row.failing_now),
  lastStatus: row.last_status,
  lastError: row.last_error,
  certificateExpiresAt: row.cert ? row.cert.toISOString() : null,
  host: row.host,
});

async function summaries(db: Queryable, since: Date, column: 'service' | 'check'): Promise<SummaryRow[]> {
  const group = column === 'service' ? 'service_id, environment_id' : 'check_id';
  const { rows } = await db.query<SummaryRow>(
    `WITH w AS (
       SELECT *, max(at) FILTER (WHERE ok) OVER (PARTITION BY ${group}) AS last_ok_at
         FROM probe_results
        WHERE ${column === 'service' ? 'service_id' : 'check_id'} IS NOT NULL AND at >= $1
     )
     SELECT ${column === 'service' ? 'service_id, environment_id, NULL::uuid AS check_id' : 'NULL::text AS service_id, NULL::text AS environment_id, check_id'},
            count(*) AS total,
            count(*) FILTER (WHERE NOT ok) AS failed,
            count(*) FILTER (WHERE NOT ok AND (last_ok_at IS NULL OR at > last_ok_at)) AS failing_now,
            (array_agg(status ORDER BY at DESC))[1] AS last_status,
            (array_agg(error ORDER BY at DESC))[1] AS last_error,
            (array_agg(host ORDER BY at DESC))[1] AS host,
            (array_agg(cert_expires_at ORDER BY at DESC))[1] AS cert
       FROM w GROUP BY ${group}`,
    [since],
  );
  return rows;
}

/** Probe history per service since `since`, keyed `environmentId:serviceId`. Null if no probe ever ran. */
export async function probeSummaries(db: Queryable, since: Date): Promise<Map<string, ProbeSummary> | null> {
  const any = await db.query('SELECT 1 FROM probe_results LIMIT 1');
  if (!any.rowCount) return null;
  const rows = await summaries(db, since, 'service');
  return new Map(rows.map((r) => [`${r.environment_id ?? ''}:${r.service_id ?? ''}`, summaryOf(r)]));
}

/** Each enabled project check with its probe history, attached to the project's Railway project when it has one. */
export async function customCheckResults(db: Queryable, since: Date): Promise<CustomCheckResult[]> {
  const checks = await listEnabledChecks(db);
  if (!checks.length) return [];
  const rows = await summaries(db, since, 'check');
  const byCheck = new Map(rows.map((r) => [r.check_id, summaryOf(r)]));
  const links = await db.query<{ project_id: string; external_id: string }>(
    `SELECT project_id, external_id FROM project_links WHERE kind = 'railway_project' ORDER BY id`,
  );
  const railwayProject = new Map<string, string>();
  for (const link of links.rows) if (!railwayProject.has(link.project_id)) railwayProject.set(link.project_id, link.external_id);
  return checks.map((check) => {
    let host = '';
    try {
      host = new URL(check.url).hostname;
    } catch {
      // The address was validated when it was saved; an unreadable one just has no host to show.
    }
    return {
      checkId: check.id,
      name: check.name,
      host,
      // Findings are scoped to a Railway project; a registry project without one uses its own id.
      projectId: railwayProject.get(check.projectId) ?? `registry:${check.projectId}`,
      projectName: check.projectName,
      summary: byCheck.get(check.id) ?? null,
    };
  });
}
