import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { getSetting } from '../settings/settings.js';
import type { CaptureDeps, CaptureOutcome, CapturedMessage } from './capture.js';
import { receiveCaptured } from './capture.js';
import { workspaceByDomain } from './store.js';
import type { ChannelType } from './types.js';

/**
 * The backstop for workspaces the app cannot read (design 8.5, "Email backstop"). Slack
 * mails the reader about direct messages and mentions while he is away; a mail rule
 * forwards those to a private address on an inbound-mail service, which posts them here.
 * A mail becomes one captured message and takes the same path as any other.
 */
export interface InboundMail {
  messageId: string;
  from: string;
  /** The part after "+" in the address the mail was delivered to. */
  mailboxHash: string;
  subject: string;
  text: string;
  html: string;
  date: Date | null;
}

/** One inbound-mail service. Postmark is the only one built; another needs only this. */
export interface InboundProvider {
  name: string;
  parse(body: unknown): InboundMail | null;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export const postmarkInbound: InboundProvider = {
  name: 'postmark',
  parse(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    const messageId = str(b.MessageID).trim();
    const fromFull = b.FromFull && typeof b.FromFull === 'object' ? (b.FromFull as Record<string, unknown>) : {};
    const from = (str(fromFull.Email) || str(b.From)).trim().toLowerCase();
    if (!messageId || !from) return null;
    let mailboxHash = str(b.MailboxHash).trim();
    if (!mailboxHash) {
      const recipient = /\+([^@+\s]+)@/.exec(str(b.OriginalRecipient) || str(b.To));
      mailboxHash = recipient?.[1] ?? '';
    }
    const date = new Date(str(b.Date));
    return {
      messageId: messageId.slice(0, 300),
      from: (/<([^>]+)>/.exec(from)?.[1] ?? from).slice(0, 320),
      mailboxHash: mailboxHash.toLowerCase(),
      subject: str(b.Subject),
      text: str(b.TextBody),
      html: str(b.HtmlBody),
      date: Number.isNaN(date.getTime()) ? null : date,
    };
  },
};

// The forwarding address ---------------------------------------------------------------------------

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Issues the secret part of the forwarding address and withdraws the one before it. Shown once. */
export async function issueAlias(pool: Pool, actor: Actor): Promise<string> {
  const token = randomBytes(16).toString('hex');
  await withTx(pool, async (tx) => {
    await tx.query('UPDATE inbound_aliases SET revoked_at = now() WHERE revoked_at IS NULL');
    await tx.query('INSERT INTO inbound_aliases (token_hash, created_by) VALUES ($1, $2)', [hashToken(token), actor]);
    await recordAudit(tx, { actor, action: 'inbox.email.alias', target: 'forwarding address', after: { issued: true } });
  });
  return token;
}

export async function activeAlias(db: Queryable): Promise<{ id: string; createdAt: Date } | null> {
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    'SELECT id, created_at FROM inbound_aliases WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
  );
  return rows[0] ? { id: rows[0].id, createdAt: rows[0].created_at } : null;
}

export function forwardingAddress(base: string, token: string): string | null {
  const at = base.indexOf('@');
  return at > 0 ? `${base.slice(0, at)}+${token}${base.slice(at)}` : null;
}

