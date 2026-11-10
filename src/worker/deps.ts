import type { Pool } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Catalog } from '../recommendations/catalog.js';
import type { SlackClient } from '../slack/client.js';

/** What every job handler in the worker is given. */
export interface WorkerDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
  slack: SlackClient;
  log: Logger;
  /** The hub workspace. Undefined until the Slack variables are set. */
  hubTeamId: string | undefined;
  appBaseUrl: string;
  /** `DRY_RUN=1` in the environment, which forces dry run whatever the UI switch says. */
  dryRunEnv: boolean;
}
