import http from 'node:http';
import { createAnthropicClient } from './ai/client.js';
import { loadAllPrompts } from './ai/prompts.js';
import { registerCallCatalog } from './calls/catalog.js';
import { callCarrier } from './calls/delivery.js';
import { createCalendlySource } from './calls/sources/calendly.js';
import { createFathomSource } from './calls/sources/fathom.js';
import { ConfigError, loadWorkerConfig } from './config.js';
import { createCursorClient } from './cursor/client.js';
import { createPool } from './db/pool.js';
import { createRepoAdapter } from './dealroom/adapter.js';
import { createDealRoomRepo } from './dealroom/github.js';
import { registerFixCatalog } from './fix/agentFix.js';
import { createGitHubClient, parseGitHubPrivateKey } from './github/client.js';
import { recordConfigured } from './integrations/status.js';
import { createLogger } from './log.js';
import { createProber } from './probes/probe.js';
import { JobQueue } from './queue/queue.js';
import { createRailwayClient } from './railway/client.js';
import { Carriers } from './recommendations/carriers.js';
import { createCatalog } from './recommendations/catalog.js';
import { registerSalesCatalog } from './sales/catalog.js';
import { salesCarrier } from './sales/delivery.js';
import { registerSalesSeam } from './sales/pipeline.js';
import { Scheduler } from './scheduler/scheduler.js';
import { loadPrivateKey, secretBox } from './security/sealed.js';
import { createSlackClient, unconfiguredSlackClient } from './slack/client.js';
import { auditCarrier } from './weekly/delivery.js';
import type { Integrations, WorkerDeps } from './worker/deps.js';
import { registerHandlers } from './worker/handlers.js';

/**
 * The private service: consumes jobs, runs the scheduler, and makes every outbound call.
 * Its only listener is `/health`, for Railway's deploy check; it gets no public domain.
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const log = createLogger(config.logLevel, { service: 'worker' });
  // Opens the Calendly and Fathom keys added in the UI. Without it they stay sealed and unused.
  const secrets = config.tokenPrivateKey ? secretBox(loadPrivateKey(config.tokenPrivateKey)) : null;
  if (config.github) {
    try {
      parseGitHubPrivateKey(config.github.privateKey);
    } catch {
      throw new ConfigError('Missing or invalid environment variables: GITHUB_APP_PRIVATE_KEY');
    }
  }
  if (config.dealRoom) {
    try {
      parseGitHubPrivateKey(config.dealRoom.privateKey);
    } catch {
      throw new ConfigError('Missing or invalid environment variables: DEALROOM_GITHUB_APP_PRIVATE_KEY');
    }
  }

  // A prompt file missing from the deploy stops the worker here, not at the next audit.
  loadAllPrompts();

  for (const [name, status] of Object.entries(config.features)) {
    if (!status.configured) log.warn('feature not configured', { feature: name, missing: status.missing });
  }

  const pool = createPool(config.databaseUrl);
  const queue = await JobQueue.start(config.databaseUrl, 'worker', log);
  // The clients for Railway, GitHub, Cursor and the model provider exist only here. The public
  // service never holds their credentials; it reads what is configured from the `integrations` table.
  const integrations: Integrations = {
    railway: config.railwayApiToken
      ? createRailwayClient({ token: config.railwayApiToken, log, ...(config.railwayApiUrl ? { endpoint: config.railwayApiUrl } : {}) })
      : null,
    github: config.github
      ? createGitHubClient({ ...config.github, ...(config.githubApiUrl ? { baseUrl: config.githubApiUrl } : {}) })
      : null,
    cursor: config.cursorApiKey
      ? createCursorClient({
          apiKey: config.cursorApiKey,
          model: config.cursorAgentModel,
          ...(config.cursorApiUrl ? { baseUrl: config.cursorApiUrl } : {}),
        })
      : null,
    model: config.anthropicApiKey
      ? createAnthropicClient({ apiKey: config.anthropicApiKey, baseUrl: config.anthropicApiUrl })
      : null,
    probe: createProber(),
    transcripts: {
      calendly: createCalendlySource(config.calendlyApiUrl ? { baseUrl: config.calendlyApiUrl } : {}),
      fathom: createFathomSource(config.fathomApiUrl ? { baseUrl: config.fathomApiUrl } : {}),
    },
    // Its own GitHub App, installed on the deal room's repository only. The audit's App is never used to write.
    dealRoom: config.dealRoom
      ? createRepoAdapter(createDealRoomRepo({ ...config.dealRoom, ...(config.dealRoomApiUrl ? { baseUrl: config.dealRoomApiUrl } : {}) }))
      : null,
    status: {
      railway: config.features.railway,
      github: config.features.github,
      cursor: config.features.cursor,
      anthropic: config.features.anthropic,
      dealroom: config.features.dealroom,
    },
  };
  await recordConfigured(pool, integrations.status);

  const deps: WorkerDeps = {
    pool,
    queue,
    catalog: registerSalesCatalog(
      registerCallCatalog(registerFixCatalog(createCatalog(), { pool, queue, cursor: integrations.cursor }), { pool }),
      { pool, appBaseUrl: config.appBaseUrl, dealRoom: integrations.dealRoom },
    ),
    carriers: new Carriers().register(auditCarrier).register(callCarrier).register(salesCarrier),
    integrations,
    secrets,
    slack: config.slackBotToken
      ? createSlackClient({ token: config.slackBotToken, apiUrl: config.slackApiUrl })
      : unconfiguredSlackClient(),
    log,
    hubTeamId: config.hubTeamId,
    appBaseUrl: config.appBaseUrl,
    dryRunEnv: config.dryRunEnv,
  };

  // Sales detection listens to the call pipeline through its seam.
  registerSalesSeam();
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
