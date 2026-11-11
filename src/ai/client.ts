import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type { ModelUsage } from './models.js';

/**
 * The one way Patcher talks to a model (design section 10). A request names a tool with a
 * JSON schema and the model answers by calling it, so a reply is data, never prose to be
 * interpreted. The client holds the provider key and nothing else: it cannot reach Slack,
 * Railway, GitHub or Cursor, and what it returns only ever goes through validation.
 */
export type Effort = 'low' | 'medium' | 'high';

export interface ModelRequest {
  model: string;
  /** Role, rules and output schema: the stable part, sent as a cached block. */
  system: string;
  /** The data for this call, already redacted. */
  user: string;
  tool: { name: string; description: string; schema: Record<string, unknown> };
  maxTokens: number;
  effort?: Effort | undefined;
}

export interface ModelReply {
  model: string;
  /** The input of the tool call. Null when the model did not call the tool. */
  output: unknown;
  /** Any text the model wrote next to the tool call. Kept for the error message only. */
  text: string;
  stopReason: string | null;
  usage: ModelUsage;
}

export interface BatchItem {
  /** 1 to 64 characters of `[A-Za-z0-9_-]`. */
  customId: string;
  request: ModelRequest;
}

export interface BatchState {
  id: string;
  ended: boolean;
  counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
}

export type BatchResult = { customId: string; reply: ModelReply } | { customId: string; error: string };

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
  /** Half price, answered within a day and usually within the hour. */
  createBatch(items: BatchItem[]): Promise<{ id: string }>;
  getBatch(id: string): Promise<BatchState>;
  batchResults(id: string): Promise<BatchResult[]>;
  cancelBatch(id: string): Promise<void>;
}

export class ModelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

type CacheTtl = '5m' | '1h';

/**
 * Forcing a tool (`tool_choice: tool`) is refused by the current models, so the tool is
 * strict, the choice is left to the model, and the prompt tells it to answer by calling the
 * tool. A reply without the call is treated like any other invalid output.
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
 */
function toParams(request: ModelRequest, cacheTtl: CacheTtl): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      {
        type: 'text',
        text: request.system,
        cache_control: cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: request.user }],
    tools: [
      {
        name: request.tool.name,
        description: request.tool.description,
        input_schema: request.tool.schema as Anthropic.Tool.InputSchema,
        strict: true,
      },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
  };
}

function toReply(message: Anthropic.Message, toolName: string): ModelReply {
  const call = message.content.find((block) => block.type === 'tool_use' && block.name === toolName);
  // A reply cut off at the token limit can hold half a tool call. It is not an answer.
  const complete = message.stop_reason !== 'max_tokens' && message.stop_reason !== 'refusal';
  return {
    model: message.model,
    output: call?.type === 'tool_use' && complete ? call.input : null,
    text: message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .slice(0, 500),
    stopReason: message.stop_reason,
    usage: {
      inputTokens: message.usage.input_tokens,
      cachedTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
    },
  };
}

function apiError(err: unknown): ModelApiError {
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    const detail = err.message.replace(/\s+/g, ' ').slice(0, 200);
    return new ModelApiError(status ? `Anthropic: ${detail} (HTTP ${status})` : `Anthropic did not answer (${detail})`, status);
  }
  return new ModelApiError(`Anthropic did not answer (${err instanceof Error ? err.name : 'error'})`, 0);
}

export function createAnthropicClient(options: AnthropicClientOptions): ModelClient {
  const anthropic = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // The SDK backs off and retries a rate limit, an overload and a dropped connection.
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 180_000,
  });
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw apiError(err);
    }
  };
  // The tool each batched request named, so its result can be read without the request.
  const toolNames = new Map<string, Map<string, string>>();

  return {
    complete: (request) =>
      guarded(async () => toReply(await anthropic.messages.create(toParams(request, '5m')), request.tool.name)),

    createBatch: (items) =>
      guarded(async () => {
        const batch = await anthropic.messages.batches.create({
          // A batch outlives the five-minute cache, so its shared prefix is cached for an hour.
          requests: items.map((item) => ({ custom_id: item.customId, params: toParams(item.request, '1h') })),
        });
        toolNames.set(batch.id, new Map(items.map((item) => [item.customId, item.request.tool.name])));
        return { id: batch.id };
      }),

    getBatch: (id) =>
      guarded(async () => {
        const batch = await anthropic.messages.batches.retrieve(id);
        return { id: batch.id, ended: batch.processing_status === 'ended', counts: { ...batch.request_counts } };
      }),

    batchResults: (id) =>
      guarded(async () => {
        const names = toolNames.get(id);
        const out: BatchResult[] = [];
        for await (const item of await anthropic.messages.batches.results(id)) {
          const result = item.result;
          if (result.type === 'succeeded') {
            // After a restart the tool names are gone; every request in a batch names one tool.
            const called = result.message.content.find((block) => block.type === 'tool_use');
            const tool = names?.get(item.custom_id) ?? (called?.type === 'tool_use' ? called.name : '');
            out.push({ customId: item.custom_id, reply: toReply(result.message, tool) });
          } else {
            const reason = result.type === 'errored' ? `errored: ${result.error.error.message.slice(0, 160)}` : result.type;
            out.push({ customId: item.custom_id, error: `The request was ${reason}.` });
          }
        }
        toolNames.delete(id);
        return out;
      }),

    cancelBatch: (id) =>
      guarded(async () => {
        await anthropic.messages.batches.cancel(id);
      }),
  };
}
