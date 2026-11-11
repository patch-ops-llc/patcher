import { generateKeyPairSync } from 'node:crypto';
import type { Attendee } from '../../src/calls/types.js';
import type { Pool } from '../../src/db/pool.js';
import { saveCatalogItem } from '../../src/sales/store.js';
import type { CallType } from '../../src/sales/types.js';
import { HOST, people } from './calls.js';

/**
 * A made-up sales call, made-up model answers for it, and a stand-in for GitHub's API as the
 * deal room client uses it. No real company, person, address, proposal or key appears here.
 */
export const PENGUIN = 'morgan@penguin.example';
export const DEALROOM_REPO = 'example-org/dealroom';

export const prospect = {
  jo: { name: 'Jo Prospect', email: 'jo@larkfield.example', external: true } satisfies Attendee,
  lee: { name: 'Lee Prospect', email: 'lee@larkfield.example', external: true } satisfies Attendee,
};

export const SALES_LINES = [
  '[00:00:08] Morgan Host: Thanks for making time. Tell me what is going on at Larkfield Outfitters.',
  '[00:01:10] Jo Prospect: I run operations at Larkfield Outfitters. Our orders live in a spreadsheet and get typed into the billing system by hand.',
  '[00:02:30] Jo Prospect: We want every order to reach billing on its own, with no retyping.',
  '[00:03:45] Morgan Host: So a sync from the order form into billing, and a dashboard for failed orders.',
  '[00:04:20] Jo Prospect: Yes, the sync first. A dashboard for failed orders would be the second piece.',
  '[00:05:40] Lee Prospect: It has to keep working with our current billing system, we are not replacing it.',
  '[00:06:55] Jo Prospect: We are looking for a proposal we could sign this quarter.',
  '[00:07:30] Lee Prospect: I am worried about how long the cutover takes.',
  '[00:08:15] Morgan Host: I will send a proposal by Friday.',
];
export const SALES_TEXT = SALES_LINES.join('\n');

export const SALES_QUOTES = {
  company: 'I run operations at Larkfield Outfitters.',
  problem: 'Our orders live in a spreadsheet and get typed into the billing system by hand.',
  outcome: 'We want every order to reach billing on its own, with no retyping.',
  sync: 'Yes, the sync first.',
  dashboard: 'A dashboard for failed orders would be the second piece.',
  constraint: 'It has to keep working with our current billing system, we are not replacing it.',
  ask: 'We are looking for a proposal we could sign this quarter.',
  objection: 'I am worried about how long the cutover takes.',
  next: 'I will send a proposal by Friday.',
};

/** The sales call as a source would deliver it. The host address is the agency's, not a Penguin one. */
export const salesCall = (overrides: Record<string, unknown> = {}) => ({
  title: 'Larkfield intro',
  durationSeconds: 41 * 60,
  hostEmail: HOST,
  attendees: [people.host, prospect.jo, prospect.lee],
  text: SALES_TEXT,
  ...overrides,
});

export const classifyAnswer = (type: CallType = 'sales_discovery', confidence = 0.9, quote = SALES_QUOTES.ask) => ({ type, confidence, quote });

const empty = { text: '', quote: '' };

/** The brief a model might return: budget and timeline were not covered, and one field quotes words nobody said. */
export const briefAnswer = (overrides: Record<string, unknown> = {}) => ({
  company: { text: 'Larkfield Outfitters', quote: SALES_QUOTES.company },
  people: [
    { name: 'Jo Prospect', role: 'Runs operations', side: 'prospect', quote: SALES_QUOTES.company },
    { name: 'Lee Prospect', role: '', side: 'prospect', quote: SALES_QUOTES.objection },
    { name: 'Morgan Host', role: '', side: 'us', quote: SALES_QUOTES.next },
  ],
  problem: { text: 'Orders are kept in a spreadsheet and typed into billing by hand.', quote: SALES_QUOTES.problem },
  outcome: { text: 'Every order reaches billing without retyping.', quote: SALES_QUOTES.outcome },
  scope: [
    { text: 'A sync from the order form into billing.', quote: SALES_QUOTES.sync },
    { text: 'A dashboard for failed orders, as a second piece.', quote: SALES_QUOTES.dashboard },
  ],
  constraints: [{ text: 'The current billing system stays.', quote: SALES_QUOTES.constraint }],
  timeline: empty,
  // Not in the transcript: code must drop it and name the gap.
  budget: { text: 'Around forty thousand.', quote: 'We have about forty thousand set aside for this.' },
  objections: [{ text: 'How long the cutover takes.', quote: SALES_QUOTES.objection }],
  next_steps: [{ text: 'We send a proposal by Friday.', quote: SALES_QUOTES.next }],
  ...overrides,
});

