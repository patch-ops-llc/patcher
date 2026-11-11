import type { Pool } from '../src/db/pool.js';
import { createPool } from '../src/db/pool.js';
import { registerFixCatalog } from '../src/fix/agentFix.js';
import { silentLogger } from '../src/log.js';
import type { JobData, JobName } from '../src/queue/jobs.js';
import { jobSchemas } from '../src/queue/jobs.js';
import type { EnqueueOptions, Enqueuer } from '../src/queue/queue.js';
import { Carriers } from '../src/recommendations/carriers.js';
import { createCatalog } from '../src/recommendations/catalog.js';
import type { Catalog } from '../src/recommendations/catalog.js';
import type { NewRecommendation } from '../src/recommendations/service.js';
import type { Role } from '../src/settings/users.js';
import type { SlackChannel } from '../src/settings/routes.js';
import { SlackApiError } from '../src/slack/client.js';
import type { SlackClient, SlackMessage, SlackView } from '../src/slack/client.js';
import type { SlackIdentity, SlackOidc } from '../src/slack/oidc.js';
import { OidcError } from '../src/slack/oidc.js';
import type { WebDeps } from '../src/web/deps.js';
import { auditCarrier } from '../src/weekly/delivery.js';
import type { Integrations, WorkerDeps } from '../src/worker/deps.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://patcher:patcher@localhost:5432/patcher_test';

export const HUB = 'T0HUB';
export const OWNER = 'U0OWNER';
export const APPROVER = 'U0APPROVER';
export const VIEWER = 'U0VIEWER';
export const STRANGER = 'U0STRANGER';
export const SIGNING_SECRET = 'test-signing-secret';
export const BASE_URL = 'http://patcher.test';

export function testPool(): Pool {
  return createPool(TEST_DATABASE_URL, 8);
}

/** Empties every table and restores the seeded schedule, so each test starts clean. */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE settings, channel_routes, slack_channels, schedules, users, sessions, recommendations,
             approvals, actions, webhook_events, runs, audit_log, projects, project_links, project_checks,
             railway_inventory, probe_results, audit_runs, audit_findings, agent_runs, integrations, llm_calls
             RESTART IDENTITY CASCADE`);
  await pool.query(`
    INSERT INTO schedules (key, cron_expr, tz) VALUES
      ('approvals.expire', '0 9 * * *', 'America/Chicago'),
      ('audit.weekly', '0 8 * * 1', 'America/Chicago'),
      ('probe.health', '*/5 * * * *', 'America/Chicago')`);
  await pool.query('DELETE FROM pgboss.job');
}

export async function addUser(pool: Pool, id: string, role: Role, kinds: string[] | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO users (slack_user_id, role, approval_kinds) VALUES ($1, $2, $3)
     ON CONFLICT (slack_user_id) DO UPDATE SET role = EXCLUDED.role, approval_kinds = EXCLUDED.approval_kinds`,
    [id, role, kinds],
  );
}

export async function seedPeople(pool: Pool): Promise<void> {
  await addUser(pool, OWNER, 'owner');
  await addUser(pool, APPROVER, 'approver');
  await addUser(pool, VIEWER, 'viewer');
}

export interface RecordedJob<N extends JobName = JobName> {
  name: N;
  data: JobData<N>;
  options: EnqueueOptions;
}

/** Stands in for the queue: validates payloads like the real one and remembers them. */
export class RecordingQueue implements Enqueuer {
  jobs: RecordedJob[] = [];

  enqueue<N extends JobName>(name: N, data: JobData<N>, options: EnqueueOptions = {}): Promise<void> {
    this.jobs.push({ name, data: jobSchemas[name].parse(data), options });
    return Promise.resolve();
  }

  of<N extends JobName>(name: N): JobData<N>[] {
    return this.jobs.filter((j) => j.name === name).map((j) => j.data as JobData<N>);
  }

  clear(): void {
    this.jobs = [];
  }
}

export interface SlackCall {
  method: 'postMessage' | 'updateMessage' | 'openView' | 'publishHome' | 'listChannels' | 'respond';
  args: Record<string, unknown>;
}

/** Stands in for Slack: remembers every call and can be told to fail the next one. */
export class FakeSlack implements SlackClient {
  calls: SlackCall[] = [];
  channels: SlackChannel[] = [];
  failNext: SlackApiError | undefined;
  private counter = 0;

  fail(code: string): void {
    this.failNext = new SlackApiError('test', code);
  }

  private record(method: SlackCall['method'], args: Record<string, unknown>): void {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.calls.push({ method, args });
  }

