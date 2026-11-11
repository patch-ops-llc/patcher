import type { PenguinReason } from './types.js';

/**
 * The Penguin rule of design 6.4. A sales call is a Penguin deal when one of the Penguin
 * addresses saved in the UI is on the call: as the host (Calendly's host attendee, or the
 * Fathom account that recorded it) or as an attendee (any other Calendly attendee, or a
 * Fathom calendar invitee). The whole address is compared, ignoring case; a colleague on
 * the same domain does not count. A match on either copy of a call recorded twice counts.
 */
export interface CallAddresses {
  hostEmail: string | null;
  attendees: { email: string | null }[];
}

export type PenguinFinding =
  /** An address matched. */
  | { outcome: 'match'; reason: Exclude<PenguinReason, 'flagged'> }
  /** There were addresses to compare, or no Penguin address is saved: the rule says no. */
  | { outcome: 'no_match' }
  /** A Penguin address is saved, and no copy of the call carries any address to compare it with. */
  | { outcome: 'untestable' };

const norm = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();

export function parseEmails(list: string): string[] {
  return [...new Set(list.split(/[\s,;]+/).map(norm).filter((e) => e.includes('@')))];
}

export function penguinRule(saved: string[], copies: CallAddresses[]): PenguinFinding {
  const penguin = new Set(saved.map(norm).filter(Boolean));
  // Until an address is saved the rule matches nothing, and only a person's flag applies.
  if (!penguin.size) return { outcome: 'no_match' };
  let attendee = false;
  let anyAddress = false;
  for (const copy of copies) {
    const host = norm(copy.hostEmail);
    if (host) anyAddress = true;
    if (host && penguin.has(host)) return { outcome: 'match', reason: 'host' };
    for (const person of copy.attendees) {
      const email = norm(person.email);
      if (!email) continue;
      anyAddress = true;
      if (penguin.has(email)) attendee = true;
    }
  }
  if (attendee) return { outcome: 'match', reason: 'attendee' };
  return anyAddress ? { outcome: 'no_match' } : { outcome: 'untestable' };
}

export interface PenguinMark {
  isPenguin: boolean | null;
  reason: PenguinReason | null;
  setBy: string | null;
}

/**
 * What a call's finding does to the deal's mark. A person's flag is never changed by the
 * rule. A later call can add the mark and never removes it; only a person does.
 */
export function applyFinding(current: PenguinMark, finding: PenguinFinding): PenguinMark {
  if (current.reason === 'flagged') return current;
  if (finding.outcome === 'match') {
    // "host" is the stronger statement; a later attendee match does not weaken it.
    if (current.isPenguin && current.reason === 'host') return current;
    return { isPenguin: true, reason: finding.reason, setBy: null };
  }
  if (current.isPenguin) return current;
  if (finding.outcome === 'no_match') return { isPenguin: false, reason: null, setBy: null };
  return current;
}

/** How the message says why a deal is marked. */
export function penguinReasonText(reason: PenguinReason | null, setBy: string | null): string {
  if (reason === 'host') return 'held with your Penguin email';
  if (reason === 'attendee') return 'your Penguin email was on the call';
  return setBy ? `marked by <@${setBy}>` : 'marked by a person';
}
