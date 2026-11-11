import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { TIER_MODELS } from '../ai/models.js';

const modelId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.-]{2,80}$/, 'A model id looks like claude-sonnet-5-5.');

/** Which copy of a call recorded twice is analysed. `speakers`: the one with speaker labels, then the longer. */
export const PREFERRED_COPIES = ['speakers', 'longest', 'calendly', 'fathom'] as const;
export type PreferredCopy = (typeof PREFERRED_COPIES)[number];

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const domainList = z
  .string()
  .max(1000)
  .transform((value) =>
    [...new Set(value.toLowerCase().split(/[\s,]+/).map((d) => d.replace(/^@/, '')).filter(Boolean))].join(', '),
  )
  .refine((value) => value.split(', ').filter(Boolean).every((d) => DOMAIN.test(d)), 'Write domains like example.com, separated by commas.');

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
  'ai.audit.enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Use the model in the weekly audit (off: the rules rank and word the report)',
  },
  'ai.audit.model_service': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that assesses each service' },
  'ai.audit.model_rollup': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that ranks the report' },
  'ai.audit.model_brief': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that drafts a fix brief' },
  'ai.audit.daily_budget_usd': {
    schema: z.number().min(0).max(10_000),
    default: 0,
    label: 'Most to spend on audit model calls in 24 hours, in US dollars (0: no cap)',
  },
  'ai.audit.monthly_budget_usd': {
    schema: z.number().min(0).max(100_000),
    default: 0,
    label: 'Most to spend on audit model calls in 30 days, in US dollars (0: no cap)',
  },
  'ai.audit.log_token_cap': {
    schema: z.number().int().min(200).max(50_000),
    default: 4000,
    label: 'Most log tokens sent to the model for one service',
  },
  'ai.audit.wait_minutes': {
    schema: z.number().int().min(5).max(24 * 60),
    default: 120,
    label: "Minutes to wait for the model's per-service assessments before the report goes out without them",
  },
  'calls.enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Collect and analyse call transcripts (off: nothing is fetched, and webhooks are acknowledged and dropped)',
  },
  'calls.settle_minutes': {
    schema: z.number().int().min(0).max(240),
    default: 10,
    label: 'Minutes to wait after a transcript arrives, so a second recording of the same call can be grouped with it',
  },
  'calls.preferred_copy': {
    schema: z.enum(PREFERRED_COPIES),
    default: 'speakers',
    label: 'Which transcript to analyse when a call was recorded twice',
  },
  'calls.retention_days': {
    schema: z.number().int().min(1).max(3650),
    default: 180,
    label: 'Days to keep transcript text',
  },
  'calls.internal_domains': {
    schema: domainList,
    default: '',
    label: 'Your own email domains, comma separated (attendees from these never count as a client)',
  },
  'ai.calls.enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Use the model for calls (off: calls are still collected, and wait unanalysed until this is on again)',
  },
  'ai.calls.model_match': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that matches a call to a project' },
  'ai.calls.model_suggest': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that suggests changes from a call' },
  'ai.calls.model_brief': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that drafts the brief for a code change' },
  'ai.calls.auto_match_confidence': {
    schema: z.number().min(0.5).max(1),
    default: 0.8,
    label: 'Confidence from which a call is matched to a project without asking',
  },
  'ai.calls.ask_confidence': {
    schema: z.number().min(0).max(1),
    default: 0.5,
    label: 'Confidence from which Patcher asks in Slack which project a call belongs to (below: the Unmatched list)',
  },
  'ai.calls.max_suggestions': {
    schema: z.number().int().min(1).max(5),
    default: 5,
    label: 'Most suggestions from one call',
  },
  'ai.calls.daily_budget_usd': {
    schema: z.number().min(0).max(10_000),
    default: 0,
    label: 'Most to spend on call model calls in 24 hours, in US dollars (0: no cap)',
  },
  'ai.calls.monthly_budget_usd': {
    schema: z.number().min(0).max(100_000),
    default: 0,
    label: 'Most to spend on call model calls in 30 days, in US dollars (0: no cap)',
  },
  'ai.calls.transcript_token_cap': {
    schema: z.number().int().min(2000).max(150_000),
    default: 40_000,
    label: 'Most transcript tokens sent to the model for one call (a longer call is cut in the middle)',
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
