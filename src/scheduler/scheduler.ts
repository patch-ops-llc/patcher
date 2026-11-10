import type { Pool } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Logger } from '../log.js';
import type { Enqueuer } from '../queue/queue.js';
import { getSetting } from '../settings/settings.js';
import type { ScheduleRow } from './schedules.js';
import { nextRun, scheduleFromRow } from './schedules.js';

// Arbitrary constant; only one worker replica at a time gets past it in a given tick.
const SCHEDULER_LOCK_KEY = 728_340_002;

export interface TickResult {
  /** False when another replica held the lock, or the bot is paused. */
  ran: boolean;
  fired: string[];
}

/**
 * Reads the `schedules` table once a minute and enqueues a `schedule.run` job for each row
 * that is due. Railway's cron services are not used (design section 3.3): schedules live in
 * the database so that a change in the UI takes effect on the next tick.
 *
 * A schedule is due when its expression has matched since the later of its last run and its
 * last edit. Several missed occurrences (the worker was down) collapse into one run.
 */
export async function schedulerTick(
  deps: { pool: Pool; queue: Enqueuer; log: Logger },
  now: Date = new Date(),
): Promise<TickResult> {
  return withTx(deps.pool, async (tx) => {
    const lock = await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [
      SCHEDULER_LOCK_KEY,
    ]);
    if (!lock.rows[0]?.locked) return { ran: false, fired: [] };
    if (await getSetting(tx, 'paused')) return { ran: false, fired: [] };

    const { rows } = await tx.query<ScheduleRow>('SELECT * FROM schedules WHERE enabled ORDER BY key FOR UPDATE');
    const fired: string[] = [];
    for (const row of rows) {
      const schedule = scheduleFromRow(row);
      const since =
        schedule.lastRunAt && schedule.lastRunAt > schedule.updatedAt ? schedule.lastRunAt : schedule.updatedAt;
      let due: Date;
      try {
        due = nextRun(schedule.cronExpr, schedule.tz, since);
      } catch (err) {
        deps.log.error('schedule has an invalid expression', { key: schedule.key, err });
        continue;
      }
      if (due > now) continue;
      await tx.query('UPDATE schedules SET last_run_at = $2 WHERE key = $1', [schedule.key, now]);
      // Same transaction as the update, so a schedule is marked as run only if its job exists.
      await deps.queue.enqueue(
        'schedule.run',
        { key: schedule.key, trigger: 'schedule', scheduledFor: due.toISOString() },
        { tx },
      );
      fired.push(schedule.key);
    }
    return { ran: true, fired };
  });
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  lastTickAt: Date | undefined;

  constructor(
    private readonly deps: { pool: Pool; queue: Enqueuer; log: Logger },
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick();
    this.timer = setInterval(tick, this.intervalMs);
    tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await schedulerTick(this.deps);
      this.lastTickAt = new Date();
      if (result.fired.length) this.deps.log.info('schedules fired', { keys: result.fired });
    } catch (err) {
      this.deps.log.error('scheduler tick failed', { err });
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
