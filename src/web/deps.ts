import type { FeatureStatus } from '../config.js';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Catalog } from '../recommendations/catalog.js';
import type { SlackClient } from '../slack/client.js';
import type { SlackOidc } from '../slack/oidc.js';
import type { CookieSettings } from './session.js';

/** What the public service is built from. Tests pass stand-ins for the Slack-facing parts. */
export interface WebDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
  log: Logger;
  appBaseUrl: string;
  cookies: CookieSettings;
  dryRunEnv: boolean;
  /** Undefined until the owner sets the Slack variables. */
  hubTeamId: string | undefined;
  signingSecret: string | undefined;
  bootstrapOwner: string | undefined;
  /** Null when Sign in with Slack is not configured. */
  oidc: SlackOidc | null;
  /** Null when there is no bot token; the Edit button then points to the UI. */
  modals: Pick<SlackClient, 'openView'> | null;
  features: Record<string, FeatureStatus>;
}
