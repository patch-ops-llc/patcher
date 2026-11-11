import { z } from 'zod';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { TIER_MODELS } from '../ai/models.js';
import { DEALROOM_ROUTES, parseRoomOrigin } from '../dealroom/origin.js';

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

const EMAIL = /^[^\s@,<>"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const emailList = z
  .string()
  .max(1000)
  .transform((value) => [...new Set(value.toLowerCase().split(/[\s,;]+/).filter(Boolean))].join(', '))
  .refine((value) => value.split(', ').filter(Boolean).every((e) => EMAIL.test(e)), 'Write whole addresses like name@example.com, separated by commas.');

const SENDER = /^(?:[^\s@,<>"]+)?@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const senderList = z
  .string()
  .max(1000)
  .transform((value) => [...new Set(value.toLowerCase().split(/[\s,;]+/).filter(Boolean))].join(', '))
  .refine((value) => value.split(', ').filter(Boolean).every((e) => SENDER.test(e)), 'Write addresses like name@example.com or @example.com, separated by commas.');

const quietHours = z
  .string()
  .trim()
  .refine((value) => value === '' || /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value), 'Write quiet hours as HH:MM-HH:MM, like 19:00-07:00, or leave it empty.');

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** What a proposal looks like until the owner writes their own template (design question 8). */
export const DEFAULT_PROPOSAL_TEMPLATE = `## Summary
Two or three sentences: what the prospect wants to achieve and what is proposed.

## Your situation
The problem as the prospect described it, in their terms.

## Proposed approach
How the work would be done, in phases where the call suggested them.

## Scope
What is included, as a list. Only items that were discussed.

## Timeline
The order of the work and any dates the prospect gave.

## Assumptions
What the proposal depends on, and what is not yet known.

## Next steps
What was agreed at the end of the call.`;

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
  'sales.enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Look for sales calls among the analysed calls and draft a proposal for each (off: no call is classified)',
  },
  'sales.penguin_emails': {
    schema: emailList,
    default: '',
    label: 'Your Penguin email addresses, comma separated (a sales call with one of them on it is a Penguin deal)',
  },
  'sales.title_patterns': {
    schema: z
      .string()
      .max(500)
      .transform((value) => [...new Set(value.split(/[,\n]+/).map((p) => p.trim().toLowerCase()).filter(Boolean))].slice(0, 30).join(', ')),
    default: 'intro, discovery, proposal, demo, scoping',
    label: 'Words in a call title that hint at a sales call, comma separated',
  },
  'sales.dealroom_repo': {
    schema: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Write the repository as owner/name.'),
    default: 'patch-ops-llc/penguin-dealroom',
    label: 'Repository of the Penguin deal room, where content pull requests are opened',
  },
  'sales.dealroom_route': {
    schema: z.enum(DEALROOM_ROUTES),
    default: 'pull_request',
    label: 'How an approved Penguin proposal reaches the deal room',
  },
  'sales.dealroom_url': {
    schema: z
      .string()
      .trim()
      .max(200)
      .transform((value, ctx) => {
        if (!value) return '';
        const parsed = parseRoomOrigin(value, { allowLocalHttp: true });
        if (parsed.ok) return parsed.origin;
        ctx.addIssue({ code: 'custom', message: parsed.reason });
        return z.NEVER;
      }),
    default: '',
    label: 'Address of the deal room, for its service API (for example https://dealroom.example)',
  },
  'sales.dealroom_publish': {
    schema: z.boolean(),
    default: false,
    label: 'Offer Publish for a draft deal room, and writing to a room that is already live, each as its own approval (off: Patcher never changes a room\'s status and never writes to a live room)',
  },
  'sales.currency': {
    schema: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Write a three-letter currency code, like USD.'),
    default: 'USD',
    label: 'Currency of the rate card',
  },
  'sales.proposal_template': {
    schema: z.string().trim().min(10, 'The template is too short.').max(8000),
    default: DEFAULT_PROPOSAL_TEMPLATE,
    label: 'Proposal template: the sections a proposal has and what each is for',
  },
  'ai.sales.enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Use the model for sales calls (off: nothing is classified or drafted until this is on again)',
  },
  'ai.sales.model_classify': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that says what kind of call it was' },
  'ai.sales.model_brief': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that extracts the deal brief' },
  'ai.sales.model_draft': { schema: modelId, default: TIER_MODELS.top, label: 'Model that writes the proposal' },
  'ai.sales.model_check': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that checks the proposal against the brief' },
  'ai.sales.auto_confidence': {
    schema: z.number().min(0.5).max(1),
    default: 0.8,
    label: 'Confidence from which a sales call gets a proposal draft without asking',
  },
  'ai.sales.ask_confidence': {
    schema: z.number().min(0).max(1),
    default: 0.5,
    label: 'Confidence from which Patcher asks in Slack whether a call was a sales call',
  },
  'ai.sales.daily_budget_usd': {
    schema: z.number().min(0).max(10_000),
    default: 0,
    label: 'Most to spend on sales model calls in 24 hours, in US dollars (0: no cap)',
  },
  'ai.sales.monthly_budget_usd': {
    schema: z.number().min(0).max(100_000),
    default: 0,
    label: 'Most to spend on sales model calls in 30 days, in US dollars (0: no cap)',
  },
  'inbox.enabled': {
    schema: z.boolean(),
    default: false,
    label: 'Read Slack messages and recommend what to do about them (off: every message is acknowledged and dropped, and nothing is stored)',
  },
  'inbox.settle_seconds': {
    schema: z.number().int().min(0).max(1800),
    default: 180,
    label: 'Seconds to wait after a message, so that the ones that follow it are read together',
  },
  'inbox.digest_only': {
    schema: z.boolean(),
    default: false,
    label: 'Post nothing at once: every item waits for the next digest',
  },
  'inbox.quiet_hours': {
    schema: quietHours,
    default: '19:00-07:00',
    label: 'Quiet hours, as HH:MM-HH:MM (during them only an escalation is posted at once; empty: none)',
  },
  'inbox.quiet_tz': {
    schema: z.string().trim().min(1).max(60).refine(isTimeZone, 'Unknown time zone. Use a name like America/Chicago.'),
    default: 'America/Chicago',
    label: 'Time zone of the quiet hours',
  },
  'inbox.unanalysed_after_minutes': {
    schema: z.number().int().min(1).max(24 * 60),
    default: 30,
    label: 'Minutes after which a message addressed to you is listed as "not analysed" when the model cannot be used',
  },
  'inbox.retention_days': {
    schema: z.number().int().min(1).max(30),
    default: 14,
    label: 'Days to keep the text of Slack messages',
  },
  'inbox.companion_silent_minutes': {
    schema: z.number().int().min(5).max(240),
    default: 15,
    label: 'Minutes without a report from the browser companion, in working hours, before the errors channel is told',
  },
  'inbox.agent_enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Offer "Agent" for a message that asks for a code change in a project with one linked repository',
  },
  'inbox.email_address': {
    schema: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .refine((value) => value === '' || (EMAIL.test(value) && !value.includes('+')), 'Write the inbound address of the mail service, like abc123@inbound.example.com, without a "+" part.'),
    default: '',
    label: 'Inbound address of the mail service that delivers to Patcher',
  },
  'inbox.email_senders': {
    schema: senderList,
    default: '@slack.com, @slack-mail.com',
    label: 'Senders whose mail is read as a Slack notification: whole addresses or @domains, comma separated',
  },
  'ai.inbox.enabled': {
    schema: z.boolean(),
    default: true,
    label: 'Use the model for Slack messages (off: messages addressed to you are listed unanalysed, the rest wait)',
  },
  'ai.inbox.model_triage': { schema: modelId, default: TIER_MODELS.small, label: 'Model that sorts Slack messages' },
  'ai.inbox.model_recommend': { schema: modelId, default: TIER_MODELS.mid, label: 'Model that words the recommendation and drafts a reply' },
  'ai.inbox.daily_budget_usd': {
    schema: z.number().min(0).max(10_000),
    default: 5,
    label: 'Most to spend on Slack model calls in 24 hours, in US dollars (0: no cap)',
  },
  'ai.inbox.monthly_budget_usd': {
    schema: z.number().min(0).max(100_000),
    default: 60,
    label: 'Most to spend on Slack model calls in 30 days, in US dollars (0: no cap)',
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