/** A draft that breaks the rules in the ways the guards exist for: a price, its own pricing section, an image, raw HTML, a service that is not in the catalog. */
export const draftAnswer = (overrides: Record<string, unknown> = {}) => ({
  title: 'Order-to-billing sync for Larkfield Outfitters',
  summary: 'Order-to-billing sync, two phases',
  sections: [
    { heading: 'Summary', body: 'Larkfield Outfitters wants every order to reach billing on its own. We propose a sync from the order form into billing, followed by a dashboard for failed orders.' },
    { heading: 'Your situation', body: 'Orders live in a spreadsheet and are typed into the billing system by hand.\n\n![chart](https://tracker.example/pixel.png)' },
    {
      heading: 'Proposed approach',
      body: 'Phase one builds the sync. Phase two adds the dashboard. We guarantee zero failed orders after launch.\n\n<script>alert(1)</script>\n\nThe whole engagement costs $45,000.',
    },
    { heading: 'Scope', body: '- A sync from the order form into billing\n- A dashboard for failed orders\n- A mobile app for the warehouse' },
    { heading: 'Pricing', body: 'Phase one: $30,000. Phase two: $15,000.' },
    { heading: 'Next steps', body: 'We send this proposal by Friday. The start date is to be confirmed.' },
  ],
  line_items: [
    { service: 'integration', quantity: 1, basis: 'The sync from the order form into billing.' },
    { service: 'support', quantity: null, basis: 'Keeping the sync running after launch.' },
    { service: 'blockchain', quantity: 2, basis: 'Not something the agency sells.' },
  ],
  ...overrides,
});

/** What the second model call points at: one claim to remove, one to flag, and one excerpt that is not in the draft. */
export const checkAnswer = () => ({
  issues: [
    { excerpt: 'We guarantee zero failed orders after launch.', problem: 'no guarantee in the brief', action: 'remove' },
    { excerpt: 'A mobile app for the warehouse', problem: 'not a scope item in the brief', action: 'remove' },
    { excerpt: 'followed by a dashboard for failed orders', problem: 'the dashboard was only a possible second piece', action: 'flag' },
    { excerpt: 'This sentence is not in the draft at all.', problem: 'nothing', action: 'remove' },
  ],
});

export const cleanCheck = () => ({ issues: [] });

/** A small made-up rate card: one unit-priced service, one monthly service without a price. */
export async function seedCatalog(pool: Pool, actor: string): Promise<void> {
  await saveCatalogItem(pool, { key: 'integration', name: 'System integration', description: 'Connecting two systems so data moves on its own.', unit: 'integration', price: '12000', active: true }, actor);
  await saveCatalogItem(pool, { key: 'support', name: 'Support plan', description: 'Monitoring and fixes after launch.', unit: 'month', price: '', active: true }, actor);
}

// GitHub, as the deal room client sees it ---------------------------------------------------

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** A key made for this test run. It signs the stand-in's app token and nothing else. */
export const APP_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

export interface GitHubCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  sha: string;
}

/**
 * Stands in for the part of GitHub's REST API the deal room client uses, for one repository.
 * It keeps branches, trees and pull requests in memory, records every request, and refuses
 * anything else with 404, so a request the client should not make fails the test.
 */
export class FakeGitHub {
  calls: GitHubCall[] = [];
  /** Files on the default branch, by path. */
  files = new Map<string, string>();
  branches = new Map<string, string>([['main', 'sha-main-1']]);
  pulls: Pull[] = [];
  tokenRequests: Record<string, unknown>[] = [];
  /** Fails the next request whose path contains the key, once, with this status. */
  failOn: { match: string; status: number; message: string } | undefined;
  private trees = new Map<string, { path: string; content: string }[]>();
  private commits = new Map<string, { tree: string; parents: string[] }>([['sha-main-1', { tree: 'tree-main', parents: [] }]]);
  private counter = 0;

  constructor(readonly repo = DEALROOM_REPO) {}

  /** What was sent with a method other than GET, apart from the token request. */
  writes(): GitHubCall[] {
    return this.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/app/'));
  }

  /** The files a branch added or changed against the default branch. */
  branchFiles(branch: string): { path: string; content: string }[] {
    const sha = this.branches.get(branch);
    const commit = sha ? this.commits.get(sha) : undefined;
    return commit ? (this.trees.get(commit.tree) ?? []) : [];
  }

