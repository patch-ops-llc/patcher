import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Queryable } from '../db/pool.js';
import type { User } from '../settings/users.js';
import { getUser } from '../settings/users.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

export interface Flash {
  kind: 'ok' | 'error';
  text: string;
}

export interface Session {
  idHash: string;
  user: User;
  csrfToken: string;
}

export interface CookieSettings {
  secret: string;
  /** True when the site is served over HTTPS, which is always the case on Railway. */
  secure: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sign = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `__Host-` binds the cookie to this exact host over HTTPS; browsers refuse it otherwise. */
const cookieName = (base: string, secure: boolean) => (secure ? `__Host-${base}` : base);

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

function setCookie(res: Response, settings: CookieSettings, base: string, value: string, maxAgeMs: number): void {
  const attrs = [
    `${cookieName(base, settings.secure)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (settings.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function readSigned(req: Request, settings: CookieSettings, base: string): string | null {
  const raw = parseCookies(req.headers.cookie).get(cookieName(base, settings.secure));
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const value = raw.slice(0, dot);
  return safeEqual(raw.slice(dot + 1), sign(settings.secret, value)) ? value : null;
}

const signed = (settings: CookieSettings, value: string) => `${value}.${sign(settings.secret, value)}`;

// Sessions -------------------------------------------------------------------------------

const SESSION_COOKIE = 'patcher_session';

export async function createSession(
  db: Queryable,
  res: Response,
  settings: CookieSettings,
  slackUserId: string,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (id_hash, slack_user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)`,
    [sha256(token), slackUserId, randomBytes(32).toString('base64url'), new Date(Date.now() + SESSION_TTL_MS)],
  );
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  setCookie(res, settings, SESSION_COOKIE, signed(settings, token), SESSION_TTL_MS);
}

/**
 * Resolves the request's session. The user is read from the allowlist on every request, so
 * removing someone or changing their role takes effect at once, not at their next sign-in.
 */
export async function loadSession(db: Queryable, req: Request, settings: CookieSettings): Promise<Session | null> {
  const token = readSigned(req, settings, SESSION_COOKIE);
  if (!token) return null;
  const idHash = sha256(token);
  const { rows } = await db.query<{ slack_user_id: string; csrf_token: string }>(
    'SELECT slack_user_id, csrf_token FROM sessions WHERE id_hash = $1 AND expires_at > now()',
    [idHash],
  );
  if (!rows[0]) return null;
  const user = await getUser(db, rows[0].slack_user_id);
  return user ? { idHash, user, csrfToken: rows[0].csrf_token } : null;
}

export async function destroySession(
  db: Queryable,
  res: Response,
  settings: CookieSettings,
  session: Session | null,
): Promise<void> {
  if (session) await db.query('DELETE FROM sessions WHERE id_hash = $1', [session.idHash]);
  setCookie(res, settings, SESSION_COOKIE, '', 0);
}

export function csrfMatches(session: Session, submitted: unknown): boolean {
  return typeof submitted === 'string' && safeEqual(session.csrfToken, submitted);
}

export async function setFlash(db: Queryable, session: Session, flash: Flash): Promise<void> {
  await db.query('UPDATE sessions SET flash = $2 WHERE id_hash = $1', [session.idHash, JSON.stringify(flash)]);
}

/** Reads the one-time message left by the last form post, and clears it. */
export async function takeFlash(db: Queryable, session: Session): Promise<Flash | null> {
  const { rows } = await db.query<{ flash: Flash | null }>(
    `UPDATE sessions s SET flash = NULL FROM (SELECT id_hash, flash FROM sessions WHERE id_hash = $1) old
      WHERE s.id_hash = old.id_hash AND old.flash IS NOT NULL
      RETURNING old.flash`,
    [session.idHash],
  );
  return rows[0]?.flash ?? null;
}

// Sign-in state ----------------------------------------------------------------------------

const LOGIN_COOKIE = 'patcher_login';

export interface LoginState {
  state: string;
  nonce: string;
}

/** Remembers the `state` and `nonce` sent to Slack, so the callback can prove it is ours. */
export function beginLogin(res: Response, settings: CookieSettings): LoginState {
  const login = { state: randomBytes(24).toString('base64url'), nonce: randomBytes(24).toString('base64url') };
  const value = Buffer.from(JSON.stringify({ ...login, exp: Date.now() + LOGIN_STATE_TTL_MS })).toString('base64url');
  setCookie(res, settings, LOGIN_COOKIE, signed(settings, value), LOGIN_STATE_TTL_MS);
  return login;
}

/** Returns the stored state once; the cookie is cleared so a callback cannot be replayed. */
export function finishLogin(req: Request, res: Response, settings: CookieSettings): LoginState | null {
  const value = readSigned(req, settings, LOGIN_COOKIE);
  setCookie(res, settings, LOGIN_COOKIE, '', 0);
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LoginState> & {
      exp?: number;
    };
    if (typeof parsed.state !== 'string' || typeof parsed.nonce !== 'string') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return { state: parsed.state, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

export function statesMatch(a: string, b: unknown): boolean {
  return typeof b === 'string' && safeEqual(a, b);
}
