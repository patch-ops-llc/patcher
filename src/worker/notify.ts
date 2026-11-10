import { getRoute } from '../settings/routes.js';
import { isPaused } from '../settings/settings.js';
import type { WorkerDeps } from './deps.js';

/**
 * One short line in the bot-errors channel. Best effort by design: a failure to report a
 * failure is logged and dropped, never retried, so it cannot loop.
 */
export async function notifyOps(
  deps: WorkerDeps,
  text: string,
  options: { exceptChannel?: string | null } = {},
): Promise<boolean> {
  try {
    if (await isPaused(deps.pool)) return false;
    const route = await getRoute(deps.pool, 'errors');
    if (!route || route.channelId === options.exceptChannel) {
      deps.log.warn('ops notice not sent: no usable bot-errors channel', { text });
      return false;
    }
    await deps.slack.postMessage({ channel: route.channelId, text });
    return true;
  } catch (err) {
    deps.log.warn('ops notice failed', { text, err });
    return false;
  }
}
