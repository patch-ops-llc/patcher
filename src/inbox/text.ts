import { MIN_QUOTE } from '../calls/quotes.js';
import { redact } from '../security/redact.js';
import { fold } from '../weekly/wording.js';

/** What the model calls the person whose messages are read. Their Slack name is not sent. */
export const READER_NAME = 'the owner';

export interface Names {
  users: Map<string, string>;
  readerId: string | null;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>' };

/** Slack's markup as plain words: `<@U1>` becomes a name, `<https://x|label>` becomes "label (https://x)". */
export function plainText(text: string, names: Names): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) =>
      id === names.readerId ? `@${READER_NAME}` : `@${names.users.get(id) ?? (label || 'someone')}`,
    )
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => `#${name || 'channel'}`)
    .replace(/<#[CG][A-Z0-9]+>/g, '#channel')
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]*)>/g, (_m, url: string, label: string) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/<((?:https?|mailto):[^|>\s]+)>/g, '$1')
    .replace(/&(amp|lt|gt);/g, (m) => ENTITIES[m] ?? m);
}

export interface Line {
  sender: string;
  text: string;
  at: Date;
}

const clock = (at: Date): string => at.toISOString().slice(0, 16).replace('T', ' ');

/** The conversation as the model reads it: one message per paragraph, "Name (time): words". */
export function conversation(lines: Line[], maxChars: number): string {
  const parts = lines.map((line) => `${line.sender} (${clock(line.at)} UTC): ${line.text.trim()}`);
  // The newest messages are what the item is about; the oldest are cut first.
  let total = 0;
  const kept: string[] = [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]!;
    if (kept.length && total + part.length > maxChars) {
      kept.unshift(`[… ${i + 1} earlier message${i ? 's' : ''} left out …]`);
      break;
    }
    kept.unshift(part.length > maxChars ? `${part.slice(0, maxChars - 1)}…` : part);
    total += part.length;
  }
  return kept.join('\n\n');
}

/**
 * "Evidence or nothing" for Slack (design 10.3): the words the model quotes must be in the
 * messages it was given. A whole short message counts; a part of one must be long enough
 * not to match by accident.
 */
export function quoteIn(quote: string, texts: string[]): boolean {
  const wanted = fold(quote).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (wanted.length < 2) return false;
  // The model reads the messages after redaction, so its quote may match either form.
  const forms = texts.flatMap((t) => [fold(t), fold(redact(t))]);
  return forms.some((text) => text === wanted || (wanted.length >= MIN_QUOTE && text.includes(wanted)));
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()"']+/gi;

/**
 * A drafted reply before it is shown: redacted again, with Slack's control sequences taken
 * out and any link dropped that is not in the messages being answered, so a draft can never
 * introduce an address of the model's own.
 */
export function cleanDraft(draft: string, sourceTexts: string[], max: number): string {
  const known = new Set(sourceTexts.flatMap((t) => t.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')));
  const out = redact(draft)
    .replace(/<[^>\n]{0,200}>/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(URL_IN_TEXT, (url) => (known.has(url.replace(/[.,;:!?]+$/, '')) ? url : ''))
    .replace(/@(channel|here|everyone)\b/gi, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** The first words of a message, on one line, for an item that could not be analysed. */
export function excerpt(text: string, max: number): string {
  const flat = redact(text)
    .replace(/<[^>\n]{0,200}>/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
