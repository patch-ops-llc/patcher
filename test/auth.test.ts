import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import request from 'supertest';
import type { webcrypto } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlackOidc, OidcError } from '../src/slack/oidc.js';
import { getUser } from '../src/settings/users.js';
import { createApp } from '../src/web/app.js';
import { authorizeLogin } from '../src/web/auth.js';
import type { Harness } from './helpers.js';
import { APPROVER, HUB, OWNER, STRANGER, VIEWER, addUser, auditActions, harness, resetDb, seedPeople, testPool, webDeps } from './helpers.js';

const pool = testPool();
let h: Harness;

beforeEach(async () => {
  await resetDb(pool);
  h = harness(pool);
});
afterAll(() => pool.end());

const rules = { hubTeamId: HUB, bootstrapOwner: OWNER };
const identity = (userId: string, teamId = HUB) => ({ teamId, userId, name: 'Some Person', email: 'person@example.com' });

describe('who may sign in', () => {
  it('admits the bootstrap owner on first sign-in and records it', async () => {
    const decision = await authorizeLogin(pool, identity(OWNER), rules);
    expect(decision).toMatchObject({ ok: true, user: { slackUserId: OWNER, role: 'owner', displayName: 'Some Person' } });
    expect(await auditActions(pool)).toEqual(['user.bootstrap_owner', 'auth.login']);
  });

  it('admits people on the allowlist with the role they were given', async () => {
    await addUser(pool, APPROVER, 'approver');
    expect(await authorizeLogin(pool, identity(APPROVER), rules)).toMatchObject({ ok: true, user: { role: 'approver' } });
  });

  it('refuses a PatchOps member who is not on the allowlist', async () => {
    expect(await authorizeLogin(pool, identity(STRANGER), rules)).toEqual({ ok: false, reason: 'not_on_allowlist' });
    expect(await getUser(pool, STRANGER)).toBeNull();
    const audit = await pool.query(`SELECT actor, action, after FROM audit_log`);
    expect(audit.rows).toEqual([
      { actor: STRANGER, action: 'auth.login_denied', after: { reason: 'not_on_allowlist', teamId: HUB } },
    ]);
  });

  it('refuses any other workspace, even for a user ID that is on the allowlist', async () => {
    await addUser(pool, APPROVER, 'approver');
    for (const user of [APPROVER, OWNER]) {
      expect(await authorizeLogin(pool, identity(user, 'T0CLIENT'), rules)).toEqual({ ok: false, reason: 'wrong_workspace' });
    }
    // The bootstrap owner is not created by a sign-in from the wrong workspace.
    expect(await getUser(pool, OWNER)).toBeNull();
  });
});

type CryptoKey = webcrypto.CryptoKey;

describe('Sign in with Slack token checks', () => {
  const CLIENT_ID = 'client-123';
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  });
  afterEach(() => vi.unstubAllGlobals());

  interface TokenOptions {
    key?: CryptoKey;
    issuer?: string;
    audience?: string;
    nonce?: string;
    expiresIn?: string;
    claims?: Record<string, unknown>;
  }

  async function idToken(options: TokenOptions = {}): Promise<string> {
    return new SignJWT({
      nonce: options.nonce ?? 'nonce-1',
      name: 'Olive Owner',
      email: 'olive@example.com',
      'https://slack.com/team_id': HUB,
      'https://slack.com/user_id': OWNER,
      ...options.claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(options.issuer ?? 'https://slack.com')
      .setAudience(options.audience ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(options.key ?? privateKey);
  }

  function slackReturns(body: unknown) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body))));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const oidc = () => createSlackOidc({ clientId: CLIENT_ID, clientSecret: 'shh', teamId: HUB, keys });
  const exchange = () => oidc().exchange({ code: 'code-1', nonce: 'nonce-1', redirectUri: 'https://patcher.test/auth/slack/callback' });

  it('builds the authorize URL with the hub workspace, state and nonce', () => {
    const url = new URL(oidc().authorizeUrl({ state: 's1', nonce: 'n1', redirectUri: 'https://patcher.test/auth/slack/callback' }));
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      scope: 'openid profile email',
      client_id: CLIENT_ID,
      state: 's1',
      nonce: 'n1',
      redirect_uri: 'https://patcher.test/auth/slack/callback',
      team: HUB,
    });
  });

  it('returns the identity from a valid ID token', async () => {
    const fetchMock = slackReturns({ ok: true, id_token: await idToken() });
    expect(await exchange()).toEqual({ teamId: HUB, userId: OWNER, name: 'Olive Owner', email: 'olive@example.com' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/openid.connect.token');
    expect(String(init.body as URLSearchParams)).toContain('code=code-1');
  });

  it.each([
    ['signed by another key', { key: 'other' }],
    ['issued by someone else', { issuer: 'https://evil.example' }],
    ['meant for another app', { audience: 'another-client' }],
    ['carrying a different nonce', { nonce: 'replayed' }],
    ['already expired', { expiresIn: '-1m' }],
    ['missing the team', { claims: { 'https://slack.com/team_id': undefined } }],
  ])('refuses a token %s', async (_name, options) => {
    const { key, ...rest } = options as { key?: string } & TokenOptions;
    slackReturns({ ok: true, id_token: await idToken({ ...rest, ...(key ? { key: otherKey } : {}) }) });
    await expect(exchange()).rejects.toThrow(OidcError);
  });

  it('refuses an unsigned token', async () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const forged = `${b64({ alg: 'none' })}.${b64({
      iss: 'https://slack.com',
      aud: CLIENT_ID,
      exp: now + 300,
      nonce: 'nonce-1',
      'https://slack.com/team_id': HUB,
      'https://slack.com/user_id': OWNER,
    })}.`;
    slackReturns({ ok: true, id_token: forged });
    await expect(exchange()).rejects.toThrow(OidcError);
  });

  it('refuses when Slack rejects the code', async () => {
    slackReturns({ ok: false, error: 'invalid_code' });
    await expect(exchange()).rejects.toThrow(/invalid_code/);
  });
});

