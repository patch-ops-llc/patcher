import type { WorkerDeps } from '../worker/deps.js';
import type { Call } from './types.js';

/**
 * Where the sales pipeline attaches (design section 6). The call pipeline knows nothing about
 * sales: it matches a call to its project, and then tells whoever registered here.
 *
 * What a hook finds ready:
 *   - `calls.host_email` and `calls.attendees` ({ name, email, external }), normalised from
 *     both sources, which is what the Penguin rule of design 6.4 reads.
 *   - `calls.call_type` and `calls.call_type_conf`, which only the sales pipeline writes.
 *   - `calls.summary`, and the preferred transcript through `preferredTranscript`.
 *
 * `afterCallAnalysed` runs once the call's project question is settled (matched, asked, or
 * no match), after that has been saved and its follow-up jobs enqueued, outside that
 * transaction. A call that waited and was picked up again can reach it a second time, so a
 * hook must be safe to repeat. A hook that throws is logged and does not undo the match.
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
