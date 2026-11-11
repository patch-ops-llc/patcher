import type {
  CreatedWebhook,
  Listing,
  SourceAccount,
  TranscriptSource,
  WebhookCheck,
  WebhookDelivery,
  WebhookNotice,
} from '../../src/calls/sources/source.js';
import { SourceApiError } from '../../src/calls/sources/source.js';
import type { Attendee, NormalizedTranscript, Vendor } from '../../src/calls/types.js';
import type { Pool } from '../../src/db/pool.js';
import { addLink, createProject } from '../../src/registry/registry.js';
import type { SecretBox } from '../../src/security/sealed.js';
import { generateTokenKeyPair, loadPrivateKey, loadPublicKey, seal, secretBox } from '../../src/security/sealed.js';

/**
 * Stand-ins for Calendly and Fathom, and made-up calls. No real person, company, call or
 * key appears here: the names are invented and the domains end in `.example`.
 */
export const AGENCY = 'agency.example';
export const HOST = `morgan@${AGENCY}`;

export const people = {
  host: { name: 'Morgan Host', email: HOST, external: false } satisfies Attendee,
  teammate: { name: 'Riley Teammate', email: `riley@${AGENCY}`, external: false } satisfies Attendee,
  dana: { name: 'Dana Client', email: 'dana@acme.example', external: true } satisfies Attendee,
  sam: { name: 'Sam Client', email: 'sam@acme.example', external: true } satisfies Attendee,
  kit: { name: 'Kit Stranger', email: 'kit@unknown.example', external: true } satisfies Attendee,
};

/** A weekly sync with a made-up client, with the three kinds of request in it. */
export const ACME_LINES = [
  '[00:00:05] Morgan Host: Thanks for joining the weekly sync, shall we go through the portal items?',
  '[00:01:12] Dana Client: Yes. First, can we get a CSV export on the reports page? Finance asks for it every month.',
  '[00:02:40] Morgan Host: That is doable, we will add an export button next to the date filter.',
  '[00:04:03] Dana Client: Also the daily digest email shows the wrong time zone for our Denver office.',
  '[00:05:30] Morgan Host: Understood. I will also send Dana the staging link after this call.',
  '[00:06:10] Sam Client: We still have to decide who owns the billing export on our side.',
  '[00:07:45] Dana Client: Great, talk next week.',
];
export const ACME_TEXT = ACME_LINES.join('\n');

let counter = 0;

export function transcript(overrides: Partial<NormalizedTranscript> = {}): NormalizedTranscript {
  counter += 1;
  return {
    source: 'fathom',
    externalId: `rec-${counter}`,
    title: 'Acme weekly sync',
    startedAt: new Date('2026-11-09T16:00:00Z'),
    durationSeconds: 32 * 60,
    hostEmail: HOST,
    attendees: [people.host, people.dana, people.sam],
    text: ACME_TEXT,
    hasSpeakers: true,
    hasTimestamps: true,
    url: null,
    ...overrides,
  };
}

/** Stands in for one vendor: remembers what it was asked and answers from what a test put in it. */
export class FakeSource implements TranscriptSource {
  account: SourceAccount = { user: 'user-1', organization: 'org-1', label: 'Morgan Host' };
  /** Thrown by every call that uses the key, as the vendor does once a key is dead. */
  keyError: SourceApiError | undefined;
  webhookError: SourceApiError | undefined;
  listError: SourceApiError | undefined;
  webhooks: { key: string; url: string; scope: string; ref: string; secret: string }[] = [];
  deleted: string[] = [];
  listings: Listing[] = [];
  transcripts = new Map<string, NormalizedTranscript>();
  /** Keys the adapter was handed, to check that each connection uses its own. */
  keys: string[] = [];
  sinceSeen: Date[] = [];
  fetched: string[] = [];
  webhookNote: string | undefined;

  constructor(readonly vendor: Vendor) {}

  /** Makes a recording available to the poll and to a fetch by id. */
  add(item: NormalizedTranscript, ready = true): this {
    this.listings.push({ externalId: item.externalId, ready });
    this.transcripts.set(item.externalId, item);
    return this;
  }

  rejectKey(): void {
    this.keyError = new SourceApiError(this.vendor, 'the key was not accepted (HTTP 401)', 401);
  }

  private use(key: string): void {
    this.keys.push(key);
    if (this.keyError) throw this.keyError;
  }

