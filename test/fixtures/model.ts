import type { BatchItem, BatchResult, BatchState, ModelClient, ModelReply, ModelRequest } from '../../src/ai/client.js';
import { ModelApiError } from '../../src/ai/client.js';

/** What a test wants the model to say to one request: the tool input, a full reply, an error to throw, or a function returning one of those. */
export type Answer = unknown;
export type Responder = (request: ModelRequest, index: number) => Answer;

const isReply = (value: unknown): value is Partial<ModelReply> & { output: unknown } =>
  typeof value === 'object' && value !== null && 'output' in value && 'usage' in value;

export const usage = (inputTokens = 900, outputTokens = 200) => ({ inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens });

/** A reply in which the model wrote prose and did not call the tool. */
export const proseReply = (text: string): ModelReply => ({ model: 'stub', output: null, text, stopReason: 'end_turn', usage: usage() });

/**
 * Stands in for the model provider. It answers by tool name, records every request it was
 * sent, and keeps batches until a test says they have ended. Nothing here reaches a network.
 */
export class FakeModel implements ModelClient {
  /** Every request, in order, whether sent directly or in a batch. */
  requests: ModelRequest[] = [];
  /** Direct calls only. */
  completed: ModelRequest[] = [];
  batches = new Map<string, { items: BatchItem[]; ended: boolean; canceled: boolean }>();
  /** When set, batches end as soon as they are created. */
  batchesEndAtOnce = true;
  failBatch: Error | undefined;
  failPoll: Error | undefined;
  private responders = new Map<string, Responder>();
  private interruptions = new Map<string, () => Promise<unknown>>();

  /** Runs `fn` to its end while the next request for `tool` is on its way: what a person does during a model call. */
  during(tool: string, fn: () => Promise<unknown>): this {
    this.interruptions.set(tool, fn);
    return this;
  }

  /** Sets what the model answers when asked to call `tool`. */
  on(tool: string, answer: Answer): this {
    this.responders.set(tool, typeof answer === 'function' ? (answer as Responder) : () => answer);
    return this;
  }

  /** Requests sent for one tool. */
  sent(tool: string): ModelRequest[] {
    return this.requests.filter((r) => r.tool.name === tool);
  }

  private answer(request: ModelRequest): ModelReply {
    const index = this.sent(request.tool.name).length;
    this.requests.push(request);
    const responder = this.responders.get(request.tool.name);
    if (!responder) throw new ModelApiError(`no answer set for ${request.tool.name}`, 500);
    const value = responder(request, index);
    if (value instanceof Error) throw value;
    if (isReply(value)) return { model: request.model, text: '', stopReason: 'tool_use', ...value } as ModelReply;
    return { model: request.model, output: value, text: '', stopReason: 'tool_use', usage: usage() };
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.completed.push(request);
    const interruption = this.interruptions.get(request.tool.name);
    if (interruption) {
      this.interruptions.delete(request.tool.name);
      await interruption();
    }
    return this.answer(request);
  }

  createBatch(items: BatchItem[]): Promise<{ id: string }> {
    if (this.failBatch) return Promise.reject(this.failBatch);
    const id = `batch_${this.batches.size + 1}`;
    this.batches.set(id, { items, ended: this.batchesEndAtOnce, canceled: false });
    return Promise.resolve({ id });
  }

  /** The provider has finished the batch. */
  end(id = [...this.batches.keys()].at(-1)!): void {
    this.batches.get(id)!.ended = true;
  }

  getBatch(id: string): Promise<BatchState> {
    if (this.failPoll) return Promise.reject(this.failPoll);
    const batch = this.batches.get(id);
    if (!batch) return Promise.reject(new ModelApiError('no such batch', 404));
    const n = batch.items.length;
    return Promise.resolve({
      id,
      ended: batch.ended,
      counts: { processing: batch.ended ? 0 : n, succeeded: batch.ended && !batch.canceled ? n : 0, errored: 0, canceled: batch.canceled ? n : 0, expired: 0 },
    });
  }

  batchResults(id: string): Promise<BatchResult[]> {
    const batch = this.batches.get(id);
    if (!batch?.ended) return Promise.reject(new ModelApiError('the batch has not ended', 400));
    return Promise.resolve(
      batch.items.map((item): BatchResult => {
        try {
          return { customId: item.customId, reply: this.answer(item.request) };
        } catch (err) {
          return { customId: item.customId, error: (err as Error).message };
        }
      }),
    );
  }

  cancelBatch(id: string): Promise<void> {
    const batch = this.batches.get(id);
    if (batch) batch.canceled = true;
    return Promise.resolve();
  }
}