/** The password of the HTTP Basic header the mail service sends, compared without leaking where it differs. */
export function passwordMatches(header: string | undefined, secret: string): boolean {
  const encoded = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '')?.[1];
  if (!encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const a = createHash('sha256').update(password).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

// Reading a notification mail ----------------------------------------------------------------------

// Hosts under slack.com that are not a workspace.
const NOT_A_WORKSPACE = new Set(['app', 'www', 'api', 'files', 'status', 'my', 'get', 'email', 'click', 'links', 'a', 'join', 'edgeapi', 'hooks', 'slack-redir', 'docs', 'help']);
const MESSAGE_LINK = /https:\/\/([a-z0-9][a-z0-9-]*)\.slack\.com\/(?:x-[A-Za-z0-9-]+\/)?archives\/([A-Z0-9]{3,40})(?:\/p(\d{16}))?([^\s"'<>)\]]*)/;
const ANY_WORKSPACE = /https:\/\/([a-z0-9][a-z0-9-]*)\.slack\.com\b/g;
const FOOTER =
  /^\s*(you('|’)?re receiving this|you are receiving this|to stop receiving|turn off (these )?(email )?notifications|unsubscribe|manage (your )?(email |notification )*preferences|view in the archives|made by slack|slack technologies|©|\(c\) 20\d\d|our blog\b|help cent(er|re)\b)/i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ');
}

/** Removes anything in a Slack address that signs the reader in, and everything after the path. */
const withoutSignIn = (text: string): string =>
  text.replace(/https:\/\/([a-z0-9-]+)\.slack\.com\/[^\s"'<>)\]]*/g, (url) => {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/x-[A-Za-z0-9-]+(?=\/|$)/, '');
      const thread = u.searchParams.get('thread_ts');
      return `${u.origin}${path}${thread && /^\d+\.\d+$/.test(thread) ? `?thread_ts=${thread}` : ''}`;
    } catch {
      return '';
    }
  });

export function mailBody(mail: Pick<InboundMail, 'text' | 'html'>): string {
  const source = mail.text.trim() ? mail.text : htmlToText(mail.html);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const end = lines.findIndex((line) => FOOTER.test(line));
  const kept = (end >= 0 ? lines.slice(0, end) : lines).map((line) => line.trimEnd());
  return withoutSignIn(kept.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8000);
}

export interface ParsedMail {
  domain: string | null;
  channelId: string | null;
  channelName: string | null;
  channelType: ChannelType;
  ts: string | null;
  threadTs: string | null;
  senderName: string | null;
  mentions: boolean;
  link: string | null;
  text: string;
}

const clean = (value: string | undefined): string | null => {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : null;
};

/**
 * What a notification mail says about where its message is. Slack does not publish the
 * layout of these mails, so only two things are relied on: an address under
 * `<workspace>.slack.com` names the workspace, and a link to `/archives/<channel>/p<time>`
 * names the message. The sender and the channel name are read from the subject when it has
 * a shape that is recognised; when it has not, the item simply says less.
 */
export function parseSlackMail(mail: Pick<InboundMail, 'subject' | 'text' | 'html'>): ParsedMail {
  const raw = `${mail.text}\n${mail.html}`;
  const subject = mail.subject.replace(/^\s*((fwd?|fw):\s*)+/i, '').replace(/^\s*\[slack\]\s*/i, '').trim();
  const link = MESSAGE_LINK.exec(raw);
  let domain = link?.[1] ?? null;
  if (!domain) {
    for (const m of raw.matchAll(ANY_WORKSPACE)) {
      if (!NOT_A_WORKSPACE.has(m[1]!)) {
        domain = m[1]!;
        break;
      }
    }
  }
  const channelId = link?.[2] ?? null;
  const stamp = link?.[3];
  const ts = stamp ? `${stamp.slice(0, 10)}.${stamp.slice(10)}` : null;
  const thread = /[?&]thread_ts=(\d{9,11}\.\d{1,6})/.exec(link?.[4] ?? '')?.[1] ?? null;
  const channelName = /#([\p{L}\p{N}][\p{L}\p{N}._-]{0,79})/u.exec(subject)?.[1] ?? null;
  const sender =
    /(?:messages?|dms?) from (.+?)(?: in #.*| in .*| on .*)?$/i.exec(subject)?.[1] ??
    /^(.+?) (?:mentioned you|sent you|replied|messaged you)\b/i.exec(subject)?.[1];
  const direct = channelId ? channelId.startsWith('D') : !channelName;
  return {
    domain,
    channelId,
    channelName,
    channelType: direct ? 'im' : channelId?.startsWith('G') ? 'group' : channelId ? 'channel' : 'unknown',
    ts,
    threadTs: thread,
    senderName: clean(sender),
    mentions: /\bmention/i.test(subject),
    link: domain && channelId ? `https://${domain}.slack.com/archives/${channelId}${stamp ? `/p${stamp}` : ''}` : domain ? `https://${domain}.slack.com/` : null,
    text: mailBody(mail),
  };
}

// Ingest -------------------------------------------------------------------------------------------

const senderAllowed = (from: string, allowed: string): boolean =>
  allowed
    .split(', ')
    .filter(Boolean)
    .some((entry) => (entry.startsWith('@') ? from.endsWith(entry) : from === entry));

export type MailOutcome = 'forbidden' | 'unreadable' | 'repeat' | 'not_slack' | 'no_workspace' | 'workspace_new' | CaptureOutcome;

/**
 * Takes one delivery from the mail service. The caller has checked the service's password;
 * this checks the secret part of the address. Nothing of the body is kept unless the mail
 * becomes a message, and then only as that message.
 */
export async function ingestMail(deps: CaptureDeps, provider: InboundProvider, body: unknown): Promise<{ status: number; outcome: MailOutcome }> {
  const mail = provider.parse(body);
  if (!mail) return { status: 200, outcome: 'unreadable' };
  const alias = await deps.pool.query<{ id: string }>('SELECT id FROM inbound_aliases WHERE token_hash = $1 AND revoked_at IS NULL', [
    hashToken(mail.mailboxHash),
  ]);
  // 403 tells the mail service to stop retrying.
  if (!mail.mailboxHash || !alias.rows[0]) return { status: 403, outcome: 'forbidden' };

  const record = async (outcome: string, extra: { workspaceId?: string | null; parsedOk?: boolean; keepSubject?: boolean } = {}): Promise<boolean> => {
    const { rowCount } = await deps.pool.query(
      `INSERT INTO inbound_emails (message_id, alias, workspace_id, parsed_ok, outcome, sender, subject) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (message_id) DO NOTHING`,
      [
        mail.messageId,
        alias.rows[0]!.id,
        extra.workspaceId ?? null,
        extra.parsedOk ?? false,
        outcome,
        mail.from,
        extra.keepSubject ? mail.subject.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      ],
    );
    return (rowCount ?? 0) > 0;
  };
  const seen = await deps.pool.query('SELECT 1 FROM inbound_emails WHERE message_id = $1', [mail.messageId]);
  if (seen.rowCount) return { status: 200, outcome: 'repeat' };

  // Mail from anyone else is not read. Its subject is kept for a few days, because that is
  // where a mail provider puts the code that confirms a forwarding rule.
  if (!senderAllowed(mail.from, await getSetting(deps.pool, 'inbox.email_senders'))) {
    await record('not_slack', { keepSubject: true });
    return { status: 200, outcome: 'not_slack' };
  }
  const parsed = parseSlackMail(mail);
  if (!parsed.domain) {
    await record('no_workspace');
    return { status: 200, outcome: 'no_workspace' };
  }
  let workspace = await workspaceByDomain(deps.pool, parsed.domain);
  if (!workspace) {
    // A workspace is opted in by a person (design 8.3). Until then its mail is not read.
    await deps.pool.query(
      `INSERT INTO slack_workspaces (domain, name, enabled, read_mode, status) VALUES ($1, $1, false, 'email_only', 'new')
       ON CONFLICT (domain) DO NOTHING`,
      [parsed.domain],
    );
    workspace = await workspaceByDomain(deps.pool, parsed.domain);
    await record('workspace_new', { workspaceId: workspace?.id ?? null });
    return { status: 200, outcome: 'workspace_new' };
  }

  const message: CapturedMessage = {
    workspaceId: workspace.id,
    source: 'email',
    channelId: parsed.channelId,
    channelName: parsed.channelName,
    channelType: parsed.channelType,
    ts: parsed.ts,
    threadTs: parsed.threadTs,
    senderId: null,
    senderName: parsed.senderName,
    text: parsed.text,
    link: parsed.link,
    own: false,
    // Slack mails the reader only about what is addressed to him: a direct message, a mention, a keyword of his.
    mentionsReader: true,
    origin: 'person',
    sentAt: mail.date && mail.date.getTime() <= Date.now() + 60_000 ? mail.date : new Date(),
  };
  const outcome = await receiveCaptured(deps, message);
  await record(outcome, { workspaceId: workspace.id, parsedOk: Boolean(parsed.channelId || parsed.senderName) });
  return { status: 200, outcome };
}

export interface MailLogEntry {
  outcome: string;
  sender: string | null;
  subject: string | null;
  workspaceId: string | null;
  parsedOk: boolean;
  receivedAt: Date;
}

export async function recentMail(db: Queryable, limit = 15): Promise<MailLogEntry[]> {
  const { rows } = await db.query<{ outcome: string; sender: string | null; subject: string | null; workspace_id: string | null; parsed_ok: boolean; received_at: Date }>(
    'SELECT outcome, sender, subject, workspace_id, parsed_ok, received_at FROM inbound_emails ORDER BY received_at DESC LIMIT $1',
    [limit],
  );
  return rows.map((r) => ({ outcome: r.outcome, sender: r.sender, subject: r.subject, workspaceId: r.workspace_id, parsedOk: r.parsed_ok, receivedAt: r.received_at }));
}
