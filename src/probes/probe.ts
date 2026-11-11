import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * One GET against a public address, the way a visitor would make it. The worker runs these,
 * and the addresses come from Railway and from the registry screen, so the probe refuses
 * anything that is not a public internet address: no loopback, private ranges, link-local,
 * Railway's internal network or cloud metadata endpoints.
 */
export interface ProbeTarget {
  url: string;
  /** Exactly this status. Without it, anything below `failFrom` counts as up. */
  expectStatus?: number | undefined;
  /** Default 500: a 401 or 404 at `/` still means the service answers. 400 for a health path. */
  failFrom?: number | undefined;
  /** Every key here must be in the JSON body with an equal value. */
  expectJson?: Record<string, unknown> | undefined;
}

export interface ProbeOutcome {
  ok: boolean;
  host: string;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
  certificateExpiresAt: Date | null;
}

export type Prober = (target: ProbeTarget) => Promise<ProbeOutcome>;

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

const INTERNAL_HOST = /(^|\.)(localhost|internal|local|lan|home|corp|svc)$/i;

export class ProbeRefused extends Error {}

/** The checks that need no network: scheme, host name and, for a literal address, its range. */
export function parseProbeUrl(raw: string, options: { allowLocal?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeRefused('Not a valid address');
  }
  if (url.protocol !== 'https:' && !(options.allowLocal && url.protocol === 'http:')) {
    throw new ProbeRefused('Only https addresses are probed');
  }
  if (url.username || url.password) throw new ProbeRefused('Addresses with credentials are not probed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!options.allowLocal) {
    if (INTERNAL_HOST.test(host)) throw new ProbeRefused('Internal host names are not probed');
    if (isIP(host) && !isPublicAddress(host)) throw new ProbeRefused('Private addresses are not probed');
  }
  return url;
}

function matchesJson(body: string, expected: Record<string, unknown>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'The response was not JSON';
  }
  if (!parsed || typeof parsed !== 'object') return 'The response was not a JSON object';
  for (const [name, value] of Object.entries(expected)) {
    if (JSON.stringify((parsed as Record<string, unknown>)[name]) !== JSON.stringify(value)) {
      return `"${name}" was not the expected value`;
    }
  }
  return null;
}

const MAX_BODY = 64 * 1024;

export interface ProberOptions {
  timeoutMs?: number;
  /** Tests only: allow http and loopback so a local server can stand in. */
  allowLocal?: boolean;
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export function createProber(options: ProberOptions = {}): Prober {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const resolve = options.resolve ?? ((host: string) => dnsLookup(host, { all: true }));

  return async (target) => {
    let url: URL;
    try {
      url = parseProbeUrl(target.url, options.allowLocal ? { allowLocal: true } : {});
    } catch (err) {
      return { ok: false, host: '', status: null, latencyMs: null, error: (err as Error).message, certificateExpiresAt: null };
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const fail = (error: string): ProbeOutcome => ({ ok: false, host, status: null, latencyMs: null, error, certificateExpiresAt: null });

    let address: { address: string; family: number };
    try {
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
      if (!addresses.length) return fail('The host name did not resolve');
      // Every address must be public, so a name cannot point the probe inside the network.
      if (!options.allowLocal && !addresses.every((a) => isPublicAddress(a.address))) {
        return fail('The host resolves to a private address');
      }
      address = addresses[0]!;
    } catch {
      return fail('The host name did not resolve');
    }

    const started = Date.now();
    return new Promise<ProbeOutcome>((done) => {
      let settled = false;
      const finish = (outcome: ProbeOutcome) => {
        if (settled) return;
        settled = true;
        done(outcome);
      };
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        {
          method: 'GET',
          protocol: url.protocol,
          host,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          servername: isIP(host) ? undefined : host,
          headers: { 'user-agent': 'Patcher-Probe/1 (health check)', accept: 'application/json, */*;q=0.5' },
          timeout: timeoutMs,
          // Connect to the address that was checked, not to whatever the name resolves to next.
          lookup: (_hostname, opts, callback) => {
            // Node asks for every address when it may try several; either form gets the one checked.
            if (opts.all) callback(null, [{ address: address.address, family: address.family }]);
            else callback(null, address.address, address.family);
          },
          agent: false,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const latencyMs = Date.now() - started;
          let certificateExpiresAt: Date | null = null;
          if (url.protocol === 'https:') {
            const validTo = (response.socket as TLSSocket).getPeerCertificate().valid_to;
            const parsed = validTo ? new Date(validTo) : null;
            certificateExpiresAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
          }
          const result = (ok: boolean, error: string | null): ProbeOutcome => ({ ok, host, status, latencyMs, error, certificateExpiresAt });
          const statusOk = target.expectStatus !== undefined ? status === target.expectStatus : status < (target.failFrom ?? 500);
          if (!statusOk || !target.expectJson) {
            response.destroy();
            finish(result(statusOk, statusOk ? null : `HTTP ${status}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
              response.destroy();
              finish(result(false, 'The response was too large to check'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const mismatch = matchesJson(Buffer.concat(chunks).toString('utf8'), target.expectJson!);
            finish(result(mismatch === null, mismatch));
          });
          response.on('error', () => finish(result(false, 'The response was cut off')));
        },
      );
      request.on('timeout', () => {
        request.destroy();
        finish(fail(`No answer in ${Number((timeoutMs / 1000).toFixed(1))} s`));
      });
      request.on('error', (err: NodeJS.ErrnoException) => finish(fail(err.code ?? err.message.slice(0, 80))));
      request.end();
    });
  };
}
