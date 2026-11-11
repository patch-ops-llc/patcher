import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';

/**
 * Every setting the worker reads at run time. A later phase adds a key here with its schema
 * and default; nothing else needs to change for it to be stored, validated and audited.
 */
export const settingDefs = {
  paused: { schema: z.boolean(), default: false, label: 'Pause everything' },
  dry_run: { schema: z.boolean(), default: false, label: 'Dry run' },
  'approvals.expire_hours': {
    schema: z.number().int().min(1).max(24 * 30),
    default: 72,
    label: 'Hours before an undecided recommendation expires',
  },
  'approvals.reminder_hours': {
    schema: z.number().int().min(1).max(24 * 30),
    default: 24,
    label: 'Hours before expiry to send the one reminder',
  },
  'slack.max_posts_per_hour': {
    schema: z.number().int().min(1).max(60),
    default: 6,
    label: 'Most recommendations posted to one channel in an hour',
  },
  'audit.agent_timeout_minutes': {
    schema: z.number().int().min(10).max(24 * 60),
    default: 180,
    label: 'Minutes to wait for a fix agent before giving up on it',
  },
} as const;

export type SettingKey = keyof typeof settingDefs;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingDefs)[K]['schema']>;
export type AllSettings = { [K in SettingKey]: SettingValue<K> };

export const settingKeys = Object.keys(settingDefs) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingDefs, key);
}

function coerce<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
  const def = settingDefs[key];
  const parsed = def.schema.safeParse(stored);
  // A stored value that no longer validates falls back to the default instead of crashing a job.
  return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(db: Queryable, key: K): Promise<SettingValue<K>> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? coerce(key, rows[0].value) : (settingDefs[key].default as SettingValue<K>);
}

export async function getAllSettings(db: Queryable): Promise<AllSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const key of settingKeys) {
    out[key] = stored.has(key) ? coerce(key, stored.get(key)) : settingDefs[key].default;
  }
  return out as AllSettings;
}

export class SettingValidationError extends Error {}

/** Validates, stores and audits one setting. Returns whether the value changed. */
export async function setSetting<K extends SettingKey>(
  pool: Pool,
  key: K,
  value: unknown,
  actor: Actor,
): Promise<{ changed: boolean; value: SettingValue<K> }> {
  const parsed = settingDefs[key].schema.safeParse(value);
  if (!parsed.success) {
    throw new SettingValidationError(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
  }
  const next = parsed.data as SettingValue<K>;
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ value: unknown }>(
      'SELECT value FROM settings WHERE key = $1 FOR UPDATE',
      [key],
    );
    const before = rows[0] ? coerce(key, rows[0].value) : (settingDefs[key].default as SettingValue<K>);
    if (before === next) return { changed: false, value: next };
    await tx.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(next), actor],
    );
    await recordAudit(tx, { actor, action: 'setting.update', target: key, before, after: next });
    return { changed: true, value: next };
  });
}

export async function isPaused(db: Queryable): Promise<boolean> {
  return getSetting(db, 'paused');
}

/** Dry run is on if either the environment forces it (staging) or the switch is on. */
export async function isDryRun(db: Queryable, envDryRun: boolean): Promise<boolean> {
  return envDryRun || (await getSetting(db, 'dry_run'));
}
