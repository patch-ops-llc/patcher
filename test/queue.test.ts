import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { silentLogger } from '../src/log.js';
import type { DeadLetter } from '../src/queue/queue.js';
import { JobQueue, queueStats } from '../src/queue/queue.js';
import { TEST_DATABASE_URL, resetDb, testPool } from './helpers.js';

const pool = testPool();
let queue: JobQueue;

const ID = '11111111-1111-4111-8111-111111111111';

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the queue');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const jobCount = async (name: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM pgboss.job WHERE name = $1', [name])).rows[0].n);

beforeAll(() => resetDb(pool));
beforeEach(async () => {
  await pool.query('DELETE FROM pgboss.job');
  queue = await JobQueue.start(TEST_DATABASE_URL, 'worker', silentLogger);
});
afterEach(() => queue.stop());
afterAll(() => pool.end());

describe('job queue', () => {
  it('delivers a job to its consumer with the payload it was sent', async () => {
    const seen: unknown[] = [];
    await queue.work('recommendation.post', (data) => {
      seen.push(data);
      return Promise.resolve();
    });
    await queue.enqueue('recommendation.post', { recommendationId: ID });
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ recommendationId: ID }]);
  });

  it('refuses a payload that does not match the job schema', async () => {
    await expect(queue.enqueue('recommendation.post', { recommendationId: 'nope' })).rejects.toThrow();
    await expect(
      // @ts-expect-error an unknown field is a type error as well as a runtime one
      queue.enqueue('slack.respond', { responseUrl: 'https://hooks.slack.com/x', text: 'hi', extra: 1 }),
    ).rejects.toThrow();
    expect(await jobCount('recommendation.post')).toBe(0);
  });

  it('enqueues inside a transaction: nothing is sent if it rolls back', async () => {
    await expect(
      withTx(pool, async (tx) => {
        await queue.enqueue('recommendation.post', { recommendationId: ID }, { tx });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await jobCount('recommendation.post')).toBe(0);

    await withTx(pool, (tx) => queue.enqueue('recommendation.post', { recommendationId: ID }, { tx }));
    expect(await jobCount('recommendation.post')).toBe(1);
  });

  it('holds a job until its start time', async () => {
    await queue.enqueue('recommendation.post', { recommendationId: ID }, { startAfter: 3600 });
    const { rows } = await pool.query(
      `SELECT start_after > now() + interval '59 minutes' AS later FROM pgboss.job WHERE name = 'recommendation.post'`,
    );
    expect(rows[0].later).toBe(true);
    // A job that is not due yet does not count as waiting.
    expect(await queueStats(pool)).toMatchObject({ depth: 1, oldestReadySeconds: 0 });
  });

  it('retries a failing job, then succeeds', async () => {
    let attempts = 0;
    await queue.work('recommendation.sync', () => {
      attempts += 1;
      return attempts < 3 ? Promise.reject(new Error('not yet')) : Promise.resolve();
    });
    await queue.enqueue('recommendation.sync', { recommendationId: ID }, { retryLimit: 3, retryDelaySeconds: 0 });
    await until(() => attempts === 3);
    await until(async () => {
      const { rows } = await pool.query(`SELECT state FROM pgboss.job WHERE name = 'recommendation.sync'`);
      return rows[0]?.state === 'completed';
    });
    expect(attempts).toBe(3);
  });

  it('moves a job that has used up its retries to the dead-letter queue, with the reason', async () => {
    const dead: DeadLetter[] = [];
    let attempts = 0;
    await queue.onDeadLetter((d) => {
      dead.push(d);
      return Promise.resolve();
    });
    await queue.work('recommendation.details', () => {
      attempts += 1;
      return Promise.reject(new Error('still broken'));
    });
    await queue.enqueue('recommendation.details', { recommendationId: ID }, { retryLimit: 1, retryDelaySeconds: 0 });
    await until(() => dead.length === 1);
    expect(attempts).toBe(2);
    expect(dead[0]).toMatchObject({
      queue: 'recommendation.details',
      data: { recommendationId: ID },
      error: 'still broken',
    });
    expect((await queueStats(pool)).deadLetters).toBe(1);
  });

  it('has the default retry policy and dead-letter queue on every job queue', async () => {
    const { rows } = await pool.query(
      `SELECT name, retry_limit, retry_backoff, dead_letter FROM pgboss.queue WHERE name <> 'dead_letter'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const row of rows) {
      expect(row).toMatchObject({ retry_limit: 5, retry_backoff: true, dead_letter: 'dead_letter' });
    }
  });
});
