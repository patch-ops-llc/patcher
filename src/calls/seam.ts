import type { WorkerDeps } from '../worker/deps.js';
import type { Call } from './types.js';

/**
 * Where the sales phase attaches (design section 6). Nothing here classifies a call, drafts
 * a proposal or touches the deal room: this phase stops at the project match and the
 * suggested changes.
 *
 * What the next phase finds ready:
 *   - `calls.host_email` and `calls.attendees` ({ name, email, external }), normalised from
 *     both sources, which is what the Penguin rule of design 6.4 reads.
 *   - `calls.call_type` and `calls.call_type_conf`, reserved and never written here.
 *   - `calls.summary`, and the preferred transcript through `preferredTranscript`.
 *   - this hook, called once per analysis with the call as it was stored.
 *
 * `afterCallAnalysed` runs after the match has been saved and its follow-up jobs enqueued,
 * outside that transaction. A hook that throws is logged and does not undo the match.
 */
export type CallAnalysedHook = (deps: WorkerDeps, call: Call) => Promise<void>;

const hooks: CallAnalysedHook[] = [];

export function onCallAnalysed(hook: CallAnalysedHook): void {
  hooks.push(hook);
}

export async function afterCallAnalysed(deps: WorkerDeps, call: Call): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(deps, call);
    } catch (err) {
      deps.log.warn('call analysed hook failed', { callId: call.id, err });
    }
  }
}