  of(method: SlackCall['method']): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  async postMessage(input: SlackMessage & { channel: string; threadTs?: string }): Promise<{ ts: string }> {
    await Promise.resolve();
    this.record('postMessage', { ...input });
    return { ts: `1700000000.${String(++this.counter).padStart(6, '0')}` };
  }
  async updateMessage(input: SlackMessage & { channel: string; ts: string }): Promise<void> {
    await Promise.resolve();
    this.record('updateMessage', { ...input });
  }
  async openView(input: { triggerId: string; view: SlackView }): Promise<void> {
    await Promise.resolve();
    this.record('openView', input);
  }
  async publishHome(input: { userId: string; view: SlackView }): Promise<void> {
    await Promise.resolve();
    this.record('publishHome', input);
  }
  async listChannels(): Promise<SlackChannel[]> {
    await Promise.resolve();
    this.record('listChannels', {});
    return this.channels;
  }
  async respond(responseUrl: string, text: string): Promise<void> {
    await Promise.resolve();
    this.record('respond', { responseUrl, text });
  }
}

/** Stands in for Sign in with Slack: returns whatever identity the test sets. */
export class StubOidc implements SlackOidc {
  identity: SlackIdentity | null = { teamId: HUB, userId: OWNER, name: 'Olive Owner', email: 'olive@example.com' };
  lastState = '';

  authorizeUrl(input: { state: string; nonce: string; redirectUri: string }): string {
    this.lastState = input.state;
    return `https://slack.test/authorize?state=${input.state}`;
  }

  exchange(): Promise<SlackIdentity> {
    return this.identity ? Promise.resolve(this.identity) : Promise.reject(new OidcError('refused'));
  }
}

export interface Harness {
  pool: Pool;
  queue: RecordingQueue;
  slack: FakeSlack;
  catalog: Catalog;
  worker: WorkerDeps;
}

const CONFIGURED = { configured: true, missing: [] };

/** Nothing outside is configured unless a test passes a stand-in. Probes fail loudly if used unplanned. */
export function testIntegrations(overrides: Partial<Integrations> = {}): Integrations {
  const railway = overrides.railway ?? null;
  const github = overrides.github ?? null;
  const cursor = overrides.cursor ?? null;
  const model = overrides.model ?? null;
  return {
    railway,
    github,
    cursor,
    model,
    probe: overrides.probe ?? (() => Promise.reject(new Error('no prober in this test'))),
    status: overrides.status ?? {
      railway: railway ? CONFIGURED : { configured: false, missing: ['RAILWAY_API_TOKEN'] },
      github: github ? CONFIGURED : { configured: false, missing: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'] },
      cursor: cursor ? CONFIGURED : { configured: false, missing: ['CURSOR_API_KEY'] },
      anthropic: model ? CONFIGURED : { configured: false, missing: ['ANTHROPIC_API_KEY'] },
    },
  };
}

export function harness(pool: Pool, overrides: Partial<WorkerDeps> = {}): Harness {
  const queue = new RecordingQueue();
  const slack = new FakeSlack();
  const integrations = overrides.integrations ?? testIntegrations();
  const catalog = registerFixCatalog(createCatalog(), { pool, queue, cursor: integrations.cursor });
  const worker: WorkerDeps = {
    pool,
    queue,
    catalog,
    carriers: new Carriers().register(auditCarrier),
    integrations,
    slack,
    log: silentLogger,
    hubTeamId: HUB,
    appBaseUrl: BASE_URL,
    dryRunEnv: false,
    ...overrides,
  };
  return { pool, queue, slack, catalog, worker };
}

export function webDeps(h: Harness, overrides: Partial<WebDeps> = {}): WebDeps & { oidc: StubOidc } {
  const configured = { configured: true, missing: [] };
  return {
    pool: h.pool,
    queue: h.queue,
    catalog: h.catalog,
    log: silentLogger,
    appBaseUrl: BASE_URL,
    cookies: { secret: 'test-session-secret-0123456789abcdef', secure: false },
    dryRunEnv: false,
    hubTeamId: HUB,
    signingSecret: SIGNING_SECRET,
    bootstrapOwner: OWNER,
    oidc: new StubOidc(),
    modals: h.slack,
    features: { slackRequests: configured, slackModals: configured, signIn: configured },
    ...overrides,
  } as WebDeps & { oidc: StubOidc };
}

export async function routeTo(pool: Pool, reportType: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO channel_routes (report_type, team_id, channel_id) VALUES ($1, $2, $3)
     ON CONFLICT (report_type) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
    [reportType, HUB, channelId],
  );
}

export function testRecommendation(overrides: Partial<NewRecommendation> = {}): NewRecommendation {
  return {
    kind: 'test',
    reportType: 'calls',
    sourceType: 'test',
    title: 'Add CSV export to the reports page',
    body: 'Asked for on the weekly sync.',
    evidence: [{ quote: 'Can we get a CSV export?', source: 'Acme weekly sync, 12:04' }],
    action: { type: 'acknowledge', params: { note: 'from a test' } },
    ...overrides,
  };
}

export async function auditActions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ action: string }>('SELECT action FROM audit_log ORDER BY id');
  return rows.map((r) => r.action);
}
