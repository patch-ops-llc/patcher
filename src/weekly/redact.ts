/**
 * Log lines and deploy errors can hold credentials and client data. Everything the audit
 * stores, posts or sends to an agent passes through `redact` first; log lines are further
 * reduced to a signature, which keeps the shape of the message and drops its values.
 */

const SECRET_NAME =
  '(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret|signature|cookie|session(?:[_-]?id)?|auth)';

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  // scheme://user:password@host, whatever the scheme.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@[^\s"'<>]+/gi, '[connection string]'],
  [/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s"'<>]+/gi, '[connection string]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [token]'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, '[token]'],
  [
    /\b(?:xox[abeposr]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|rlwy_[a-z]+_[A-Za-z0-9]{10,}|key_[A-Za-z0-9]{20,}|pat-[a-z0-9]+-[0-9a-f-]{20,})/g,
    '[token]',
  ],
  // name=value and "name": "value" pairs whose name says the value is a credential.
  // The whole value goes, including a quoted one with spaces and one an earlier rule replaced.
  [
    new RegExp(`(${SECRET_NAME}[a-z0-9_-]*["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|\\[[a-z ]+\\]|[^\\s"',;&}\\]]{3,})`, 'gi'),
    '$1[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[opaque]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?: UTC)?\]?\s*|\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?\s*)+/;
const LEADING_NOISE =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*|\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?\s*|\[?(?:error|err|fatal|critical|warn|warning)\]?[:\s-]+)+/i;

/** A structured log line carries its text in one of a few well-known fields. */
function unwrapJson(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return message;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['msg', 'message', 'error', 'err', 'event']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
        return (value as { message: string }).message;
      }
    }
  } catch {
    // Not JSON after all; use the line as it is.
  }
  return message;
}

const MAX_SIGNATURE = 160;

/**
 * Reduces a log line to the part that stays the same between occurrences: the first line,
 * with ids, numbers, addresses, quoted text and anything `redact` catches replaced by
 * placeholders. Two lines with the same signature are the same error.
 */
export function logSignature(message: string): string {
  const firstLine =
    unwrapJson(message)
      .replace(ANSI, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const signature = redact(
    firstLine
      .replace(TIMESTAMP, '')
      // The process id Postgres and others print after the time.
      .replace(/^\[\d+\]:?\s*/, '')
      .replace(LEADING_NOISE, ''),
  )
    .replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '<str>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    // Account, order and customer numbers: letters and digits in one word, four digits or more.
    .replace(/\b(?=[a-z0-9]*[a-z])(?=(?:[a-z]*\d){4})[a-z0-9]{5,}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/g, '<date>')
    .replace(/\d+(?:[.,:]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return signature.length <= MAX_SIGNATURE ? signature : `${signature.slice(0, MAX_SIGNATURE - 1)}…`;
}

const NOT_AN_ERROR: RegExp[] = [
  // Postgres writes every level to stderr: `2026-01-01 00:00:00.000 UTC [42] LOG:  checkpoint starting`.
  /\[\d+\]\s+(?:LOG|NOTICE|INFO|DEBUG\d?|WARNING|STATEMENT|DETAIL|HINT|CONTEXT):/,
  // Redis: `1:M 01 Jan 2026 00:00:00.000 * Background saving started` (. - * are below warning).
  /^\d+:[XCSM] \d{2} \w{3} \d{4} [\d:.]+ [.*-] /,
  /^\[?(?:info|debug|trace|verbose|notice|log|warn|warning)\]?(?:[:\s-]|$)/i,
  // The level after a tag or two: "[PID: 12] [scheduler] [WARN] …".
  /^(?:\[[^\]]{1,40}\]\s*){1,3}\[(?:info|debug|trace|verbose|notice|log|warn|warning)\]/i,
  /^npm (?:notice|warn)\b/i,
  /\bdeprecat(?:ed|ion)\b/i,
];

const JSON_LEVELS = new Set(['info', 'debug', 'trace', 'verbose', 'notice', 'warn', 'warning', '10', '20', '30', '40']);

/**
 * Whether a line Railway marked as an error is one by its own account. A line with no level
 * of its own counts as an error; one that names a lower level does not.
 */
export function isErrorLine(message: string): boolean {
  const trimmed = message.replace(ANSI, '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const level = (JSON.parse(trimmed) as { level?: unknown; severity?: unknown }).level;
      if ((typeof level === 'string' || typeof level === 'number') && JSON_LEVELS.has(String(level).toLowerCase())) return false;
    } catch {
      // Not JSON; judged as text below.
    }
  }
  const line = (trimmed.split(/\r?\n/).find((l) => l.trim()) ?? '')
    .trim()
    .replace(TIMESTAMP, '')
    // A row of a printed box or banner: judged by what is inside the frame.
    .replace(/^(?:[\s\u2500-\u257f|]|\u26a0\ufe0f?)+/, '');
  return !NOT_AN_ERROR.some((pattern) => pattern.test(line));
}

/**
 * The tail of a multi-line error (a stack frame, a row of a printed table, a bracket on its
 * own line) arrives as separate lines. They say nothing by themselves, so they are not
 * findings: a signature needs at least two real words.
 */
export function isFragment(signature: string): boolean {
  // A row of a printed box. The row that names the problem is the finding; the rest explain it.
  if (/^[\u2551\u2502\u2503|].*[\u2551\u2502\u2503|]$/.test(signature.trim()) && !/\b(?:error|alarm|fatal|critical|fail(?:ed|ure)?)\b/i.test(signature)) {
    return true;
  }
  const text = signature.replace(/^[\s\u2500-\u257f|*#>=+-]+|[\s\u2500-\u257f|]+$/g, '');
  if (/^at\s/.test(text)) return true;
  // A line that ends mid-list or mid-call, or only closes one, continues another line.
  if (/[,({[]$/.test(text) || /^[)}\]]/.test(text)) return true;
  if (/^(?:read more|for more information|see|learn more)\b.{0,40}<url>\.?$/i.test(text)) return true;
  const words = text.replace(/<[a-z]+>|\[[a-z ]+\]/g, ' ').match(/[A-Za-z]{3,}/g) ?? [];
  // A few words that close more brackets than they open: the opening one was on an earlier line.
  const count = (chars: RegExp) => text.match(chars)?.length ?? 0;
  if (words.length < 4 && count(/[)}\]]/g) > count(/[({[]/g)) return true;
  return words.length < 2;
}
