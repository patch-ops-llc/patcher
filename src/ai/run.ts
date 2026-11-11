import { z } from 'zod';
import type { Pool, Queryable } from '../db/pool.js';
import { markError, markOk } from '../integrations/status.js';
import type { Logger } from '../log.js';
import { redact } from '../security/redact.js';
import type { Effort, ModelClient, ModelReply, ModelRequest } from './client.js';
import { ModelApiError } from './client.js';
import { costUsd, totalInput } from './models.js';
import type { PromptTask } from './prompts.js';
import { loadPrompt } from './prompts.js';

/** One model step: which prompt, what the reply must look like, and how much it may cost. */
export interface TaskSpec<T> {
  /** What the budget is counted against. */
  feature: string;
  task: PromptTask;
  tool: { name: string; description: string };
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: Effort;
}

export interface CallContext {
  model: string;
  /** The run the call belongs to, for the record. */
  runId: string | null;
}

export interface ModelDeps {
  pool: Pool;
  client: ModelClient;
  log: Logger;
}

/** The reply did not pass validation, after the one repair attempt the design allows. */
export class ModelOutputError extends Error {}

const UNSUPPORTED = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'maxItems', 'default']);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.has(key)) continue;
    // The provider enforces "at least one" and nothing higher.
    if (key === 'minItems') {
      if (typeof value === 'number' && value >= 1) out[key] = 1;
      continue;
    }
    out[key] = strip(value);
  }
  return out;
}

/**
 * The JSON schema sent with the tool. Strict tool use accepts a subset of JSON Schema (no
 * lengths, patterns or item counts), so those are left to `zod`, which checks every reply
 * against the full schema anyway.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Builds the request. The data part is redacted here, so no caller can forget to. */
export function buildRequest<T>(spec: TaskSpec<T>, model: string, user: string): { request: ModelRequest; promptVersion: string } {
  const prompt = loadPrompt(spec.task);
  return {
    promptVersion: prompt.version,
    request: {
      model,
      system: prompt.system,
      user: redact(user),
      tool: { ...spec.tool, schema: toolSchema(spec.schema) },
      maxTokens: spec.maxTokens,
      effort: spec.effort,
    },
  };
}

export type Read<T> = { ok: true; value: T } | { ok: false; problem: string };

export function readReply<T>(spec: TaskSpec<T>, reply: ModelReply): Read<T> {
  if (reply.output === null || reply.output === undefined) {
    return {
      ok: false,
      problem:
        reply.stopReason === 'max_tokens'
          ? 'the reply was cut off at the token limit'
          : reply.stopReason === 'refusal'
            ? 'the model declined to answer'
            : `the model did not call ${spec.tool.name}`,
    };
  }
  const parsed = spec.schema.safeParse(reply.output);
  if (parsed.success) return { ok: true, value: parsed.data };
  const problem = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ');
  return { ok: false, problem: problem.slice(0, 400) };
}

export interface CallRecord {
  feature: string;
  task: string;
  promptVersion: string;
  model: string;
  reply: ModelReply | null;
  latencyMs: number | null;
  batch: boolean;
  ok: boolean;
  error: string | null;
  runId: string | null;
}

