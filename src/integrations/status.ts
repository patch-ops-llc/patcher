import type { FeatureStatus } from '../config.js';
import type { Queryable } from '../db/pool.js';

/** The outside systems this phase talks to. Later phases add their own names. */
export const INTEGRATIONS = {
  railway: 'Railway',
  github: 'GitHub',
  cursor: 'Cursor',
  anthropic: 'Anthropic',
  dealroom: 'Penguin deal room',
} as const;
export type IntegrationName = keyof typeof INTEGRATIONS;

export interface IntegrationStatus {
  name: string;
  configured: boolean;
  missing: string[];
  lastOkAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** Written by the worker at boot, so the UI can say what is not configured without the keys. */
export async function recordConfigured(db: Queryable, statuses: Record<string, FeatureStatus>): Promise<void> {
  for (const [name, status] of Object.entries(statuses)) {
    await db.query(
      `INSERT INTO integrations (name, configured, missing) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET configured = EXCLUDED.configured, missing = EXCLUDED.missing, updated_at = now()`,
      [name, status.configured, status.missing],
    );
  }
}

export async function markOk(db: Queryable, name: IntegrationName): Promise<void> {
  await db.query('UPDATE integrations SET last_ok_at = now(), updated_at = now() WHERE name = $1', [name]);
}

export async function markError(db: Queryable, name: IntegrationName, error: string): Promise<void> {
  await db.query('UPDATE integrations SET last_error = $2, last_error_at = now(), updated_at = now() WHERE name = $1', [
    name,
    error.slice(0, 300),
  ]);
}

export async function listIntegrations(db: Queryable): Promise<IntegrationStatus[]> {
  const { rows } = await db.query<{
    name: string;
    configured: boolean;
    missing: string[];
    last_ok_at: Date | null;
    last_error: string | null;
    last_error_at: Date | null;
  }>('SELECT name, configured, missing, last_ok_at, last_error, last_error_at FROM integrations ORDER BY name');
  return rows.map((r) => ({
    name: r.name,
    configured: r.configured,
    missing: r.missing,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
  }));
}

export async function isConfigured(db: Queryable, name: IntegrationName): Promise<boolean> {
  const { rows } = await db.query<{ configured: boolean }>('SELECT configured FROM integrations WHERE name = $1', [name]);
  return rows[0]?.configured === true;
}
