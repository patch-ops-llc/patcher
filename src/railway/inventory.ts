import type { Queryable } from '../db/pool.js';
import type { UnreadEnvironment } from './collect.js';
import type { WorkspaceSnapshot } from './types.js';

export type InventoryKind = 'project' | 'environment' | 'service' | 'instance';

export interface InventoryChange {
  change: 'added' | 'removed' | 'renamed';
  kind: Exclude<InventoryKind, 'instance'>;
  name: string;
  previousName?: string;
  projectName: string;
}

/** What is kept for a service in an environment, for the probes and the registry screen. */
export interface InstanceDetails {
  domains: string[];
  healthcheckPath: string | null;
  repo: string | null;
  image: string | null;
  /** True when the service sleeps while idle; a probe would wake it and keep it running. */
  sleeps?: boolean;
  projectName: string;
  environmentName: string;
}

interface Item {
  kind: InventoryKind;
  externalId: string;
  projectId: string;
  environmentId: string | null;
  serviceId: string | null;
  name: string;
  details: Record<string, unknown>;
  projectName: string;
}

function itemsOf(snapshot: WorkspaceSnapshot): Item[] {
  const items: Item[] = [];
  for (const project of snapshot.projects) {
    items.push({ kind: 'project', externalId: project.id, projectId: project.id, environmentId: null, serviceId: null, name: project.name, details: {}, projectName: project.name });
    for (const environment of project.environments) {
      items.push({ kind: 'environment', externalId: environment.id, projectId: project.id, environmentId: environment.id, serviceId: null, name: environment.name, details: {}, projectName: project.name });
    }
    for (const service of project.services) {
      items.push({ kind: 'service', externalId: service.id, projectId: project.id, environmentId: null, serviceId: service.id, name: service.name, details: {}, projectName: project.name });
    }
  }
  for (const service of snapshot.services) {
    const details: InstanceDetails = {
      // Custom domains first: that is the address people use.
      domains: [...service.customDomains.map((d) => d.domain), ...service.serviceDomains],
      healthcheckPath: service.healthcheckPath,
      repo: service.repo,
      image: service.image,
      sleeps: service.sleeps,
      projectName: service.projectName,
      environmentName: service.environmentName,
    };
    items.push({
      kind: 'instance',
      externalId: service.instanceId,
      projectId: service.projectId,
      environmentId: service.environmentId,
      serviceId: service.serviceId,
      name: service.serviceName,
      details: { ...details },
      projectName: service.projectName,
    });
  }
  return items;
}

/**
 * Brings `railway_inventory` in line with what Railway returned and says what changed since
 * the last sync. The first sync reports nothing as added: everything is new then. A thing in
 * an environment that could not be read this time is left alone rather than marked removed.
 */
export async function syncInventory(
  tx: Queryable,
  snapshot: WorkspaceSnapshot,
  unread: UnreadEnvironment[],
  now: Date,
): Promise<{ changes: InventoryChange[]; initial: boolean }> {
  const existing = await tx.query<{ kind: InventoryKind; external_id: string; name: string; removed_at: Date | null }>(
    'SELECT kind, external_id, name, removed_at FROM railway_inventory',
  );
  const initial = existing.rowCount === 0;
  const known = new Map(existing.rows.map((r) => [`${r.kind}:${r.external_id}`, r]));
  const changes: InventoryChange[] = [];

  for (const item of itemsOf(snapshot)) {
    const before = known.get(`${item.kind}:${item.externalId}`);
    const renamed = before !== undefined && before.name !== item.name;
    await tx.query(
      `INSERT INTO railway_inventory
         (workspace_id, kind, external_id, railway_project_id, environment_id, service_id, name, details, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (kind, external_id) DO UPDATE SET
         name = EXCLUDED.name,
         details = EXCLUDED.details,
         last_seen = EXCLUDED.last_seen,
         removed_at = NULL,
         previous_name = CASE WHEN railway_inventory.name <> EXCLUDED.name THEN railway_inventory.name ELSE railway_inventory.previous_name END,
         renamed_at = CASE WHEN railway_inventory.name <> EXCLUDED.name THEN EXCLUDED.last_seen ELSE railway_inventory.renamed_at END`,
      [snapshot.workspaceId, item.kind, item.externalId, item.projectId, item.environmentId, item.serviceId, item.name, JSON.stringify(item.details), now],
    );
    if (item.kind === 'instance' || initial) continue;
    if (!before || before.removed_at) changes.push({ change: 'added', kind: item.kind, name: item.name, projectName: item.projectName });
    else if (renamed) changes.push({ change: 'renamed', kind: item.kind, name: item.name, previousName: before.name, projectName: item.projectName });
  }

  const unreadEnvironments = unread.map((u) => u.environmentId);
  const unreadProjects = unread.map((u) => u.projectId);
  const removed = await tx.query<{ kind: InventoryKind; name: string; railway_project_id: string }>(
    `UPDATE railway_inventory SET removed_at = $1
      WHERE removed_at IS NULL AND last_seen < $1
        AND NOT (kind IN ('instance', 'environment') AND environment_id = ANY($2))
        AND NOT (kind = 'service' AND railway_project_id = ANY($3))
      RETURNING kind, name, railway_project_id`,
    [now, unreadEnvironments, unreadProjects],
  );
  const projectNames = new Map(snapshot.projects.map((p) => [p.id, p.name]));
  for (const row of removed.rows) {
    if (row.kind === 'instance') continue;
    changes.push({
      change: 'removed',
      kind: row.kind,
      name: row.name,
      projectName: row.kind === 'project' ? row.name : (projectNames.get(row.railway_project_id) ?? 'a removed project'),
    });
  }
  return { changes, initial };
}

export interface InventoryInstance {
  environmentId: string;
  serviceId: string;
  railwayProjectId: string;
  name: string;
  details: InstanceDetails;
}

export async function listInstances(db: Queryable): Promise<InventoryInstance[]> {
  const { rows } = await db.query<{
    environment_id: string;
    service_id: string;
    railway_project_id: string;
    name: string;
    details: InstanceDetails;
  }>(
    `SELECT environment_id, service_id, railway_project_id, name, details
       FROM railway_inventory WHERE kind = 'instance' AND removed_at IS NULL ORDER BY name`,
  );
  return rows.map((r) => ({
    environmentId: r.environment_id,
    serviceId: r.service_id,
    railwayProjectId: r.railway_project_id,
    name: r.name,
    details: r.details,
  }));
}

export interface InventoryProject {
  id: string;
  name: string;
  services: number;
  repos: string[];
}

/** Railway projects as last seen, with the repositories their services deploy from. */
export async function listRailwayProjects(db: Queryable): Promise<InventoryProject[]> {
  const { rows } = await db.query<{ id: string; name: string; services: string; repos: string[] | null }>(
    `SELECT p.external_id AS id, p.name,
            (SELECT count(*) FROM railway_inventory s
              WHERE s.kind = 'service' AND s.railway_project_id = p.external_id AND s.removed_at IS NULL) AS services,
            (SELECT array_agg(DISTINCT i.details->>'repo') FILTER (WHERE i.details->>'repo' IS NOT NULL)
               FROM railway_inventory i
              WHERE i.kind = 'instance' AND i.railway_project_id = p.external_id AND i.removed_at IS NULL) AS repos
       FROM railway_inventory p
      WHERE p.kind = 'project' AND p.removed_at IS NULL
      ORDER BY lower(p.name)`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, services: Number(r.services), repos: (r.repos ?? []).sort() }));
}

export async function lastInventorySync(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>('SELECT max(last_seen) AS at FROM railway_inventory');
  return rows[0]?.at ?? null;
}
