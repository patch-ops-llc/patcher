/**
 * Text from outside (log lines, deploy errors, messages) can hold credentials. Everything
 * Patcher stores, posts, sends to a model or hands to an agent passes through `redact`
 * first: tokens, keys, connection strings and e-mail addresses are replaced by pattern.
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
