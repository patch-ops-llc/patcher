import { CronExpressionParser } from 'cron-parser';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';

export interface Schedule {
  key: string;
  cronExpr: string;
  tz: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastOk: boolean | null;
  updatedAt: Date;
}

export interface ScheduleRow {
  key: string;
  cron_expr: string;
  tz: string;
  enabled: boolean;
  last_run_at: Date | null;
  last_ok: boolean | null;
  updated_at: Date;
}

export const scheduleFromRow = (r: ScheduleRow): Schedule => ({
  key: r.key,
  cronExpr: r.cron_expr,
  tz: r.tz,
  enabled: r.enabled,
  lastRunAt: r.last_run_at,
  lastOk: r.last_ok,
  updatedAt: r.updated_at,
});

export class ScheduleValidationError extends Error {}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The first time the expression matches strictly after `after`, in the schedule's time zone. */
export function nextRun(cronExpr: string, tz: string, after: Date): Date {
  return CronExpressionParser.parse(cronExpr, { currentDate: after, tz }).next().toDate();
}

export function validateSchedule(cronExpr: string, tz: string): void {
  // Five fields only: minute resolution is what the scheduler's one-minute tick can honour.
  if (cronExpr.trim().split(/\s+/).length !== 5) {
    throw new ScheduleValidationError('Use five cron fields: minute hour day-of-month month day-of-week.');
  }
  if (!isValidTimeZone(tz)) throw new ScheduleValidationError('Unknown time zone. Use a name like America/Chicago.');
  try {
    nextRun(cronExpr, tz, new Date());
  } catch {
    throw new ScheduleValidationError('That cron expression is not valid.');
  }
}

export async function listSchedules(db: Queryable): Promise<Schedule[]> {
  const { rows } = await db.query<ScheduleRow>('SELECT * FROM schedules ORDER BY key');
  return rows.map(scheduleFromRow);
}

export async function updateSchedule(
  pool: Pool,
  input: { key: string; cronExpr: string; tz: string; enabled: boolean },
  actor: Actor,
): Promise<{ changed: boolean }> {
  const cronExpr = input.cronExpr.trim().replace(/\s+/g, ' ');
  const tz = input.tz.trim();
  validateSchedule(cronExpr, tz);
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<ScheduleRow>('SELECT * FROM schedules WHERE key = $1 FOR UPDATE', [input.key]);
    if (!rows[0]) throw new ScheduleValidationError('Unknown schedule.');
    const before = scheduleFromRow(rows[0]);
    if (before.cronExpr === cronExpr && before.tz === tz && before.enabled === input.enabled) {
      return { changed: false };
    }
    await tx.query(
      `UPDATE schedules SET cron_expr = $2, tz = $3, enabled = $4, updated_by = $5, updated_at = now() WHERE key = $1`,
      [input.key, cronExpr, tz, input.enabled, actor],
    );
    await recordAudit(tx, {
      actor,
      action: 'schedule.update',
      target: input.key,
      before: { cronExpr: before.cronExpr, tz: before.tz, enabled: before.enabled },
      after: { cronExpr, tz, enabled: input.enabled },
    });
    return { changed: true };
  });
}
