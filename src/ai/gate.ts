import type { Queryable } from '../db/pool.js';
import { getSetting } from '../settings/settings.js';
import type { ModelClient } from './client.js';
import { spentSince } from './run.js';

export type GateReason = 'paused' | 'not_configured' | 'disabled' | 'budget';
export type ModelGate = { ok: true; client: ModelClient } | { ok: false; reason: GateReason };

export const GATE_DETAIL: Record<GateReason, string> = {
  paused: 'Patcher is paused',
  not_configured: 'no model key is set (ANTHROPIC_API_KEY on the worker)',
  disabled: 'the model is switched off for this feature in Settings',
  budget: 'the model budget for this feature is used up',
};

/**
 * Whether the call pipeline may call the model now (design 10.3, guardrail 8): Patcher is
 * not paused, a key is set, the switch is on, and the daily and monthly budgets have room
 * for `estimate` more dollars. A budget of 0 means no limit.
 */
export async function callsModelGate(deps: { pool: Queryable; client: ModelClient | null }, estimate = 0): Promise<ModelGate> {
  if (await getSetting(deps.pool, 'paused')) return { ok: false, reason: 'paused' };
  if (!deps.client) return { ok: false, reason: 'not_configured' };
  if (!(await getSetting(deps.pool, 'ai.calls.enabled'))) return { ok: false, reason: 'disabled' };
  const [daily, monthly] = await Promise.all([
    getSetting(deps.pool, 'ai.calls.daily_budget_usd'),
    getSetting(deps.pool, 'ai.calls.monthly_budget_usd'),
  ]);
  if (daily > 0 && (await spentSince(deps.pool, 'calls', 24)) + estimate >= daily) return { ok: false, reason: 'budget' };
  if (monthly > 0 && (await spentSince(deps.pool, 'calls', 24 * 30)) + estimate >= monthly) return { ok: false, reason: 'budget' };
  return { ok: true, client: deps.client };
}

/** The same gate for the sales pipeline, against its own switch and budgets. */
export async function salesModelGate(deps: { pool: Queryable; client: ModelClient | null }, estimate = 0): Promise<ModelGate> {
  if (await getSetting(deps.pool, 'paused')) return { ok: false, reason: 'paused' };
  if (!deps.client) return { ok: false, reason: 'not_configured' };
  if (!(await getSetting(deps.pool, 'ai.sales.enabled'))) return { ok: false, reason: 'disabled' };
  const [daily, monthly] = await Promise.all([
    getSetting(deps.pool, 'ai.sales.daily_budget_usd'),
    getSetting(deps.pool, 'ai.sales.monthly_budget_usd'),
  ]);
  if (daily > 0 && (await spentSince(deps.pool, 'sales', 24)) + estimate >= daily) return { ok: false, reason: 'budget' };
  if (monthly > 0 && (await spentSince(deps.pool, 'sales', 24 * 30)) + estimate >= monthly) return { ok: false, reason: 'budget' };
  return { ok: true, client: deps.client };
}

/** The same gate for the Slack reader, against its own switch and budgets. */
export async function inboxModelGate(deps: { pool: Queryable; client: ModelClient | null }, estimate = 0): Promise<ModelGate> {
  if (await getSetting(deps.pool, 'paused')) return { ok: false, reason: 'paused' };
  if (!deps.client) return { ok: false, reason: 'not_configured' };
  if (!(await getSetting(deps.pool, 'ai.inbox.enabled'))) return { ok: false, reason: 'disabled' };
  const [daily, monthly] = await Promise.all([
    getSetting(deps.pool, 'ai.inbox.daily_budget_usd'),
    getSetting(deps.pool, 'ai.inbox.monthly_budget_usd'),
  ]);
  if (daily > 0 && (await spentSince(deps.pool, 'inbox', 24)) + estimate >= daily) return { ok: false, reason: 'budget' };
  if (monthly > 0 && (await spentSince(deps.pool, 'inbox', 24 * 30)) + estimate >= monthly) return { ok: false, reason: 'budget' };
  return { ok: true, client: deps.client };
}