  identify(key: string): Promise<SourceAccount> {
    try {
      this.use(key);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve(this.account);
  }

  createWebhook(key: string, input: { url: string; scope: 'personal' | 'team' }): Promise<CreatedWebhook> {
    if (this.webhookError) return Promise.reject(this.webhookError);
    const ref = `hook-${this.webhooks.length + 1}`;
    const secret = `made-up-signing-secret-${this.webhooks.length + 1}`;
    this.webhooks.push({ key, url: input.url, scope: input.scope, ref, secret });
    return Promise.resolve({ ref, secret, ...(this.webhookNote ? { note: this.webhookNote } : {}) });
  }

  deleteWebhook(_key: string, ref: string): Promise<void> {
    if (this.keyError) return Promise.reject(this.keyError);
    this.deleted.push(ref);
    return Promise.resolve();
  }

  /** The stand-in's "signature" is the secret itself in a header: enough to tell right from wrong. */
  verifyWebhook(input: WebhookDelivery): WebhookCheck {
    const name = this.vendor === 'fathom' ? 'webhook-signature' : 'calendly-webhook-signature';
    return input.headers[name] === input.secret ? { ok: true } : { ok: false, reason: 'bad_signature' };
  }

  readWebhook(rawBody: string): WebhookNotice {
    const body = JSON.parse(rawBody) as { kind: string; id: string; embed?: boolean };
    if (body.kind === 'deleted') return { kind: 'deleted', externalId: body.id };
    if (body.kind !== 'ready') return { kind: 'ignored', reason: 'not_a_recap' };
    const embedded = body.embed ? this.transcripts.get(body.id) : undefined;
    return { kind: 'ready', listing: { externalId: body.id, ready: true }, ...(embedded ? { transcript: embedded } : {}) };
  }

  listSince(key: string, since: Date): Promise<Listing[]> {
    try {
      this.use(key);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.sinceSeen.push(since);
    return this.listError ? Promise.reject(this.listError) : Promise.resolve(this.listings);
  }

  fetchTranscript(key: string, listing: Listing): Promise<NormalizedTranscript | null> {
    try {
      this.use(key);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.fetched.push(listing.externalId);
    return Promise.resolve(this.transcripts.get(listing.externalId) ?? null);
  }
}

let keys: { box: SecretBox; seal: (plaintext: string) => string } | undefined;

/** One made-up key pair per test process: `seal` is what the public service has, `box` what the worker has. */
export function testSecrets(): { box: SecretBox; seal: (plaintext: string) => string } {
  if (!keys) {
    const pair = generateTokenKeyPair();
    const publicKey = loadPublicKey(pair.publicKey);
    keys = { box: secretBox(loadPrivateKey(pair.privateKey)), seal: (plaintext) => seal(publicKey, plaintext) };
  }
  return keys;
}

// A made-up registry and made-up model answers for the Acme call above --------------------

export const PORTAL_REPO = 'acme-co/portal';
export const SITE_REPO = 'globex-co/site';

/** Two clients with one project each. Returns the project ids. */
export async function seedRegistry(pool: Pool, actor: string): Promise<{ acme: string; globex: string }> {
  const acme = await createProject(
    pool,
    { name: 'Acme Portal', client: 'Acme', description: 'Customer portal with reports and a daily digest.', domains: ['acme.example'], aliases: ['the portal'] },
    actor,
  );
  await addLink(pool, acme, 'repo', PORTAL_REPO, actor);
  const globex = await createProject(pool, { name: 'Globex Site', client: 'Globex', description: 'Marketing site and booking form.', domains: ['globex.example'] }, actor);
  await addLink(pool, globex, 'repo', SITE_REPO, actor);
  return { acme, globex };
}

export const QUOTES = {
  csv: 'can we get a CSV export on the reports page?',
  zone: 'the daily digest email shows the wrong time zone for our Denver office',
  staging: 'I will also send Dana the staging link after this call.',
  billing: 'We still have to decide who owns the billing export on our side.',
};

/** What the matching step is told the model said. */
export const matchAnswer = (project = 'P1', confidence = 0.93, quote = QUOTES.csv) => ({
  summary: 'Weekly sync on the portal. The client asked for a CSV export and reported a time zone bug in the digest; a staging link will be sent.',
  matches: [{ project, confidence, quote }],
});

const item = (type: string, title: string, detail: string, quote: string, draft = '', repo = '') => ({ type, title, detail, quote, repo, draft });

/** In the order a model might give them: the note is not last. */
export const suggestionsAnswer = () => ({
  suggestions: [
    item('code_change', 'Add CSV export to the reports page', 'An export button next to the date filter that downloads the current report as CSV.', QUOTES.csv),
    item('note', 'Client has not decided who owns the billing export', 'No action for us until they decide.', QUOTES.billing),
    item('code_change', 'Fix the time zone in the daily digest email', 'The digest shows times in the wrong zone for the Denver office.', QUOTES.zone),
    item(
      'client_followup',
      'Send Dana the staging link',
      'Morgan promised the staging link after the call.',
      QUOTES.staging,
      'Hi Dana, here is the staging link we talked about on the call today. Tell me if anything looks off.',
    ),
  ],
});

export const briefAnswer = () => ({
  summary: 'Add a CSV download of the current report to the reports page.',
  steps: ['Find the reports page and the query behind it.', 'Add an export button next to the date filter that downloads the rows as CSV.', 'Cover the export with a test.'],
  done_when: ['The reports page offers a CSV download of what is shown.', 'The tests pass.'],
});
