import type { Project } from '../registry/registry.js';
import type { Attendee } from './types.js';

/**
 * Step one of matching (design 5.2): what the registry alone says about which project a
 * call belongs to. No model is involved. The model is shown these, and code uses them to
 * decide how far the model's reading can be trusted.
 */
export interface ProjectHints {
  /** Short sentences a person can read, most telling first. */
  lines: string[];
  /** A client domain or a contact matched an attendee: facts about who was on the call. */
  strong: boolean;
  /** For ordering projects when the model is not asked or gives fewer than three. */
  score: number;
}

/** Mail providers anyone can have an address at. Never a client's domain. */
const PUBLIC_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'hey.com',
  'fastmail.com',
]);

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
const domainOf = (email: string | null): string | null => {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0 ? email.slice(at + 1).toLowerCase() : null;
};

export const parseDomains = (list: string): string[] =>
  list
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

/**
 * The e-mail domains of the people on the call who are not on our side: not the host's
 * domain, not one listed as internal, not a public mail provider, and not an invitee Fathom
 * marks as internal.
 */
export function externalDomains(call: { hostEmail: string | null; attendees: Attendee[] }, internal: string[]): string[] {
  const ours = new Set([...internal, ...(domainOf(call.hostEmail) ? [domainOf(call.hostEmail)!] : [])]);
  const out = new Set<string>();
  for (const attendee of call.attendees) {
    const domain = domainOf(attendee.email);
    if (!domain || attendee.external === false || ours.has(domain) || PUBLIC_MAIL.has(domain)) continue;
    out.add(domain);
  }
  return [...out];
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How often a name appears as a whole word or phrase. Names shorter than three letters are not looked for. */
export function mentions(haystack: string, name: string): number {
  const wanted = fold(name);
  if (wanted.length < 3) return 0;
  return haystack.match(new RegExp(`(?<![a-z0-9])${escapeRe(wanted)}(?![a-z0-9])`, 'g'))?.length ?? 0;
}

export function computeHints(
  call: { title: string; hostEmail: string | null; attendees: Attendee[] },
  transcript: string,
  projects: Project[],
  internalDomains: string[],
): Map<string, ProjectHints> {
  const domains = externalDomains(call, internalDomains);
  const attendeeEmails = new Set(call.attendees.flatMap((a) => (a.email ? [a.email.toLowerCase()] : [])));
  const attendeeNames = new Set(call.attendees.flatMap((a) => (a.name ? [fold(a.name)] : [])));
  const title = fold(call.title);
  const text = fold(transcript);
  const out = new Map<string, ProjectHints>();

  for (const project of projects) {
    const lines: string[] = [];
    let score = 0;
    let strong = false;

    const clientDomains = new Set(project.domains.map((d) => d.toLowerCase().replace(/^@/, '')));
    for (const domain of domains) {
      if (!clientDomains.has(domain)) continue;
      lines.push(`An attendee's e-mail domain, ${domain}, is one of the project's client domains.`);
      score += 5;
      strong = true;
    }

    for (const link of project.links) {
      if (link.kind !== 'contact') continue;
      const contact = fold(link.externalId);
      // A contact is a name, an address, or "Name <address>".
      const address = /[^\s<>]+@[^\s<>]+/.exec(contact)?.[0] ?? null;
      const name = contact.replace(/<[^>]*>/g, '').replace(/[^\s<>]+@[^\s<>]+/g, '').trim();
      if ((address && attendeeEmails.has(address)) || (name.length >= 3 && attendeeNames.has(name))) {
        lines.push(`An attendee${name ? `, ${name},` : ''} is a listed contact of the project.`);
        score += 5;
        strong = true;
      }
    }

    const names = [...new Set([project.name, project.client, ...project.aliases].map(fold).filter((n) => n.length >= 3))];
    const inTitle = names.filter((n) => mentions(title, n) > 0);
    if (inTitle.length) {
      lines.push(`The call's title names "${inTitle[0]}".`);
      score += 3;
    }
    const said = names.map((n) => ({ name: n, times: mentions(text, n) })).filter((m) => m.times > 0);
    if (said.length) {
      const top = said.sort((a, b) => b.times - a.times)[0]!;
      lines.push(`"${top.name}" is said ${top.times === 1 ? 'once' : `${top.times} times`} in the call.`);
      score += Math.min(2, 0.5 + top.times * 0.5);
    }

    if (lines.length) out.set(project.id, { lines, strong, score });
  }
  return out;
}

/** What a correction can teach the registry (design 5.2): the outside domains on the call. */
export function teachableDomains(call: { hostEmail: string | null; attendees: Attendee[] }, internal: string[], project: Project): string[] {
  const known = new Set(project.domains.map((d) => d.toLowerCase()));
  return externalDomains(call, internal).filter((d) => !known.has(d));
}
