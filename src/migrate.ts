import { ConfigError, loadMigrateConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createLogger } from './log.js';
import { migrationsDir } from './paths.js';
import { JobQueue } from './queue/queue.js';

const INSTALL_LOCK_KEY = 728_340_003;

/** Pre-deploy entry point: versioned SQL migrations, then the queue's own schema and queues. */
async function main(): Promise<void> {
  const config = loadMigrateConfig();
  const log = createLogger(config.logLevel, { service: 'migrate' });
  const pool = createPool(config.databaseUrl, 2);
  // Both services run this before they deploy; the lock makes the second wait for the first.
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [INSTALL_LOCK_KEY]);
    const result = await runMigrations(pool, migrationsDir, log);
    const queue = await JobQueue.start(config.databaseUrl, 'installer', log);
    await queue.stop();
    log.info('migrations complete', { applied: result.applied, alreadyApplied: result.skipped });
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [INSTALL_LOCK_KEY]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const log = createLogger('info', { service: 'migrate' });
  if (err instanceof ConfigError) log.error(err.message);
  else log.error('migration failed', { err });
  process.exitCode = 1;
});