describe('control UI access', () => {
  const csrfOf = (page: string) => /name="_csrf" value="([^"]+)"/.exec(page)![1]!;

  async function signIn(app: ReturnType<typeof createApp>, deps: ReturnType<typeof webDeps>, userId: string, teamId = HUB) {
    deps.oidc.identity = { teamId, userId, name: 'Some Person', email: null };
    const agent = request.agent(app);
    await agent.get('/auth/slack').expect(302);
    const res = await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState });
    return { agent, res };
  }

  it('sends anyone without a session to the sign-in page', async () => {
    const app = createApp(webDeps(h));
    for (const path of ['/', '/approvals', '/settings', '/activity']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    await request(app).post('/pause').type('form').send({}).expect(401);
    await request(app).get('/login').expect(200);
  });

  it('signs in an allowlisted PatchOps member and shows the home page', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const { agent, res } = await signIn(createApp(deps), deps, APPROVER);
    expect(res.headers.location).toBe('/');
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('Some Person');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('marks the session cookie Secure with the __Host- prefix when served over HTTPS', async () => {
    await seedPeople(pool);
    const deps = webDeps(h, { cookies: { secret: 'test-session-secret-0123456789abcdef', secure: true } });
    deps.oidc.identity = { teamId: HUB, userId: OWNER, name: null, email: null };
    const app = createApp(deps);
    const start = await request(app).get('/auth/slack');
    const res = await request(app)
      .get('/auth/slack/callback')
      .set('Cookie', (start.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!))
      .query({ code: 'c', state: deps.oidc.lastState });
    const session = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.includes('session'))!;
    expect(session).toMatch(/^__Host-/);
    expect(session).toMatch(/; Secure/);
  });

  it('refuses a member of another workspace and a member who is not on the allowlist', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const app = createApp(deps);

    const other = await signIn(app, deps, OWNER, 'T0CLIENT');
    expect(other.res.headers.location).toBe('/login?error=wrong_workspace');
    expect((await other.agent.get('/')).headers.location).toBe('/login');

    const stranger = await signIn(app, deps, STRANGER);
    expect(stranger.res.headers.location).toBe('/login?error=not_on_allowlist');
    expect((await stranger.agent.get('/')).headers.location).toBe('/login');
    expect((await pool.query('SELECT 1 FROM sessions')).rowCount).toBe(0);
  });

  it('refuses a callback whose state does not match the one issued, or with no login in progress', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const app = createApp(deps);
    const agent = request.agent(app);
    await agent.get('/auth/slack');
    const forged = await agent.get('/auth/slack/callback').query({ code: 'c', state: 'attacker-state' });
    expect(forged.headers.location).toBe('/login?error=failed');
    const cold = await request(app).get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState });
    expect(cold.headers.location).toBe('/login?error=failed');
    expect((await pool.query('SELECT 1 FROM sessions')).rowCount).toBe(0);
  });

  it('refuses when Slack does not vouch for the sign-in', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const app = createApp(deps);
    deps.oidc.identity = null;
    const agent = request.agent(app);
    await agent.get('/auth/slack');
    const res = await agent.get('/auth/slack/callback').query({ code: 'c', state: deps.oidc.lastState });
    expect(res.headers.location).toBe('/login?error=failed');
  });

  it('refuses a session cookie that was tampered with or has expired', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const app = createApp(deps);
    const { res } = await signIn(app, deps, OWNER);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.includes('session'))!.split(';')[0]!;
    await request(app).get('/').set('Cookie', cookie).expect(200);

    const tampered = cookie.slice(0, -2) + (cookie.endsWith('aa') ? 'bb' : 'aa');
    expect((await request(app).get('/').set('Cookie', tampered)).headers.location).toBe('/login');

    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    expect((await request(app).get('/').set('Cookie', cookie)).headers.location).toBe('/login');
  });

  it('requires the CSRF token on every state-changing request', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const { agent } = await signIn(createApp(deps), deps, OWNER);
    await agent.post('/pause').type('form').send({}).expect(403);
    await agent.post('/pause').type('form').send({ _csrf: 'wrong' }).expect(403);
    expect((await pool.query(`SELECT 1 FROM settings WHERE key = 'paused'`)).rowCount).toBe(0);

    const csrf = csrfOf((await agent.get('/').expect(200)).text);
    await agent.post('/pause').type('form').send({ _csrf: csrf }).expect(303);
    expect((await pool.query(`SELECT value FROM settings WHERE key = 'paused'`)).rows[0].value).toBe(true);
  });

  it('enforces roles on the server: viewers read, approvers decide and pause, owners change settings', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const app = createApp(deps);

    const viewer = await signIn(app, deps, VIEWER);
    const viewerCsrf = csrfOf((await viewer.agent.get('/settings').expect(200)).text);
    await viewer.agent.post('/pause').type('form').send({ _csrf: viewerCsrf }).expect(403);
    await viewer.agent.post('/settings/routes/calls').type('form').send({ _csrf: viewerCsrf, channel_id: 'C0X' }).expect(403);
    await viewer.agent.post('/settings/people').type('form').send({ _csrf: viewerCsrf, slack_user_id: VIEWER, role: 'owner' }).expect(403);

    const approver = await signIn(app, deps, APPROVER);
    const approverCsrf = csrfOf((await approver.agent.get('/').expect(200)).text);
    await approver.agent.post('/pause').type('form').send({ _csrf: approverCsrf }).expect(303);
    // Resuming and settings are for owners.
    await approver.agent.post('/resume').type('form').send({ _csrf: approverCsrf }).expect(403);
    await approver.agent.post('/settings/routes/calls').type('form').send({ _csrf: approverCsrf, channel_id: 'C0X' }).expect(403);
    await approver.agent.post('/settings/switches').type('form').send({ _csrf: approverCsrf, dry_run: '1' }).expect(403);

    const owner = await signIn(app, deps, OWNER);
    const ownerCsrf = csrfOf((await owner.agent.get('/').expect(200)).text);
    await owner.agent.post('/resume').type('form').send({ _csrf: ownerCsrf }).expect(303);
    await owner.agent.post('/settings/routes/calls').type('form').send({ _csrf: ownerCsrf, channel_id: 'C0X' }).expect(303);
    expect((await pool.query(`SELECT channel_id FROM channel_routes`)).rows).toEqual([{ channel_id: 'C0X' }]);
  });

  it('applies a role change or removal to a session that is already open', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const { agent } = await signIn(createApp(deps), deps, APPROVER);
    const csrf = csrfOf((await agent.get('/').expect(200)).text);
    await addUser(pool, APPROVER, 'viewer');
    await agent.post('/pause').type('form').send({ _csrf: csrf }).expect(403);
    await pool.query('DELETE FROM users WHERE slack_user_id = $1', [APPROVER]);
    expect((await agent.get('/')).headers.location).toBe('/login');
  });

  it('ends the session on sign-out', async () => {
    await seedPeople(pool);
    const deps = webDeps(h);
    const { agent } = await signIn(createApp(deps), deps, OWNER);
    const csrf = csrfOf((await agent.get('/').expect(200)).text);
    await agent.post('/logout').type('form').send({ _csrf: csrf }).expect(303);
    expect((await agent.get('/')).headers.location).toBe('/login');
    expect((await pool.query('SELECT 1 FROM sessions')).rowCount).toBe(0);
  });

  it('says so, and admits nobody, when Sign in with Slack is not configured', async () => {
    const app = createApp(webDeps(h, { oidc: null, hubTeamId: undefined, signingSecret: undefined, modals: null }));
    const login = await request(app).get('/login').expect(200);
    expect(login.text).toContain('not configured');
    expect((await request(app).get('/auth/slack')).headers.location).toBe('/login');
    expect((await request(app).get('/auth/slack/callback').query({ code: 'c', state: 's' })).headers.location).toBe('/login?error=failed');
    expect((await request(app).get('/')).headers.location).toBe('/login');
  });
});
