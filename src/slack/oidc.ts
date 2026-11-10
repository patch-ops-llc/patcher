import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export interface SlackIdentity {
  teamId: string;
  userId: string;
  name: string | null;
  email: string | null;
}

/** Sign in with Slack (OpenID Connect). The route logic depends only on this interface. */
export interface SlackOidc {
  authorizeUrl(input: { state: string; nonce: string; redirectUri: string }): string;
  /** Exchanges the code and returns the identity from a verified ID token. Throws otherwise. */
  exchange(input: { code: string; nonce: string; redirectUri: string }): Promise<SlackIdentity>;
}

export class OidcError extends Error {}

const SLACK = 'https://slack.com';
const ISSUER = 'https://slack.com';

export interface SlackOidcOptions {
  clientId: string;
  clientSecret: string;
  /** Sent as a hint so Slack offers the hub workspace. The real check is on the ID token. */
  teamId: string;
  /** Development and test only: a local stand-in for slack.com. */
  baseUrl?: string | undefined;
  /** Test only: supply keys directly instead of fetching Slack's key set. */
  keys?: JWTVerifyGetKey;
}

const claim = (payload: Record<string, unknown>, name: string): string | null => {
  const value = payload[name];
  return typeof value === 'string' && value ? value : null;
};

export function createSlackOidc(options: SlackOidcOptions): SlackOidc {
  const base = (options.baseUrl ?? SLACK).replace(/\/+$/, '');
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${base}/openid/connect/keys`));

  return {
    authorizeUrl({ state, nonce, redirectUri }) {
      const url = new URL(`${base}/openid/connect/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        scope: 'openid profile email',
        client_id: options.clientId,
        state,
        nonce,
        redirect_uri: redirectUri,
        team: options.teamId,
      }).toString();
      return url.toString();
    },

    async exchange({ code, nonce, redirectUri }) {
      let body: { ok?: boolean; error?: string; id_token?: string };
      try {
        const res = await fetch(`${base}/api/openid.connect.token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
          signal: AbortSignal.timeout(10_000),
        });
        body = (await res.json()) as typeof body;
      } catch (err) {
        throw new OidcError('Could not reach Slack to finish sign-in', { cause: err });
      }
      if (!body.ok || !body.id_token) throw new OidcError(`Slack refused the sign-in code: ${body.error ?? 'unknown'}`);

      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(body.id_token, keys, {
          issuer: ISSUER,
          audience: options.clientId,
          algorithms: ['RS256'],
        }));
      } catch (err) {
        throw new OidcError('Slack ID token did not verify', { cause: err });
      }
      if (payload.nonce !== nonce) throw new OidcError('Slack ID token nonce does not match');

      const teamId = claim(payload, 'https://slack.com/team_id');
      const userId = claim(payload, 'https://slack.com/user_id');
      if (!teamId || !userId) throw new OidcError('Slack ID token is missing the team or user');
      return { teamId, userId, name: claim(payload, 'name'), email: claim(payload, 'email') };
    },
  };
}
