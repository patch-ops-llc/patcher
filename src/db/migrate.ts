import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.js';
import type { Pool } from './pool.js';

// Arbitrary constant; serializes concurrent migrators (web and worker both run this pre-deploy).
const MIGRATION_LOCK_KEY = 728_340_001;

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  skipped: number;
}

/**
 * Applies `NNN_name.sql` files in order, each in its own transaction, recording them in
 * `schema_migrations`. Safe to run concurrently and safe to run again.
 */
export async function runMigrations(pool: Pool, dir: string, log: Logger): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (!FILE_PATTERN.test(f)) throw new Error(`Migration file name not recognised: ${f}`);
  }

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );

    const applied: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${version} failed: ${(err as Error).message}`, { cause: err });
      }
      log.info('migration applied', { version });
      applied.push(version);
    }
    return { applied, skipped: files.length - applied.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