  /** A branch that something other than the client pushed, with these files changed against the default branch. */
  seedBranch(name: string, files: { path: string; content: string }[]): void {
    const tree = `tree-${++this.counter}`;
    const sha = `commit-${++this.counter}`;
    this.trees.set(tree, files);
    this.commits.set(sha, { tree, parents: ['sha-main-1'] });
    this.branches.set(name, sha);
  }

  merge(number: number): void {
    const pull = this.pulls.find((p) => p.number === number)!;
    pull.state = 'closed';
    pull.merged = true;
  }

  close(number: number): void {
    this.pulls.find((p) => p.number === number)!.state = 'closed';
  }

  private pullJson(pull: Pull) {
    return {
      number: pull.number,
      html_url: `https://github.com/${this.repo}/pull/${pull.number}`,
      state: pull.state,
      merged: pull.merged,
      head: { ref: pull.head, sha: pull.sha },
      base: { ref: pull.base },
    };
  }

  fetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = `${url.pathname}${url.search}`;
    this.calls.push({ method, path, body });
    const reply = (status: number, json: unknown) => Promise.resolve(new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }));

    if (this.failOn && path.includes(this.failOn.match)) {
      const { status, message } = this.failOn;
      this.failOn = undefined;
      return reply(status, { message });
    }
    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      this.tokenRequests.push(body ?? {});
      return reply(201, { token: `stand-in-installation-token-${this.tokenRequests.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const prefix = `/repos/${this.repo}`;
    if (!url.pathname.startsWith(prefix)) return reply(404, { message: 'Not Found' });
    const rest = url.pathname.slice(prefix.length);

    if (method === 'GET') {
      if (rest === '') return reply(200, { default_branch: 'main' });
      const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
      if (ref) {
        const sha = this.branches.get(decodeURIComponent(ref[1]!));
        return sha ? reply(200, { object: { sha } }) : reply(404, { message: 'Not Found' });
      }
      const commit = /^\/git\/commits\/(.+)$/.exec(rest);
      if (commit) {
        const found = this.commits.get(commit[1]!);
        return found ? reply(200, { tree: { sha: found.tree } }) : reply(404, { message: 'Not Found' });
      }
      const contents = /^\/contents\/(.+)$/.exec(rest);
      if (contents) {
        const dir = `${contents[1]!}/`;
        const entries = new Map<string, 'file' | 'dir'>();
        for (const file of this.files.keys()) {
          if (!file.startsWith(dir)) continue;
          const [first, ...more] = file.slice(dir.length).split('/');
          entries.set(`${dir}${first}`, more.length ? 'dir' : 'file');
        }
        return entries.size ? reply(200, [...entries].map(([p, type]) => ({ path: p, type }))) : reply(404, { message: 'Not Found' });
      }
      if (rest === '/pulls') {
        const head = url.searchParams.get('head')?.split(':')[1];
        return reply(200, this.pulls.filter((p) => p.head === head).map((p) => this.pullJson(p)));
      }
      const pull = /^\/pulls\/(\d+)$/.exec(rest);
      if (pull) {
        const found = this.pulls.find((p) => p.number === Number(pull[1]));
        return found ? reply(200, this.pullJson(found)) : reply(404, { message: 'Not Found' });
      }
      const compare = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest);
      if (compare) return reply(200, { files: this.branchFiles(decodeURIComponent(compare[2]!)).map((f) => ({ filename: f.path })) });
      return reply(404, { message: 'Not Found' });
    }

    if (method === 'POST' && rest === '/git/trees') {
      const sha = `tree-${++this.counter}`;
      this.trees.set(sha, (body?.tree as { path: string; content: string }[]).map((f) => ({ path: f.path, content: f.content })));
      return reply(201, { sha });
    }
    if (method === 'POST' && rest === '/git/commits') {
      const sha = `commit-${++this.counter}`;
      this.commits.set(sha, { tree: String(body?.tree), parents: body?.parents as string[] });
      return reply(201, { sha });
    }
    if (method === 'POST' && rest === '/git/refs') {
      const name = String(body?.ref).replace(/^refs\/heads\//, '');
      if (this.branches.has(name)) return reply(422, { message: 'Reference already exists' });
      this.branches.set(name, String(body?.sha));
      return reply(201, { ref: body?.ref });
    }
    if (method === 'POST' && rest === '/pulls') {
      const head = String(body?.head);
      const sha = this.branches.get(head);
      if (!sha) return reply(422, { message: 'Validation Failed' });
      const pull: Pull = { number: 100 + this.pulls.length + 1, head, base: String(body?.base), title: String(body?.title), body: String(body?.body), state: 'open', merged: false, sha };
      this.pulls.push(pull);
      return reply(201, this.pullJson(pull));
    }
    return reply(404, { message: 'Not Found' });
  };
}
