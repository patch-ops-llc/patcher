import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { ProbeRefused, parseProbeUrl } from '../probes/probe.js';

/**
 * The project registry (design 5.2): one row per project, with links to its repositories and
 * Railway projects. For the audit it answers two questions: which repository does a Railway
 * service belong to, and may an agent be started on that repository. A repository that is
 * not linked here is never handed to an agent.
 */
export const LINK_KINDS = ['repo', 'railway_project', 'slack_channel', 'contact'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface ProjectLink {
  id: string;
  kind: LinkKind;
  externalId: string;
}

export interface ProjectCheck {
  id: string;
  projectId: string;
  name: string;
  url: string;
  expectStatus: number;
  expectJson: Record<string, unknown> | null;
  enabled: boolean;
}

export interface Project {
  id: string;
  name: string;
  client: string;
  status: 'active' | 'paused' | 'archived';
  description: string;
  aliases: string[];
  domains: string[];
  links: ProjectLink[];
  checks: ProjectCheck[];
}

export class RegistryError extends Error {}

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts `owner/name` or a GitHub URL and returns `owner/name` in lower case. */
export function normalizeRepo(input: string): string {
  const repo = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!REPO.test(repo)) throw new RegistryError('A repository is written owner/name.');
  return repo;
}

const list = (max: number) =>
  z
    .array(z.string().trim().min(1).max(100))
    .max(max)
    .transform((items) => [...new Set(items)]);

const projectInput = z.object({
  name: z.string().trim().min(1, 'A project needs a name.').max(100),
  client: z.string().trim().max(100).default(''),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  description: z.string().trim().max(1000).default(''),
  aliases: list(20).default([]),
  domains: list(20).default([]),
});
export type ProjectInput = z.input<typeof projectInput>;

interface ProjectRow {
  id: string;
  name: string;
  client: string;
  status: Project['status'];
  description: string;
  aliases: string[];
  domains: string[];
}

interface CheckRow {
  id: string;
  project_id: string;
  name: string;
  url: string;
  expect_status: number;
  expect_json: Record<string, unknown> | null;
  enabled: boolean;
}

const checkFromRow = (r: CheckRow): ProjectCheck => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  url: r.url,
  expectStatus: r.expect_status,
  expectJson: r.expect_json,
  enabled: r.enabled,
});

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RegistryError(parsed.error.issues[0]?.message ?? 'Not valid.');
  return parsed.data;
}

const uniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';

export async function listProjects(db: Queryable): Promise<Project[]> {
  const [projects, links, checks] = await Promise.all([
    db.query<ProjectRow>('SELECT id, name, client, status, description, aliases, domains FROM projects ORDER BY lower(name)'),
    db.query<{ id: string; project_id: string; kind: LinkKind; external_id: string }>(
      'SELECT id, project_id, kind, external_id FROM project_links ORDER BY kind, external_id',
    ),
    db.query<CheckRow>('SELECT * FROM project_checks ORDER BY name'),
  ]);
  return projects.rows.map((p) => ({
    ...p,
    links: links.rows.filter((l) => l.project_id === p.id).map((l) => ({ id: l.id, kind: l.kind, externalId: l.external_id })),
    checks: checks.rows.filter((c) => c.project_id === p.id).map(checkFromRow),
  }));
}

export async function getProject(db: Queryable, id: string): Promise<Project | null> {
  if (!UUID.test(id)) return null;
  return (await listProjects(db)).find((p) => p.id === id) ?? null;
}

export async function createProject(pool: Pool, input: ProjectInput, actor: Actor): Promise<string> {
  const data = validated(projectInput, input);
  return withTx(pool, async (tx) => {
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO projects (name, client, status, description, aliases, domains)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [data.name, data.client, data.status, data.description, data.aliases, data.domains],
      );
      await recordAudit(tx, { actor, action: 'project.create', target: rows[0]!.id, after: data });
      return rows[0]!.id;
    } catch (err) {
      if (uniqueViolation(err)) throw new RegistryError('A project with that name already exists.');
      throw err;
    }
  });
}

