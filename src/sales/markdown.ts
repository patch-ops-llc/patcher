import type { Token, Tokens } from 'marked';
import { lexer, walkTokens } from 'marked';

/**
 * The rules a proposal's Markdown is held to. They are the deal room's rules (links with a
 * few schemes; no images; no raw HTML), applied to every proposal so that the same text can
 * become the room's section files without another rewrite.
 */
const ALLOWED_LINK = /^(https?:\/\/|mailto:|#|\/(?!\/))/i;

export const linkAllowed = (href: string): boolean => ALLOWED_LINK.test(href.trim());

export interface Cleaned {
  text: string;
  /** What was taken out, in words for the person reviewing. */
  removed: string[];
}

/**
 * Makes Markdown fit the rules: images become their caption, raw HTML is dropped, and a
 * link whose address is not allowed becomes its text. Applied to what the model wrote and
 * to what a person saves in the editor.
 */
export function cleanMarkdown(markdown: string): Cleaned {
  const removed = new Set<string>();
  let text = markdown.replace(/\r\n?/g, '\n');

  text = text.replace(/<!--[\s\S]*?-->/g, () => {
    removed.add('an HTML comment');
    return '';
  });
  // Images, inline and by reference: the caption stays as plain text.
  text = text.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (_m, alt: string) => {
    removed.add('an image');
    return alt;
  });
  text = text.replace(/!\[([^\]\n]*)\]\[[^\]\n]*\]/g, (_m, alt: string) => {
    removed.add('an image');
    return alt;
  });
  text = text.replace(/\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"\n]*")?\s*\)/g, (match, label: string, href: string) => {
    if (linkAllowed(href)) return match;
    removed.add('a link with an address that is not allowed');
    return label;
  });
  // Reference definitions with an address that is not allowed.
  text = text.replace(/^ {0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm, (match, href: string) => {
    if (linkAllowed(href)) return match;
    removed.add('a link with an address that is not allowed');
    return '';
  });
  // Autolinks keep their address as text; every other tag goes.
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, '$1');
  text = text.replace(/<\/?[A-Za-z][^>\n]*>/g, () => {
    removed.add('raw HTML');
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), removed: [...removed] };
}

/**
 * Reads Markdown the way a renderer would and reports what breaks the rules. Independent
 * of `cleanMarkdown`, so a file is only ever written when both agree it is clean.
 */
export function markdownProblems(markdown: string): string[] {
  const problems = new Set<string>();
  // The callback is synchronous; the returned list of its results is not needed.
  void walkTokens(lexer(markdown), (token: Token) => {
    if (token.type === 'html') problems.add('raw HTML');
    else if (token.type === 'image') problems.add('an image');
    else if (token.type === 'link' && !linkAllowed((token as Tokens.Link).href)) problems.add(`a link to "${(token as Tokens.Link).href.slice(0, 60)}"`);
  });
  return [...problems];
}

export interface ProposalDoc {
  title: string;
  /** What stands between the title and the first section. */
  intro: string;
  sections: { heading: string; body: string }[];
}

/** A proposal is one `#` title, an optional opening, and `##` sections. */
export function splitProposal(markdown: string): ProposalDoc {
  const doc: ProposalDoc = { title: '', intro: '', sections: [] };
  let current: { heading: string; lines: string[] } | null = null;
  const intro: string[] = [];
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[1] === '#' && !doc.title && !current) {
      doc.title = heading[2]!;
    } else if (heading && heading[1] === '##') {
      if (current) doc.sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
      current = { heading: heading[2]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (current) doc.sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
  doc.intro = intro.join('\n').trim();
  return doc;
}

export function joinProposal(doc: ProposalDoc): string {
  const parts = [`# ${doc.title}`];
  if (doc.intro) parts.push(doc.intro);
  for (const section of doc.sections) parts.push(`## ${section.heading}`, section.body);
  return `${parts.filter((p) => p.trim()).join('\n\n')}\n`;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/**
 * Rewrites pipe tables as lists. The deal room's renderer is known to draw headings,
 * paragraphs, lists and links; whether it draws tables is not, so its files carry none.
 */
export function tablesToLists(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i]!;
    const rule = lines[i + 1];
    if (header.includes('|') && rule !== undefined && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(rule)) {
      const names = cells(header);
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        const row = cells(lines[i]!);
        const rest = row
          .slice(1)
          .map((cell, index) => (cell ? `${names[index + 1] ?? ''}${names[index + 1] ? ': ' : ''}${cell}` : ''))
          .filter(Boolean);
        out.push(`- **${row[0] ?? ''}**${rest.length ? ` · ${rest.join(' · ')}` : ''}`);
        i += 1;
      }
      i -= 1;
      continue;
    }
    out.push(header);
  }
  return out.join('\n');
}

const MONEY =
  /(?:(?:US|CA|AU)?\$|USD\s?|EUR\s?|GBP\s?|[€£])\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|thousand|million)?\b|\b\d[\d,]*(?:\.\d+)?\s?(?:k|thousand|million)?\s?(?:dollars|usd|euros?|eur|pounds|gbp)\b/gi;

/**
 * Guardrail 4 (no invented commercial terms): an amount of money in text the model wrote
 * becomes `TBD`. Prices reach a proposal only through the Investment section, which code
 * builds from the rate card.
 */
export function stripMoney(text: string): { text: string; count: number } {
  let count = 0;
  const replaced = text.replace(MONEY, () => {
    count += 1;
    return 'TBD';
  });
  return { text: replaced, count };
}

/** A file or branch name part made from a heading: lower case, digits and dashes. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'section';
}
