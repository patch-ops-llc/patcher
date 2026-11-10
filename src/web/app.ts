import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { publicDir } from '../paths.js';
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
      const [queue, settings] = await Promise.all([queueStats(deps.pool), getAllSettings(deps.pool)]);
      res.json({
        ok: true,
        service: 'web',
        database: 'ok',
        queue,
        paused: settings.paused,
        dryRun: settings.dry_run || deps.dryRunEnv,
        // Which parts have the variables they need. Names of missing variables are in the logs.
        features,
        // Last success of each integration; none exist until a later phase connects one.
        integrations: {},
      });
    } catch (err) {
      deps.log.error('health check failed', { err });
      res.status(503).json({ ok: false, service: 'web', database: 'unreachable', features });
    }
  });

  app.use('/assets', express.static(publicDir, { maxAge: '1h', index: false }));
  app.use('/slack', slackRouter(deps));
  app.use(uiRouter(deps));

  app.use((_req, res) => {
    res.status(404).send(errorPage(404, 'There is nothing at this address.'));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.log.error('request failed', { err, method: req.method, path: req.path });
    if (res.headersSent) return;
    if (req.path.startsWith('/slack/')) res.status(500).json({ error: 'internal_error' });
    else res.status(500).send(errorPage(500, 'Something went wrong. It has been logged.'));
  });

  return app;
}
