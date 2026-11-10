import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { schedulerTick } from '../src/scheduler/scheduler.js';
import { ScheduleValidationError, listSchedules, nextRun, updateSchedule, validateSchedule } from '../src/scheduler/schedules.js';
import { setSetting } from '../src/settings/settings.js';
import { runSchedule } from '../src/worker/handlers.js';
import { OWNER, RecordingQueue, auditActions, harness, resetDb, testPool } from './helpers.js';

const pool = testPool();
let queue: RecordingQueue;
const deps = () => ({ pool, queue, log: silentLogger });

/** Sets the seeded schedule's expression as if it had been last edited at `editedAt`. */
async function schedule(cron: string, tz: string, editedAt: string, lastRunAt: string | null = null) {
  await pool.query(
    `UPDATE schedules SET cron_expr = $1, tz = $2, updated_at = $3, last_run_at = $4, enabled = true
      WHERE key = 'approvals.expire'`,
    [cron, tz, editedAt, lastRunAt],
  );
}

beforeEach(async () => {
  await resetDb(pool);
  queue = new RecordingQueue();
});
afterAll(() => pool.end());

describe('cron expressions', () => {
  it('computes the next run in the schedule time zone', () => {
    // 09:00 in Chicago is 15:00 UTC in winter and 14:00 UTC in summer.
    expect(nextRun('0 9 * * *', 'America/Chicago', new Date('2026-01-15T00:00:00Z')).toISOString()).toBe(
      '2026-01-15T15:00:00.000Z',
    );
    expect(nextRun('0 9 * * *', 'America/Chicago', new Date('2026-07-15T00:00:00Z')).toISOString()).toBe(
      '2026-07-15T14:00:00.000Z',
    );
  });

  it('rejects expressions and time zones that are not valid', () => {
    expect(() => validateSchedule('0 9 * * *', 'America/Chicago')).not.toThrow();
    for (const [cron, tz] of [
      ['0 9 * *', 'UTC'],
      ['* * * * * *', 'UTC'],
      ['61 9 * * *', 'UTC'],
      ['every day', 'UTC'],
      ['0 9 * * *', 'Mars/Olympus'],
    ] as const) {
      expect(() => validateSchedule(cron, tz), `${cron} ${tz}`).toThrow(ScheduleValidationError);
    }
  });
});

