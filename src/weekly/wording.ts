import type { Evidence } from '../recommendations/types.js';
import { redact } from '../security/redact.js';

/**
 * Checks that code applies to text a model wrote before it is stored or shown (design 10.3).
 * The model drafts; these decide whether a draft is used. Each one is deterministic, so the
 * same draft is always accepted or always dropped.
 */

/** Whitespace and case folded, for comparing a quote with the text it claims to come from. */
export const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One line of plain text: redacted again, with markdown, mentions and control characters
 * taken out. Returns an empty string when nothing usable is left.
 */
export function cleanLine(text: string, max: number): string {
  const line = redact(text)
    // Slack's control sequences (<!channel>, <@U123>, <https://…|label>) and anything else in angle brackets.
    .replace(/<[^>\n]{0,200}>/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,:]+$/, '');
  return line.length > max ? '' : line;
}

/** Several sentences of plain text, redacted again and cut to length. */
export function cleanText(text: string, max: number): string {
  const out = redact(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const numbersIn = (text: string): string[] => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ''));

/**
 * Whether every number in a drafted line also appears in the material the draft was written
 * from. A count, a percentage or a date the model made up or mistyped fails here, and the
 * rule's wording is used instead.
 */
export function numbersGrounded(line: string, sources: string[]): boolean {
  const known = new Set(sources.flatMap(numbersIn));
  return numbersIn(line).every((n) => known.has(n));
}

const MIN_QUOTE = 12;

/**
 * "Evidence or nothing": the quote a draft gives must be text from the finding's own
 * evidence, either a whole line or a part of one long enough not to match by accident.
 */
export function quoteGrounded(quote: string, evidence: Evidence[], ruleTitle: string): boolean {
  const wanted = fold(quote);
  if (!wanted) return false;
  // The model sees evidence after redaction, so a quote may match either form.
  const lines = [ruleTitle, ...evidence.flatMap((e) => [e.quote, redact(e.quote)])].map(fold);
  return lines.some((line) => line === wanted || (wanted.length >= MIN_QUOTE && line.includes(wanted)));
}

/** Whether the text names a project other than its own. One client's line must not carry another's name. */
export function namesAnother(text: string, own: string, others: string[]): boolean {
  const haystack = fold(text);
  const mine = fold(own);
  return others.some((name) => {
    const other = fold(name);
    if (other.length < 4 || other === mine || mine.includes(other)) return false;
    return new RegExp(`(?<![a-z0-9])${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(haystack);
  });
}

const UNSAFE_STEP = /\bhttps?:\/\/|\bwww\.|\b(?:curl|wget|nc|ssh|scp)\s|\|\s*(?:sh|bash|zsh)\b|\bbase64\b/i;

/** A brief line that points the agent at the network or at a shell pipeline is dropped. */
export const safeInstruction = (text: string): boolean => !UNSAFE_STEP.test(text);
