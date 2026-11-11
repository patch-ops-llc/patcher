import type { Pool } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import type { Carriers } from '../recommendations/carriers.js';
import type { Catalog } from '../recommendations/catalog.js';
import type { ModelClient } from '../ai/client.js';
import type { FeatureStatus } from '../config.js';
import type { CursorClient } from '../cursor/client.js';
import type { DealRoomAdapter, ServiceDealRoomAdapter } from '../dealroom/adapter.js';
import type { GitHubClient } from '../github/client.js';
import type { SlackReaderFactory } from '../inbox/reader.js';
import type { TranscriptSource } from '../calls/sources/source.js';
import type { Vendor } from '../calls/types.js';
import type { Prober } from '../probes/probe.js';
import type { RailwayReader } from '../railway/client.js';
import type { SecretBox } from '../security/sealed.js';
import type { SlackClient } from '../slack/client.js';

/**
 * The outside systems the audit talks to. A client is null until its variables are set; the
 * code that would use it says "not configured" instead of failing.
 */
export interface Integrations {
  railway: RailwayReader | null;
  github: GitHubClient | null;
  cursor: CursorClient | null;
  /** The model provider. It drafts and classifies; it is given no other client and no credential. */
  model: ModelClient | null;
  probe: Prober;
  /**
   * The Calendly and Fathom adapters. They hold no key: each call is given the key of the
   * connection it is for, opened from the database.
   */
  transcripts: Record<Vendor, TranscriptSource>;
  /** The Penguin deal room through its repository: content files in a pull request that a person merges. */
  dealRoom: DealRoomAdapter | null;
  /**
   * The Penguin deal room through its service API. It holds the bot token, which exists in
   * the worker only. Settings says which of the two an approved proposal uses.
   */
  dealRoomApi: ServiceDealRoomAdapter | null;
  /**
   * Reads the hub workspace as the person who authorised it. It holds no token: each call is
   * given the token of the workspace it is for, opened from the database. Read methods only.
   */
  slackReader: SlackReaderFactory;
  status: { railway: FeatureStatus; github: FeatureStatus; cursor: FeatureStatus; anthropic: FeatureStatus; dealroom: FeatureStatus; dealroom_api: FeatureStatus };
}

/** What every job handler in the worker is given. */
export interface WorkerDeps {
  pool: Pool;
  queue: Enqueuer;
  catalog: Catalog;
  /** Shared Slack messages that carry several recommendations (the audit report). */
  carriers: Carriers;
  slack: SlackClient;
  log: Logger;
  /** The hub workspace. Undefined until the Slack variables are set. */
  hubTeamId: string | undefined;
  appBaseUrl: string;
  /** `DRY_RUN=1` in the environment, which forces dry run whatever the UI switch says. */
  dryRunEnv: boolean;
  integrations: Integrations;
  /** Opens the keys added in the UI. Null until `TOKEN_PRIVATE_KEY` is set. */
  secrets: SecretBox | null;
}