describe('scheduler tick', () => {
  it('fires a due schedule once and not again until the next occurrence', async () => {
    await schedule('0 9 * * *', 'UTC', '2026-03-01T00:00:00Z');

    expect(await schedulerTick(deps(), new Date('2026-03-01T08:59:00Z'))).toEqual({ ran: true, fired: [] });
    expect(await schedulerTick(deps(), new Date('2026-03-01T09:00:30Z'))).toEqual({ ran: true, fired: ['approvals.expire'] });
    expect(await schedulerTick(deps(), new Date('2026-03-01T09:01:30Z'))).toEqual({ ran: true, fired: [] });
    expect(await schedulerTick(deps(), new Date('2026-03-02T09:00:10Z'))).toEqual({ ran: true, fired: ['approvals.expire'] });

    expect(queue.of('schedule.run')).toEqual([
      { key: 'approvals.expire', trigger: 'schedule', scheduledFor: '2026-03-01T09:00:00.000Z' },
      { key: 'approvals.expire', trigger: 'schedule', scheduledFor: '2026-03-02T09:00:00.000Z' },
    ]);
  });

  it('collapses occurrences missed while the worker was down into one run', async () => {
    await schedule('0 * * * *', 'UTC', '2026-03-01T00:00:00Z', '2026-03-01T01:00:05Z');
    expect((await schedulerTick(deps(), new Date('2026-03-01T07:30:00Z'))).fired).toEqual(['approvals.expire']);
    expect((await schedulerTick(deps(), new Date('2026-03-01T07:31:00Z'))).fired).toEqual([]);
    expect(queue.of('schedule.run')).toHaveLength(1);
  });

  it('skips disabled schedules', async () => {
    await schedule('* * * * *', 'UTC', '2026-03-01T00:00:00Z');
    await pool.query(`UPDATE schedules SET enabled = false`);
    expect((await schedulerTick(deps(), new Date('2026-03-01T00:05:00Z'))).fired).toEqual([]);
  });

  it('fires nothing while paused', async () => {
    await schedule('* * * * *', 'UTC', '2026-03-01T00:00:00Z');
    await setSetting(pool, 'paused', true, OWNER);
    expect(await schedulerTick(deps(), new Date('2026-03-01T00:05:00Z'))).toEqual({ ran: false, fired: [] });
    expect(queue.jobs).toEqual([]);
  });

  it('fires once when several replicas tick at the same moment', async () => {
    await schedule('* * * * *', 'UTC', '2026-03-01T00:00:00Z');
    const now = new Date('2026-03-01T00:05:00Z');
    const results = await Promise.all(Array.from({ length: 5 }, () => schedulerTick(deps(), now)));
    expect(results.flatMap((r) => r.fired)).toEqual(['approvals.expire']);
    expect(queue.of('schedule.run')).toHaveLength(1);
  });

  it('applies an edit made in the UI from the next tick, counting from the edit', async () => {
    await schedule('0 9 * * *', 'UTC', '2026-03-01T00:00:00Z');
    const result = await updateSchedule(pool, { key: 'approvals.expire', cronExpr: '*/5  * * * *', tz: 'UTC', enabled: true }, OWNER);
    expect(result.changed).toBe(true);
    const [edited] = await listSchedules(pool);
    expect(edited!.cronExpr).toBe('*/5 * * * *');
    // Nothing is owed for the time before the edit.
    expect((await schedulerTick(deps(), new Date(edited!.updatedAt.getTime() + 1000))).fired).toEqual([]);
    expect((await schedulerTick(deps(), new Date(edited!.updatedAt.getTime() + 6 * 60_000))).fired).toEqual(['approvals.expire']);
    expect(await auditActions(pool)).toEqual(['schedule.update']);
  });

  it('refuses an invalid edit and leaves the schedule as it was', async () => {
    await expect(
      updateSchedule(pool, { key: 'approvals.expire', cronExpr: 'whenever', tz: 'UTC', enabled: true }, OWNER),
    ).rejects.toThrow(ScheduleValidationError);
    await expect(
      updateSchedule(pool, { key: 'nope', cronExpr: '0 9 * * *', tz: 'UTC', enabled: true }, OWNER),
    ).rejects.toThrow(ScheduleValidationError);
    expect((await listSchedules(pool))[0]!.cronExpr).toBe('0 9 * * *');
    expect(await auditActions(pool)).toEqual([]);
  });
});

describe('running a schedule', () => {
  it('records the run and its result', async () => {
    const h = harness(pool);
    await runSchedule(h.worker, { 'approvals.expire': () => Promise.resolve('2 reminded, 1 expired') }, {
      key: 'approvals.expire',
      trigger: 'manual',
    });
    const { rows } = await pool.query('SELECT pipeline, trigger, ok, summary, finished_at FROM runs');
    expect(rows).toMatchObject([{ pipeline: 'approvals.expire', trigger: 'manual', ok: true, summary: '2 reminded, 1 expired' }]);
    expect(rows[0].finished_at).not.toBeNull();
    expect((await listSchedules(pool))[0]!.lastOk).toBe(true);
  });

  it('records a failed run and rethrows so the queue retries', async () => {
    const h = harness(pool);
    await expect(
      runSchedule(h.worker, { 'approvals.expire': () => Promise.reject(new Error('boom')) }, {
        key: 'approvals.expire',
        trigger: 'schedule',
      }),
    ).rejects.toThrow('boom');
    const { rows } = await pool.query('SELECT ok, summary FROM runs');
    expect(rows).toEqual([{ ok: false, summary: 'boom' }]);
    expect((await listSchedules(pool))[0]!.lastOk).toBe(false);
  });
});