export async function updateProject(pool: Pool, id: string, input: ProjectInput, actor: Actor): Promise<void> {
  const data = validated(projectInput, input);
  await withTx(pool, async (tx) => {
    const before = await tx.query<ProjectRow>(
      'SELECT id, name, client, status, description, aliases, domains FROM projects WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!before.rows[0]) throw new RegistryError('That project does not exist.');
    try {
      await tx.query(
        `UPDATE projects SET name = $2, client = $3, status = $4, description = $5, aliases = $6, domains = $7, updated_at = now()
          WHERE id = $1`,
        [id, data.name, data.client, data.status, data.description, data.aliases, data.domains],
      );
    } catch (err) {
      if (uniqueViolation(err)) throw new RegistryError('A project with that name already exists.');
      throw err;
    }
    await recordAudit(tx, { actor, action: 'project.update', target: id, before: before.rows[0], after: data });
  });
}

export async function deleteProject(pool: Pool, id: string, actor: Actor): Promise<void> {
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ name: string }>('DELETE FROM projects WHERE id = $1 RETURNING name', [id]);
    if (!rows[0]) throw new RegistryError('That project does not exist.');
    await recordAudit(tx, { actor, action: 'project.delete', target: id, before: rows[0] });
  });
}

function normalizeLink(kind: LinkKind, externalId: string): string {
  const value = externalId.trim();
  if (kind === 'repo') return normalizeRepo(value);
  if (kind === 'railway_project') {
    if (!UUID.test(value)) throw new RegistryError('A Railway project is linked by its id.');
    return value.toLowerCase();
  }
  if (!value || value.length > 200) throw new RegistryError('The link is empty or too long.');
  return value;
}

async function insertLink(tx: Queryable, projectId: string, kind: LinkKind, externalId: string, actor: Actor): Promise<boolean> {
  const value = normalizeLink(kind, externalId);
  try {
    const { rowCount } = await tx.query(
      `INSERT INTO project_links (project_id, kind, external_id, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, kind, external_id) DO NOTHING`,
      [projectId, kind, value, actor],
    );
    if (rowCount) await recordAudit(tx, { actor, action: 'project.link', target: projectId, after: { kind, externalId: value } });
    return Boolean(rowCount);
  } catch (err) {
    if (uniqueViolation(err)) {
      throw new RegistryError(
        kind === 'repo' ? `${value} is already linked to another project.` : 'That Railway project is already linked to another project.',
      );
    }
    throw err;
  }
}

export async function addLink(pool: Pool, projectId: string, kind: LinkKind, externalId: string, actor: Actor): Promise<void> {
  if (!LINK_KINDS.includes(kind)) throw new RegistryError('Unknown kind of link.');
  await withTx(pool, async (tx) => {
    const project = await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (!project.rowCount) throw new RegistryError('That project does not exist.');
    await insertLink(tx, projectId, kind, externalId, actor);
  });
}

export async function removeLink(pool: Pool, projectId: string, linkId: string, actor: Actor): Promise<void> {
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ kind: string; external_id: string }>(
      'DELETE FROM project_links WHERE id = $1 AND project_id = $2 RETURNING kind, external_id',
      [linkId, projectId],
    );
    if (!rows[0]) throw new RegistryError('That link does not exist.');
    await recordAudit(tx, { actor, action: 'project.unlink', target: projectId, before: { kind: rows[0].kind, externalId: rows[0].external_id } });
  });
}

const checkInput = z.object({
  name: z.string().trim().min(1, 'A check needs a name.').max(80),
  url: z.string().trim().min(1).max(500),
  expectStatus: z.number().int().min(100).max(599).default(200),
  expectJson: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type CheckInput = z.input<typeof checkInput>;

export async function addCheck(pool: Pool, projectId: string, input: CheckInput, actor: Actor): Promise<string> {
  const data = validated(checkInput, input);
  try {
    parseProbeUrl(data.url);
  } catch (err) {
    if (err instanceof ProbeRefused) throw new RegistryError(`${err.message}.`);
    throw err;
  }
  return withTx(pool, async (tx) => {
    const project = await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (!project.rowCount) throw new RegistryError('That project does not exist.');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO project_checks (project_id, name, url, expect_status, expect_json, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [projectId, data.name, data.url, data.expectStatus, data.expectJson ? JSON.stringify(data.expectJson) : null, actor],
    );
    await recordAudit(tx, { actor, action: 'project.check.add', target: projectId, after: data });
    return rows[0]!.id;
  });
}

export async function removeCheck(pool: Pool, projectId: string, checkId: string, actor: Actor): Promise<void> {
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ name: string; url: string }>(
      'DELETE FROM project_checks WHERE id = $1 AND project_id = $2 RETURNING name, url',
      [checkId, projectId],
    );
    if (!rows[0]) throw new RegistryError('That check does not exist.');
    await recordAudit(tx, { actor, action: 'project.check.remove', target: projectId, before: rows[0] });
  });
}

