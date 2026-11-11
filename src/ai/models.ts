/**
 * The model tiers of design section 10.1 and what they cost. Model ids are settings per task;
 * these are the defaults: Anthropic's current model in each tier when this was written
 * (https://platform.claude.com/docs/en/about-claude/models/overview, read 2026-11-11).
 */
export const TIER_MODELS = {
  small: 'claude-haiku-5-5',
  mid: 'claude-sonnet-5-5',
  top: 'claude-opus-5-5',
} as const;

interface Price {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  /** Price of a token read from the prompt cache, as a share of the input price. */
  cacheRead: number;
  /** Above this many input tokens in one request the provider charges `long` instead. */
  longFrom?: number;
  long?: { input: number; output: number };
}

/** List prices from https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-11. */
const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.1, longFrom: 100_000, long: { input: 0.5, output: 2.5 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
};

const CACHE_WRITE = { '5m': 1.25, '1h': 2 } as const;
const BATCH_DISCOUNT = 0.5;

export interface ModelUsage {
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  /** Input tokens read from the prompt cache. */
  cachedTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens: number;
  /** Output tokens, including the model's reasoning. */
  outputTokens: number;
}

export const totalInput = (usage: ModelUsage): number => usage.inputTokens + usage.cachedTokens + usage.cacheWriteTokens;

function priceOf(model: string): Price | undefined {
  // A dated id ("claude-sonnet-5-5-20260928") is priced as the model it names.
  return PRICES[model] ?? Object.entries(PRICES).find(([id]) => model.startsWith(`${id}-`))?.[1];
}

/**
 * What a call cost at list price, in US dollars. Null for a model this table does not know:
 * a cost that is not known is shown as unknown, not as zero.
 */
export function costUsd(model: string, usage: ModelUsage, options: { batch?: boolean; cacheTtl?: '5m' | '1h' } = {}): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const rates = price.long && price.longFrom !== undefined && totalInput(usage) > price.longFrom ? price.long : price;
  const dollars =
    (usage.inputTokens * rates.input +
      usage.cachedTokens * rates.input * price.cacheRead +
      usage.cacheWriteTokens * rates.input * CACHE_WRITE[options.cacheTtl ?? '5m'] +
      usage.outputTokens * rates.output) /
    1_000_000;
  return Number((dollars * (options.batch ? BATCH_DISCOUNT : 1)).toFixed(6));
}

/** A rough token count for text that has not been sent yet: about four characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
