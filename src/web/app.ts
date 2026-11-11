import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { sourceHealth, storeDelivery } from '../calls/connections.js';
import { ingestMail, passwordMatches } from '../inbox/email.js';
import { readerHealth } from '../inbox/store.js';
import { publicDir } from '../paths.js';
import { listIntegrations } from '../integrations/status.js';
import { queueStats } from '../queue/queue.js';
import { getAllSettings } from '../settings/settings.js';
import type { WebDeps } from './deps.js';
import { slackRouter } from './slackRoutes.js';
import { uiRouter } from './ui.js';
import { errorPage } from './views.js';

/**
 * The public service. It verifies, records and acknowledges; it does no slow work and makes
 * no outbound calls except the two that cannot wait for the worker: opening a Slack modal
 * and exchanging a sign-in code.
 */
export function createApp(deps: WebDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS one hop in front of the service.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          formAction: ["'self'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  app.get('/health', async (_req, res) => {
    const features = Object.fromEntries(Object.entries(deps.features).map(([name, f]) => [name, f.configured]));
    try {
      const [queue, settings, integrations, callSources, slackReader] = await Promise.all([
        queueStats(deps.pool),
        getAllSettings(deps.pool),
        listIntegrations(deps.pool),
        sourceHealth(deps.pool),
        readerHealth(deps.pool),
      ]);
      res.json({
        ok: true,
        service: 'web',
        database: 'ok',
        queue,
        paused: settings.paused,
        dryRun: settings.dry_run || deps.dryRunEnv,
        // Which parts have the variables they need. Names of missing variables are in the logs.
        features,
        // What the worker reported at boot and the last success of each. No names of variables.
        integrations: Object.fromEntries(
          integrations.map((i) => [i.name, { configured: i.configured, lastOkAt: i.lastOkAt?.toISOString() ?? null }]),
        ),
        // Connected Calendly and Fathom keys, and the last time one answered.
        callSources,
        // Counts and times only: whether reading is on, when a message last arrived, what is waiting.
        slackReader: { enabled: settings['inbox.enabled'], ...slackReader },
      });
    } catch (err) {
      deps.log.error('health check failed', { err });
      res.status(503).json({ ok: false, service: 'web', database: 'unreachable', features });
    }
  });

  app.use('/assets', express.static(publicDir, { maxAge: '1h', index: false }));
  /**
   * Calendly and Fathom completion webhooks. The address carries a token only the vendor was
   * given. The delivery is stored as it arrived and acknowledged; the worker, which alone
   * holds the signing secret, verifies the signature before anything in it is used.
   */
  app.post('/webhooks/:source/:token', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    const outcome = await storeDelivery(deps, {
      source: String(req.params.source),
      token: String(req.params.token),
      headers,
      rawBody: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '',
    });
    if (outcome === 'unknown') res.status(404).json({ error: 'not_found' });
    else if (outcome === 'unsigned') res.status(400).json({ error: 'unsigned' });
    else res.status(200).json({ ok: true });
  });

  /**
   * Slack notification mail, forwarded by the owner and delivered here by the inbound mail
   * service (design 8.4). The service proves itself with a password; the secret part of the
   * forwarding address is checked next. 403 tells the service not to deliver it again.
   */
  app.post('/ingest/email', express.json({ limit: '2mb' }), async (req, res) => {
    if (!deps.inboundEmailSecret) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    if (!passwordMatches(req.get('authorization'), deps.inboundEmailSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const result = await ingestMail(deps, deps.inboundMail, req.body);
    if (result.status === 200) res.status(200).json({ ok: true });
    else res.status(result.status).json({ error: 'forbidden' });
  });

  app.use('/slack', slackRouter(deps));
  app.use(uiRouter(deps));

  app.use((_req, res) => {
    res.status(404).send(errorPage(404, 'There is nothing at this address.'));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.log.error('request failed', { err, method: req.method, path: req.path });
    if (res.headersSent) return;
    if ((err as { type?: unknown } | null)?.type === 'entity.too.large') {
      // A mail too large to read is refused for good, so the mail service stops sending it.
      if (req.path.startsWith('/ingest/')) res.status(403).json({ error: 'too_large' });
      else if (req.path.startsWith('/webhooks/')) res.status(413).json({ error: 'too_large' });
      else res.status(413).send(errorPage(413, 'That is too long to send in one form.'));
      return;
    }
    if ((err as { type?: unknown } | null)?.type === 'entity.parse.failed' && req.path.startsWith('/ingest/')) {
      res.status(403).json({ error: 'unreadable' });
      return;
    }
    if (req.path.startsWith('/slack/') || req.path.startsWith('/webhooks/') || req.path.startsWith('/ingest/')) res.status(500).json({ error: 'internal_error' });
    else res.status(500).send(errorPage(500, 'Something went wrong. It has been logged.'));
  });

  return app;
}
