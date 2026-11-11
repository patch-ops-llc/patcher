/**
 * The deal room's address, as the owner types it in Settings and as the worker uses it.
 * The bot token is sent to this address and nowhere else, so it is held to a plain origin:
 * https, a host, an optional port, and nothing more.
 */
export const DEALROOM_ROUTES = ['pull_request', 'api'] as const;

export type OriginResult = { ok: true; origin: string } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `allowLocalHttp` lets `http://localhost` through, for a deal room running on the same
 * machine in development. The worker turns it off in production.
 */
export function parseRoomOrigin(value: string, options: { allowLocalHttp?: boolean } = {}): OriginResult {
  const fail = (reason: string): OriginResult => ({ ok: false, reason });
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return fail('Write the address as https://host, like https://dealroom.example.');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && options.allowLocalHttp)) {
    return fail('The deal room address must start with https://.');
  }
  if (url.username || url.password) return fail('The deal room address must not hold a user name or password.');
  if (url.search || url.hash) return fail('The deal room address is the site only: no "?" or "#" part.');
  if (url.pathname !== '/' && url.pathname !== '') return fail('The deal room address is the site only, without a path.');
  return { ok: true, origin: url.origin };
}