/** Tokens, cost and outcome of one call. Neither the prompt nor the reply is stored. */
export async function recordCall(db: Queryable, call: CallRecord): Promise<void> {
  const usage = call.reply?.usage;
  await db.query(
    `INSERT INTO llm_calls
       (feature, task, prompt_version, model, input_tokens, cached_tokens, output_tokens, cost, latency_ms, batch, ok, error, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      call.feature,
      call.task,
      call.promptVersion,
      call.reply?.model ?? call.model,
      usage ? totalInput(usage) : 0,
      usage?.cachedTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage ? costUsd(call.reply?.model ?? call.model, usage, { batch: call.batch, cacheTtl: call.batch ? '1h' : '5m' }) : null,
      call.latencyMs,
      call.batch,
      call.ok,
      call.error ? call.error.slice(0, 400) : null,
      call.runId,
    ],
  );
}

const repairNote = (toolName: string, problem: string): string =>
  [
    '',
    '<previous_attempt>',
    `Your previous reply to this same request was rejected by validation: ${problem}.`,
    `Answer again by calling ${toolName} once, with input that follows the schema and the rules exactly.`,
    '</previous_attempt>',
  ].join('\n');

async function send<T>(deps: ModelDeps, spec: TaskSpec<T>, ctx: CallContext, user: string): Promise<Read<T>> {
  const { request, promptVersion } = buildRequest(spec, ctx.model, user);
  const base = { feature: spec.feature, task: spec.task, promptVersion, model: ctx.model, batch: false, runId: ctx.runId };
  const started = Date.now();
  let reply: ModelReply;
  try {
    reply = await deps.client.complete(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCall(deps.pool, { ...base, reply: null, latencyMs: Date.now() - started, ok: false, error: message });
    if (err instanceof ModelApiError) await markError(deps.pool, 'anthropic', message);
    throw err;
  }
  await markOk(deps.pool, 'anthropic');
  const read = readReply(spec, reply);
  await recordCall(deps.pool, {
    ...base,
    reply,
    latencyMs: Date.now() - started,
    ok: read.ok,
    error: read.ok ? null : `Invalid output: ${read.problem}`,
  });
  return read;
}

/**
 * One more try for a reply that did not validate, then give up: nothing is used from output
 * that failed validation (design 10.2 and 13.1).
 */
export async function repairCall<T>(deps: ModelDeps, spec: TaskSpec<T>, ctx: CallContext, user: string, problem: string): Promise<T> {
  const second = await send(deps, spec, ctx, user + repairNote(spec.tool.name, problem));
  if (second.ok) return second.value;
  throw new ModelOutputError(`The model's reply for ${spec.task} was invalid twice: ${second.problem}`);
}

/** Sends one request now and returns the validated reply. */
export async function callModel<T>(deps: ModelDeps, spec: TaskSpec<T>, ctx: CallContext, user: string): Promise<T> {
  const first = await send(deps, spec, ctx, user);
  if (first.ok) return first.value;
  deps.log.warn('model output invalid, trying once more', { task: spec.task, problem: first.problem });
  return repairCall(deps, spec, ctx, user, first.problem);
}

/** Dollars recorded for a feature since a point in time. Calls with an unknown price count as zero. */
export async function spentSince(db: Queryable, feature: string, hours: number): Promise<number> {
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT sum(cost) AS total FROM llm_calls WHERE feature = $1 AND at > now() - make_interval(hours => $2)`,
    [feature, hours],
  );
  return Number(rows[0]?.total ?? 0);
}

export interface CallTotals {
  task: string;
  model: string;
  promptVersion: string;
  calls: number;
  failed: number;
  batched: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Null when no call in the group had a known price. */
  cost: number | null;
  unpriced: number;
  avgLatencyMs: number | null;
}

/** Calls grouped by task, model and prompt version, for one run or for the last N days. */
export async function callTotals(db: Queryable, filter: { runId: string } | { days: number }): Promise<CallTotals[]> {
  const byRun = 'runId' in filter;
  const { rows } = await db.query<{
    task: string;
    model: string;
    prompt_version: string;
    calls: string;
    failed: string;
    batched: string;
    input_tokens: string;
    cached_tokens: string;
    output_tokens: string;
    cost: string | null;
    unpriced: string;
    latency: string | null;
  }>(
    `SELECT task, model, prompt_version,
            count(*) AS calls,
            count(*) FILTER (WHERE NOT ok) AS failed,
            count(*) FILTER (WHERE batch) AS batched,
            sum(input_tokens) AS input_tokens, sum(cached_tokens) AS cached_tokens, sum(output_tokens) AS output_tokens,
            sum(cost) AS cost,
            count(*) FILTER (WHERE cost IS NULL AND input_tokens > 0) AS unpriced,
            avg(latency_ms) AS latency
       FROM llm_calls
      WHERE ${byRun ? 'run_id = $1' : 'at > now() - make_interval(days => $1)'}
      GROUP BY task, model, prompt_version
      ORDER BY task, model, prompt_version`,
    [byRun ? filter.runId : filter.days],
  );
  return rows.map((r) => ({
    task: r.task,
    model: r.model,
    promptVersion: r.prompt_version,
    calls: Number(r.calls),
    failed: Number(r.failed),
    batched: Number(r.batched),
    inputTokens: Number(r.input_tokens),
    cachedTokens: Number(r.cached_tokens),
    outputTokens: Number(r.output_tokens),
    cost: r.cost === null ? null : Number(r.cost),
    unpriced: Number(r.unpriced),
    avgLatencyMs: r.latency === null ? null : Math.round(Number(r.latency)),
  }));
}
