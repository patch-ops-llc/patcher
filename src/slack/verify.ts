import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 60 * 5;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' };

/**
 * Slack's v0 request signature: HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's
 * signing secret. The timestamp check stops a captured request from being replayed later.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string;
  nowSeconds?: number;
}): SignatureCheck {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected =
    'v0=' +
    createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:`)
      .update(rawBody)
      .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** Signs a body the way Slack does. Used by tests and the local fake Slack. */
export function signSlackRequest(signingSecret: string, timestamp: number, rawBody: string): string {
  return 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}
