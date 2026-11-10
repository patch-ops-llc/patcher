import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { silentLogger } from '../src/log.js';
import { migrationsDir } from '../src/paths.js';
import { JobQueue } from '../src/queue/queue.js';
import { TEST_DATABASE_URL } from './helpers.js';

/** Rebuilds the test database from the real migrations before the suite runs. */
export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL, 2);
  try {
    await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runMigrations(pool, migrationsDir, silentLogger);
    const queue = await JobQueue.start(TEST_DATABASE_URL, 'installer', silentLogger);
    await queue.stop();
  } finally {
    await pool.end();
  }
}
