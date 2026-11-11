import { ConfigError, loadWebConfig } from './config.js';
import { createPool } from './db/pool.js';
import { registerCallCatalog } from './calls/catalog.js';
import { registerFixCatalog } from './fix/agentFix.js';
import { registerInboxCatalog } from './inbox/catalog.js';
import { postmarkInbound } from './inbox/email.js';
import { createSlackReaderOAuth } from './inbox/reader.js';
import { backfillAfterGap } from './inbox/workspace.js';
import { createLogger } from './log.js';
import { JobQueue } from './queue/queue.js';
import { createCatalog } from './recommendations/catalog.js';
import { registerSalesCatalog } from './sales/catalog.js';
import { loadPublicKey, seal } from './security/sealed.js';
import { ensureBootstrapOwner } from './settings/users.js';
import { createSlackClient } from './slack/client.js';
import { createSlackOidc } from './slack/oidc.js';
import { createApp } from './web/app.js';

async function main(): Promise<void> {
  const config = loadWebConfig();
  const log = createLogger(config.logLevel, { service: 'web' });
  const tokenPublicKey = config.tokenPublicKey ? loadPublicKey(config.tokenPublicKey) : null;

  // The service starts without the owner-supplied Slack variables; each affected part says
  // so in the log here, on /health, and on the page or endpoint that needs it.
  for (const [name, status] of Object.entries(config.features)) {
    if (!status.configured) log.warn('feature not configured', { feature: name, missing: status.missing });
  }

  const pool = createPool(config.databaseUrl);
  const queue = await JobQueue.start(config.databaseUrl, 'producer', log);

  if (config.bootstrapOwner && (await ensureBootstrapOwner(pool, config.bootstrapOwner))) {
    log.info('bootstrap owner added to the allowlist');
  }

  // Slack stops retrying an event after a few minutes. If this service was away for longer,
  // the worker reads what was missed since the last event seen.
  try {
    const started = await backfillAfterGap({ pool, queue });
    if (started) log.info('slack catch-up requested after a gap', { workspaces: started });
  } catch (err) {
    log.warn('could not check for a gap in slack events', { err });
  }

  const app = createApp({
    pool,
    queue,
    // Registered without a runtime: the public service validates and describes the action, never runs it.
    catalog: registerInboxCatalog(registerSalesCatalog(registerCallCatalog(registerFixCatalog(createCatalog(), null), null), null), null),
    log,
    appBaseUrl: config.appBaseUrl,
    cookies: { secret: config.sessionSecret, secure: config.appBaseUrl.startsWith('https://') },
    dryRunEnv: config.dryRunEnv,
    hubTeamId: config.hubTeamId,
    signingSecret: config.slackSigningSecret,
    bootstrapOwner: config.bootstrapOwner,
    oidc:
      config.slackClientId && config.slackClientSecret && config.hubTeamId
        ? createSlackOidc({
            clientId: config.slackClientId,
            clientSecret: config.slackClientSecret,
            teamId: config.hubTeamId,
            baseUrl: config.slackOidcUrl,
          })
        : null,
    // Slack allows three seconds to open a modal, so this client fails fast.
    modals: config.slackBotToken
      ? createSlackClient({ token: config.slackBotToken, apiUrl: config.slackApiUrl, timeoutMs: 2500 })
      : null,
    features: config.features,
    seal: tokenPublicKey ? (plaintext) => seal(tokenPublicKey, plaintext) : null,
    readerOAuth:
      config.slackClientId && config.slackClientSecret && config.hubTeamId
        ? createSlackReaderOAuth({
            clientId: config.slackClientId,
            clientSecret: config.slackClientSecret,
            teamId: config.hubTeamId,
            baseUrl: config.slackOidcUrl,
          })
        : null,
    inboundEmailSecret: config.inboundEmailSecret,
    inboundMail: postmarkInbound,
  });

  const server = app.listen(config.port, () => log.info('web started', { port: config.port, baseUrl: config.appBaseUrl }));

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    server.close(() => {
      void queue
        .stop()
        .catch((err: unknown) => log.error('queue stop failed', { err }))
        .then(() => pool.end())
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  const log = createLogger('info', { service: 'web' });
  if (err instanceof ConfigError) log.error(err.message);
  else log.error('web failed to start', { err });
  process.exit(1);
});
