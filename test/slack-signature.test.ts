import { describe, expect, it } from 'vitest';
import { signSlackRequest, verifySlackSignature } from '../src/slack/verify.js';

const secret = '8f742231b10e8888abcd99yyyzzz85a5';
const now = 1_700_000_000;
const body = 'token=x&team_id=T1&command=%2Fops&text=status';

const check = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({
    signingSecret: secret,
    timestamp: String(now),
    signature: signSlackRequest(secret, now, body),
    rawBody: body,
    nowSeconds: now,
    ...overrides,
  });

describe('Slack signature verification', () => {
  it('accepts a correctly signed request', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('accepts the body as raw bytes', () => {
    expect(check({ rawBody: Buffer.from(body) })).toEqual({ ok: true });
  });

  it("matches the worked example in Slack's documentation", () => {
    // https://docs.slack.dev/authentication/verifying-requests-from-slack
    const docBody =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    expect(
      verifySlackSignature({
        signingSecret: '8f742231b10e8888abcd99yyyzzz85a5',
        timestamp: '1531420618',
        signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
        rawBody: docBody,
        nowSeconds: 1531420618,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a signature made with another secret', () => {
    expect(check({ signature: signSlackRequest('other-secret', now, body) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a body changed after signing', () => {
    expect(check({ rawBody: body.replace('status', 'resume') })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a timestamp changed after signing', () => {
    expect(check({ timestamp: String(now + 1) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a replay older than five minutes', () => {
    expect(check({ nowSeconds: now + 301 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(check({ nowSeconds: now + 299 })).toEqual({ ok: true });
  });

  it('rejects a timestamp from the future', () => {
    expect(check({ nowSeconds: now - 301 })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects missing headers', () => {
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a timestamp that is not a number', () => {
    expect(check({ timestamp: '17e8' })).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects a signature of the wrong length or scheme', () => {
    expect(check({ signature: 'v0=abc' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check({ signature: signSlackRequest(secret, now, body).replace('v0=', 'v1=') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