export async function listEnabledChecks(db: Queryable): Promise<(ProjectCheck & { projectName: string })[]> {
  const { rows } = await db.query<CheckRow & { project_name: string }>(
    `SELECT c.*, p.name AS project_name FROM project_checks c JOIN projects p ON p.id = c.project_id
      WHERE c.enabled AND p.status = 'active' ORDER BY c.name`,
  );
  return rows.map((r) => ({ ...checkFromRow(r), projectName: r.project_name }));
}

/** The registry project a repository belongs to, if it is linked and the project is active. */
export async function projectForRepo(db: Queryable, repo: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM project_links l JOIN projects p ON p.id = l.project_id
      WHERE l.kind = 'repo' AND l.external_id = $1 AND p.status = 'active'`,
    [repo.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** Every repository an agent may be started on. */
export async function linkedRepos(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ external_id: string }>(
    `SELECT l.external_id FROM project_links l JOIN projects p ON p.id = l.project_id
      WHERE l.kind = 'repo' AND p.status = 'active'`,
  );
  return new Set(rows.map((r) => r.external_id));
}

/**
 * Seeds the registry from the Railway inventory: one project per Railway project, linked to
 * it and to the repositories its services deploy from. Run by an owner from the Projects
 * screen, never on its own, because being in the registry is what allows an agent on a
 * repository. Returns how many projects were created.
 */
export async function importRailwayProjects(pool: Pool, railwayProjectIds: string[], actor: Actor): Promise<{ created: number; skipped: string[] }> {
  let created = 0;
  const skipped: string[] = [];
  for (const railwayProjectId of railwayProjectIds) {
    await withTx(pool, async (tx) => {
      const source = await tx.query<{ name: string }>(
        `SELECT name FROM railway_inventory WHERE kind = 'project' AND external_id = $1 AND removed_at IS NULL`,
        [railwayProjectId],
      );
      const name = source.rows[0]?.name;
      if (!name) return;
      const linked = await tx.query(
        `SELECT 1 FROM project_links WHERE kind = 'railway_project' AND external_id = $1`,
        [railwayProjectId.toLowerCase()],
      );
      if (linked.rowCount) return;
      const sameName = await tx.query('SELECT 1 FROM projects WHERE lower(name) = lower($1)', [name]);
      if (sameName.rowCount) {
        skipped.push(name);
        return;
      }
      const project = await tx.query<{ id: string }>('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name.slice(0, 100)]);
      const projectId = project.rows[0]!.id;
      await recordAudit(tx, { actor, action: 'project.create', target: projectId, after: { name, from: 'railway' } });
      await insertLink(tx, projectId, 'railway_project', railwayProjectId, actor);
      const repos = await tx.query<{ repo: string }>(
        `SELECT DISTINCT details->>'repo' AS repo FROM railway_inventory
          WHERE kind = 'instance' AND railway_project_id = $1 AND removed_at IS NULL AND details->>'repo' IS NOT NULL`,
        [railwayProjectId],
      );
      for (const { repo } of repos.rows) {
        // A repository shared with a project that already claimed it stays with that project.
        const taken = await tx.query(`SELECT 1 FROM project_links WHERE kind = 'repo' AND external_id = $1`, [repo.toLowerCase()]);
        if (!taken.rowCount) await insertLink(tx, projectId, 'repo', repo, actor);
      }
      created += 1;
    });
  }
  return { created, skipped };
}
