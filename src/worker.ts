import http from 'node:http';
import { ConfigError, loadWorkerConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger } from './log.js';
import { JobQueue } from './queue/queue.js';
import { createCatalog } from './recommendations/catalog.js';
import { Scheduler } from './scheduler/scheduler.js';
import { loadPrivateKey } from './security/sealed.js';
import { createSlackClient, unconfiguredSlackClient } from './slack/client.js';
import type { WorkerDeps } from './worker/deps.js';
import { registerHandlers } from './worker/handlers.js';

/**
 * The private service: consumes jobs, runs the scheduler, and makes every outbound call.
 * Its only listener is `/health`, for Railway's deploy check; it gets no public domain.
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const log = createLogger(config.logLevel, { service: 'worker' });
  if (config.tokenPrivateKey) loadPrivateKey(config.tokenPrivateKey);

  for (const [name, status] of Object.entries(config.features)) {
    if (!status.configured) log.warn('feature not configured', { feature: name, missing: status.missing });
  }

  const pool = createPool(config.databaseUrl);
  const queue = await JobQueue.start(config.databaseUrl, 'worker', log);
  const deps: WorkerDeps = {
    pool,
    queue,
    catalog: createCatalog(),
    slack: config.slackBotToken
      ? createSlackClient({ token: config.slackBotToken, apiUrl: config.slackApiUrl })
      : unconfiguredSlackClient(),
    log,
    hubTeamId: config.hubTeamId,
    appBaseUrl: config.appBaseUrl,
    dryRunEnv: config.dryRunEnv,
  };

  await registerHandlers(queue, deps);
  const scheduler = new Scheduler({ pool, queue, log });
  scheduler.start();
  // Anything that was waiting when the last worker stopped gets another try.
  await queue.enqueue('system.resume', { requestedBy: 'system' });

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    pool
      .query('SELECT 1')
      .then(() => {
        const tickAgeMs = scheduler.lastTickAt ? Date.now() - scheduler.lastTickAt.getTime() : null;
        const ok = tickAgeMs === null || tickAgeMs < 5 * 60_000;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok,
            service: 'worker',
            database: 'ok',
            schedulerLastTickSecondsAgo: tickAgeMs === null ? null : Math.round(tickAgeMs / 1000),
            dryRunEnv: config.dryRunEnv,
            features: Object.fromEntries(Object.entries(config.features).map(([name, f]) => [name, f.configured])),
          }),
        );
      })
      .catch(() => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, service: 'worker', database: 'unreachable' }));
      });
  });
  server.listen(config.port, () => log.info('worker started', { port: config.port, dryRunEnv: config.dryRunEnv }));

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    scheduler.stop();
    server.close();
    void queue
      .stop()
      .catch((err: unknown) => log.error('queue stop failed', { err }))
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  const log = createLogger('info', { service: 'worker' });
  if (err instanceof ConfigError) log.error(err.message);
  else log.error('worker failed to start', { err });
  process.exit(1);
});
