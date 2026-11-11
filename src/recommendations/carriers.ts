import type { WorkerDeps } from '../worker/deps.js';
import type { Recommendation } from './types.js';

/**
 * A carrier is a Slack message that shows several recommendations at once, one line and one
 * approve button each (the audit report, and later a call's list of suggestions). The loop
 * hands posting and re-rendering of a carried recommendation to its carrier; decisions,
 * hashes, the approver check, execution and the audit log are unchanged.
 */
export interface Carrier {
  type: string;
  /** Ask for the shared message to be posted if it has not been. Must be safe to repeat. */
  requestPost(deps: WorkerDeps, carrierId: string): Promise<void>;
  /** Edit the shared message to match the current state of what it carries. */
  render(deps: WorkerDeps, carrierId: string): Promise<void>;
  /**
   * What a thread reply about one carried recommendation starts with, so a reader can tell
   * which line of the shared message it is about: its number there.
   */
  label?(deps: WorkerDeps, recommendation: Recommendation): Promise<string | null>;
}

export class Carriers {
  private readonly byType = new Map<string, Carrier>();

  register(carrier: Carrier): this {
    if (this.byType.has(carrier.type)) throw new Error(`Carrier already registered: ${carrier.type}`);
    this.byType.set(carrier.type, carrier);
    return this;
  }

  get(type: string): Carrier | undefined {
    return this.byType.get(type);
  }
}
