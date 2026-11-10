import type { Actor } from '../audit/auditLog.js';
import type { Pool } from '../db/pool.js';
import type { Enqueuer } from '../queue/queue.js';
import { setSetting } from './settings.js';

/**
 * The global pause (design 10.3, guardrail 8), shared by the UI switch and `/ops pause`.
 * While paused nothing new is posted, no approval is accepted, no action runs and no
 * schedule fires. Resuming picks up whatever waited.
 */
export async function setPaused(
  deps: { pool: Pool; queue: Enqueuer },
  paused: boolean,
  actor: Actor,
): Promise<{ changed: boolean }> {
  const { changed } = await setSetting(deps.pool, 'paused', paused, actor);
  if (changed && !paused) await deps.queue.enqueue('system.resume', { requestedBy: actor });
  return { changed };
}
