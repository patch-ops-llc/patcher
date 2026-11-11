import { PgBoss } from 'pg-boss';
import type { JobWithMetadata } from 'pg-boss';
import type { Queryable } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { JobData, JobName } from './jobs.js';
import { jobNames, jobSchemas } from './jobs.js';

export const DEAD_LETTER_QUEUE = 'dead_letter';

export interface EnqueueOptions {
  /** Insert the job inside this transaction, so it exists only if the transaction commits. */
  tx?: Queryable;
  /** Do not start before this time, or this many seconds from now. */
  startAfter?: Date | number;
  /** Override the queue's retry policy for this one job. */
  retryLimit?: number;
  retryDelaySeconds?: number;
}

/** The only thing most code needs from the queue. Tests substitute a recorder. */
export interface Enqueuer {
  enqueue<N extends JobName>(name: N, data: JobData<N>, options?: EnqueueOptions): Promise<void>;
}

export interface DeadLetter {
  queue: string;
  jobId: string;
  data: unknown;
  error: string;
}

export type QueueRole =
  /** Installs or upgrades the queue schema and creates the queues. Run before deploy. */
  | 'installer'
  /** Sends jobs only (the public service). */
  | 'producer'
  /** Sends and consumes jobs and runs queue maintenance (the worker). */
  | 'worker';

const RETRY_POLICY = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 300,
} as const;

/**
 * Queues that differ from the default. The audit reads a whole workspace, which takes
 * minutes, and a second attempt straight after a failure would spend the same Railway
 * requests again: it runs once, and the next schedule or a person starts the next one.
 */
const QUEUE_OVERRIDES: Partial<Record<JobName, { retryLimit?: number; expireInSeconds?: number }>> = {
  'audit.run': { retryLimit: 0, expireInSeconds: 3600 },
};

function errorText(output: unknown): string {
  if (output && typeof output === 'object' && 'message' in output) {
    const message = (output).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown error';
}

export class JobQueue implements Enqueuer {
  private constructor(
    private readonly boss: PgBoss,
    private readonly log: Logger,
  ) {}

  static async start(databaseUrl: string, role: QueueRole, log: Logger): Promise<JobQueue> {
    const boss = new PgBoss({
      connectionString: databaseUrl,
      max: role === 'worker' ? 6 : 3,
      migrate: role === 'installer',
      createSchema: role === 'installer',
      supervise: role === 'worker',
      schedule: false,
    });
    boss.on('error', (err) => log.error('queue error', { err }));
    await boss.start();
    const queue = new JobQueue(boss, log);
    if (role === 'installer') await queue.ensureQueues();
    return queue;
  }

  private async ensureQueues(): Promise<void> {
    if (!(await this.boss.getQueue(DEAD_LETTER_QUEUE))) {
      await this.boss.createQueue(DEAD_LETTER_QUEUE, { retryLimit: 3, retryDelay: 30 });
    }
    for (const name of jobNames) {
      const options = { ...RETRY_POLICY, ...QUEUE_OVERRIDES[name], deadLetter: DEAD_LETTER_QUEUE };
      if (await this.boss.getQueue(name)) await this.boss.updateQueue(name, options);
      else await this.boss.createQueue(name, options);
    }
  }

  async enqueue<N extends JobName>(name: N, data: JobData<N>, options: EnqueueOptions = {}): Promise<void> {
    const parsed = jobSchemas[name].parse(data) as object;
    const tx = options.tx;
    await this.boss.send(name, parsed, {
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
      ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
      ...(options.retryDelaySeconds !== undefined ? { retryDelay: options.retryDelaySeconds } : {}),
      ...(tx ? { db: { executeSql: (text: string, values?: unknown[]) => tx.query(text, values) } } : {}),
    });
  }

  /**
   * Registers the consumer for one job. A thrown error is retried with backoff; after the
   * last retry the job moves to the dead-letter queue.
   */
  async work<N extends JobName>(
    name: N,
    handler: (data: JobData<N>, meta: { jobId: string; attempt: number }) => Promise<void>,
  ): Promise<void> {
    await this.boss.work<unknown>(name, { pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        const log = this.log.child({ job: name, jobId: job.id, attempt: job.retryCount });
        const parsed = jobSchemas[name].safeParse(job.data);
        if (!parsed.success) {
          log.error('job payload invalid');
          throw new Error(`Invalid payload for ${name}`);
        }
        try {
          await handler(parsed.data as JobData<N>, { jobId: job.id, attempt: job.retryCount });
          log.debug('job done');
        } catch (err) {
          log.warn('job failed', { err });
          throw err;
        }
      }
    });
  }

  /** Called once for each job that has used up its retries. */
  async onDeadLetter(handler: (dead: DeadLetter) => Promise<void>): Promise<void> {
    await this.boss.work(
      DEAD_LETTER_QUEUE,
      { pollingIntervalSeconds: 2, includeMetadata: true },
      async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) {
          await handler({
            queue: job.sourceName ?? 'unknown',
            jobId: job.sourceId ?? job.id,
            data: job.data,
            error: errorText(job.sourceOutput ?? job.output),
          });
        }
      },
    );
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

export interface QueueStats {
  /** Jobs waiting or running, excluding the dead-letter queue. */
  depth: number;
  /** Age in seconds of the oldest job that is ready to run and has not started. */
  oldestReadySeconds: number;
  /** Jobs that used up their retries in the last 24 hours. */
  deadLetters: number;
}

export async function queueStats(db: Queryable): Promise<QueueStats> {
  const { rows } = await db.query<{ depth: string; oldest: string | null; dead: string }>(
    `SELECT
       count(*) FILTER (WHERE name <> $1 AND state IN ('created', 'retry', 'active')) AS depth,
       extract(epoch FROM now() - min(created_on) FILTER (
         WHERE name <> $1 AND state IN ('created', 'retry') AND start_after <= now())) AS oldest,
       count(*) FILTER (WHERE name = $1 AND created_on > now() - interval '24 hours') AS dead
     FROM pgboss.job`,
    [DEAD_LETTER_QUEUE],
  );
  const row = rows[0];
  return {
    depth: Number(row?.depth ?? 0),
    oldestReadySeconds: Math.max(0, Math.round(Number(row?.oldest ?? 0))),
    deadLetters: Number(row?.dead ?? 0),
  };
}
