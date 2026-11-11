import { describe, expect, it } from 'vitest';
import { indexTranscript } from '../src/calls/quotes.js';
import { frontmatterTitle, prepareFiles } from '../src/dealroom/files.js';
import { briefGaps, checkBrief, hasSubstance, mergeBriefs } from '../src/sales/brief.js';
import { checkType, typeHints } from '../src/sales/classify.js';
import { INVESTMENT_HEADING, assembleDraft, buildDraftInput, investmentSection, priceLineItems, pricingGaps, withInvestment } from '../src/sales/draft.js';
import { applyCheck, buildCheckInput } from '../src/sales/grounding.js';
import { cleanMarkdown, joinProposal, markdownProblems, slugify, splitProposal, stripMoney, tablesToLists } from '../src/sales/markdown.js';
import { renderProposalPdf } from '../src/sales/pdf.js';
import { applyFinding, parseEmails, penguinRule } from '../src/sales/penguin.js';
import type { CatalogItem } from '../src/sales/types.js';
import { DEFAULT_PROPOSAL_TEMPLATE } from '../src/settings/settings.js';
import { people } from './fixtures/calls.js';
import { PENGUIN, SALES_QUOTES, SALES_TEXT, briefAnswer, checkAnswer, classifyAnswer, draftAnswer, prospect } from './fixtures/sales.js';

/**
 * The rules of the sales pipeline that are plain code: what the model may not decide. Every
 * input here is made up, and no model, Slack or GitHub is involved.
 */
const index = indexTranscript(SALES_TEXT);

const catalog: CatalogItem[] = [
  { id: '1', key: 'integration', name: 'System integration', description: 'Connecting two systems.', unit: 'integration', unitPriceCents: 1_200_000, active: true },
  { id: '2', key: 'support', name: 'Support plan', description: 'Monitoring and fixes.', unit: 'month', unitPriceCents: null, active: true },
  { id: '3', key: 'audit', name: 'Process audit', description: 'A fixed review.', unit: 'fixed', unitPriceCents: 350_000, active: true },
];

describe('the Penguin rule', () => {
  const saved = [PENGUIN];
  const other = { name: 'Colleague', email: 'someone.else@penguin.example' };

  it('matches the host address as "host" and an attendee address as "attendee", ignoring case', () => {
    expect(penguinRule(saved, [{ hostEmail: 'Morgan@Penguin.Example', attendees: [prospect.jo] }])).toEqual({ outcome: 'match', reason: 'host' });
    expect(penguinRule(saved, [{ hostEmail: 'riley@agency.example', attendees: [prospect.jo, { email: PENGUIN }] }])).toEqual({ outcome: 'match', reason: 'attendee' });
  });

  it('compares the whole address: a colleague on the same domain does not mark the call', () => {
    expect(penguinRule(saved, [{ hostEmail: other.email, attendees: [prospect.jo, other] }])).toEqual({ outcome: 'no_match' });
  });

  it('counts a match on either copy of a call recorded twice, and prefers the host match', () => {
    const calendly = { hostEmail: PENGUIN, attendees: [prospect.jo] };
    const fathom = { hostEmail: 'riley@agency.example', attendees: [{ email: PENGUIN }, prospect.jo] };
    expect(penguinRule(saved, [fathom, calendly])).toEqual({ outcome: 'match', reason: 'host' });
    expect(penguinRule(saved, [fathom, { hostEmail: null, attendees: [] }])).toEqual({ outcome: 'match', reason: 'attendee' });
  });

  it('cannot be tested when no copy carries an address, and matches nothing until an address is saved', () => {
    expect(penguinRule(saved, [{ hostEmail: null, attendees: [] }, { hostEmail: null, attendees: [{ email: null }] }])).toEqual({ outcome: 'untestable' });
    expect(penguinRule([], [{ hostEmail: PENGUIN, attendees: [] }])).toEqual({ outcome: 'no_match' });
    expect(penguinRule([], [{ hostEmail: null, attendees: [] }])).toEqual({ outcome: 'no_match' });
  });

  it('reads the saved list with commas, spaces or new lines, without duplicates', () => {
    expect(parseEmails(` ${PENGUIN}, Alias@Penguin.example\n${PENGUIN}; not-an-address `)).toEqual([PENGUIN, 'alias@penguin.example']);
  });

  it('lets a later call add the mark and never remove it, and never changes what a person set', () => {
    const unknown = { isPenguin: null, reason: null, setBy: null };
    const match = { outcome: 'match', reason: 'attendee' } as const;
    const marked = applyFinding(unknown, match);
    expect(marked).toEqual({ isPenguin: true, reason: 'attendee', setBy: null });
    expect(applyFinding(marked, { outcome: 'no_match' })).toEqual(marked);
    expect(applyFinding(marked, { outcome: 'untestable' })).toEqual(marked);
    expect(applyFinding(marked, { outcome: 'match', reason: 'host' })).toEqual({ isPenguin: true, reason: 'host', setBy: null });
    expect(applyFinding({ isPenguin: true, reason: 'host', setBy: null }, match).reason).toBe('host');

    expect(applyFinding(unknown, { outcome: 'no_match' })).toEqual({ isPenguin: false, reason: null, setBy: null });
    expect(applyFinding(unknown, { outcome: 'untestable' })).toEqual(unknown);
    expect(applyFinding({ isPenguin: false, reason: null, setBy: null }, match).isPenguin).toBe(true);

    const flaggedOff = { isPenguin: false, reason: 'flagged', setBy: 'U0APPROVER' } as const;
    expect(applyFinding(flaggedOff, { outcome: 'match', reason: 'host' })).toEqual(flaggedOff);
    const flaggedOn = { isPenguin: true, reason: 'flagged', setBy: 'U0APPROVER' } as const;
    expect(applyFinding(flaggedOn, { outcome: 'no_match' })).toEqual(flaggedOn);
  });
});

describe('call type', () => {
  it('keeps a reading whose quote is in the transcript, and holds one without it below the automatic threshold', () => {
    expect(checkType(classifyAnswer('sales_discovery', 0.93), index, 0.8)).toMatchObject({ type: 'sales_discovery', confidence: 0.93, quote: SALES_QUOTES.ask, at: '00:06:55' });
    expect(checkType(classifyAnswer('sales_discovery', 0.97, 'They said they will definitely buy.'), index, 0.8)).toMatchObject({ confidence: 0.79, quote: null });
    expect(checkType(classifyAnswer('internal', 0.4, ''), index, 0.8)).toMatchObject({ type: 'internal', confidence: 0.4, quote: null });
  });

  it('builds the hints from the registry and the title words set in the UI', () => {
    const projects = [{ status: 'active', domains: ['acme.example'] }, { status: 'archived', domains: ['larkfield.example'] }] as never;
    const options = { projects, internalDomains: ['agency.example'], titlePatterns: ['intro', 'demo'], matchedProject: false };
    expect(typeHints({ title: 'Larkfield INTRO', hostEmail: people.host.email, attendees: [people.host, prospect.jo] }, options)).toEqual({
      knownClient: false,
      titleWords: ['intro'],
      matchedProject: false,
    });
    expect(typeHints({ title: 'Weekly sync', hostEmail: people.host.email, attendees: [people.host, people.dana] }, { ...options, matchedProject: true })).toEqual({
      knownClient: true,
      titleWords: [],
      matchedProject: true,
    });
  });
});

describe('the deal brief', () => {
  it('keeps a field only when its quote is in the transcript, and names what is missing as a gap', () => {
    const { brief, dropped } = checkBrief(briefAnswer() as never, index);
    expect(brief.company?.text).toBe('Larkfield Outfitters');
    expect(brief.problem).toMatchObject({ quote: SALES_QUOTES.problem, at: '00:01:10' });
    expect(brief.scope.map((s) => s.quote)).toEqual([SALES_QUOTES.sync, SALES_QUOTES.dashboard]);
    expect(brief.people.map((p) => `${p.name}/${p.side}`)).toEqual(['Jo Prospect/prospect', 'Lee Prospect/prospect', 'Morgan Host/us']);
    // The budget was quoted with words nobody said, and the timeline was left empty.
    expect(brief.budget).toBeNull();
    expect(brief.timeline).toBeNull();
    expect(dropped).toEqual(['budget: the quote is not in the transcript']);
    expect(briefGaps(brief)).toEqual(['start date', 'budget']);
    expect(hasSubstance(brief)).toBe(true);
  });

  it('has nothing to stand on when no problem, outcome or scope survives', () => {
    const invented = { text: 'Something', quote: 'Words that were never said on the call.' };
    const { brief } = checkBrief(briefAnswer({ problem: invented, outcome: invented, scope: [invented] }) as never, index);
    expect(hasSubstance(brief)).toBe(false);
  });

  it('adds a later call to what earlier calls established without erasing it', () => {
    const earlier = checkBrief(briefAnswer() as never, index).brief;
    const later = checkBrief(
      briefAnswer({ company: { text: '', quote: '' }, problem: { text: '', quote: '' }, scope: [{ text: 'A dashboard for failed orders, as a second piece.', quote: SALES_QUOTES.dashboard }], timeline: { text: 'Sign this quarter.', quote: SALES_QUOTES.ask } }) as never,
      index,
    ).brief;
    const merged = mergeBriefs(earlier, later);
    expect(merged.company?.text).toBe('Larkfield Outfitters');
    expect(merged.problem?.quote).toBe(SALES_QUOTES.problem);
    expect(merged.timeline?.quote).toBe(SALES_QUOTES.ask);
    expect(merged.scope).toHaveLength(2);
    expect(briefGaps(merged)).toEqual(['budget']);
  });
});

describe('Markdown rules', () => {
  it('removes images and raw HTML and keeps only links with allowed addresses', () => {
    const { text, removed } = cleanMarkdown(
      ['Intro ![logo](https://cdn.example/logo.png) text.', '<div onclick="x()">Hello</div>', '<!-- hidden -->', '[site](https://larkfield.example) [mail](mailto:jo@larkfield.example) [bad](javascript:alert(1)) [data](data:text/html,x)', '<https://larkfield.example/a>'].join(
        '\n\n',
      ),
    );
    expect(text).not.toMatch(/!\[|<div|<!--|javascript:|data:text|onclick/);
    expect(text).toContain('[site](https://larkfield.example)');
    expect(text).toContain('[mail](mailto:jo@larkfield.example)');
    expect(text).toContain('Hello');
    expect(text).toContain('bad');
    expect(removed.join(' ')).toMatch(/image/);
    expect(removed.join(' ')).toMatch(/HTML/);
    expect(removed.join(' ')).toMatch(/link/);
    expect(markdownProblems(text)).toEqual([]);
  });

  it('reports, independently, what a renderer would still find', () => {
    expect(markdownProblems('Fine text with a [link](https://ok.example).')).toEqual([]);
    expect(markdownProblems('An ![image](https://x.example/y.png)')).toEqual(['an image']);
    expect(markdownProblems('A <b>tag</b>')).toEqual(['raw HTML']);
    expect(markdownProblems('A [link](ftp://files.example/x)')[0]).toMatch(/a link to "ftp:/);
  });

  it('splits a proposal at its headings and joins it back unchanged', () => {
    const md = '# Title\n\nOpening words.\n\n## One\n\nBody one.\n\n### Detail\n\nMore.\n\n## Two\n\n```\n## not a heading\n```';
    const doc = splitProposal(md);
    expect(doc.title).toBe('Title');
    expect(doc.intro).toBe('Opening words.');
    expect(doc.sections.map((s) => s.heading)).toEqual(['One', 'Two']);
    expect(doc.sections[0]!.body).toContain('### Detail');
    expect(doc.sections[1]!.body).toContain('## not a heading');
    expect(splitProposal(joinProposal(doc))).toEqual(doc);
  });

  it('turns every amount of money into TBD, with or without a currency sign, and leaves other numbers alone', () => {
    const { text, count } = stripMoney('It costs $45,000 in total, or 1,500 USD per month, €2.5k up front, at most $3 million. Three phases over 6 weeks for 12 people.');
    expect(text).toBe('It costs TBD in total, or TBD per month, TBD up front, at most TBD. Three phases over 6 weeks for 12 people.');
    expect(count).toBe(4);
    expect(stripMoney('The fee is $1,200, paid monthly.').text).toBe('The fee is TBD, paid monthly.');
  });

  it('writes a table as a list and makes a file name from a heading', () => {
    const list = tablesToLists('Before\n\n| Service | Total |\n|---|---|\n| Sync | TBD |\n| Support | TBD |\n\nAfter');
    expect(list).not.toContain('|');
    expect(list).toContain('- **Sync**');
    expect(list).toContain('Before');
    expect(list).toContain('After');
    expect(slugify('Proposed approach & next steps!')).toBe('proposed-approach-next-steps');
    expect(slugify('***')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('the draft', () => {
  it('gives the model the catalog without a single price', () => {
    const brief = checkBrief(briefAnswer() as never, index).brief;
    const input = buildDraftInput({ company: 'Larkfield Outfitters', brief, gaps: briefGaps(brief), template: DEFAULT_PROPOSAL_TEMPLATE, catalog, note: 'Shorter, please.' });
    expect(input).toContain('[integration] System integration');
    expect(input).toContain('Sold per: month');
    expect(input).not.toMatch(/12,?000|3,?500|1200000|350000/);
    expect(input).toContain('<gaps>');
    expect(input).toContain('- budget');
    expect(input).toContain('<approver_note>');
  });

  it('drops the model’s own pricing section, strips money, images and HTML, and says what it changed', () => {
    const assembled = assembleDraft(draftAnswer(), { company: 'Larkfield Outfitters', catalog });
    expect(assembled.doc.sections.map((s) => s.heading)).toEqual(['Summary', 'Your situation', 'Proposed approach', 'Scope', 'Next steps']);
    const text = joinProposal(assembled.doc);
    expect(text).not.toMatch(/\$|45,000|30,000|<script|!\[/);
    expect(text).toContain('The whole engagement costs TBD.');
    expect(assembled.flags.join('\n')).toMatch(/"Pricing" section was left out/);
    expect(assembled.flags.join('\n')).toMatch(/1 amount of money/);
    expect(assembled.flags.join('\n')).toMatch(/Removed from the draft: .*image/);
    expect(assembled.flags.join('\n')).toMatch(/not in the catalog \(blockchain\)/);
    expect(assembled.lineItems.map((i) => i.key)).toEqual(['integration', 'support']);
  });

  it('prices only from the rate card: quantity times unit price, a fixed price as it is, TBD for anything unknown', () => {
    const { items, unknown } = priceLineItems(
      [
        { service: '[integration]', quantity: 2, basis: 'Two systems. It costs $99.' },
        { service: 'support', quantity: 6, basis: 'Six months.' },
        { service: 'audit', quantity: 40, basis: 'A review.' },
        { service: 'integration', quantity: 9, basis: 'A repeat.' },
        { service: 'made-up', quantity: 1, basis: '' },
      ],
      catalog,
    );
    expect(unknown).toEqual(['made-up']);
    expect(items.map((i) => [i.key, i.quantity, i.unitPriceCents, i.totalCents])).toEqual([
      ['integration', 2, 1_200_000, 2_400_000],
      ['support', 6, null, null],
      ['audit', 1, 350_000, 350_000],
    ]);
    expect(items[0]!.basis).not.toContain('$99');
    expect(pricingGaps(items, catalog.length)).toEqual(['price for Support plan']);

    const section = investmentSection(items, 'USD', catalog.length);
    expect(section).toContain('| System integration | 2 integrations | $12,000 per integration | $24,000 |');
    expect(section).toContain('| Support plan | 6 months | TBD | TBD |');
    expect(section).toContain('| Process audit | Fixed | $3,500 | $3,500 |');
    expect(section).toContain('**Total: TBD** (missing: price for Support plan)');

    const priced = priceLineItems([{ service: 'integration', quantity: 1, basis: '' }, { service: 'audit', quantity: null, basis: '' }], catalog).items;
    expect(investmentSection(priced, 'USD', catalog.length)).toContain('**Total: $15,500**');
    const unsized = priceLineItems([{ service: 'integration', quantity: null, basis: '' }], catalog).items;
    expect(pricingGaps(unsized, catalog.length)).toEqual(['quantity for System integration']);
  });

  it('says TBD and why when the rate card is empty or no service applies', () => {
    expect(investmentSection([], 'USD', 0)).toMatch(/^Pricing: TBD\. The rate card in Patcher is empty/);
    expect(pricingGaps([], 0)).toEqual(['rate card']);
    expect(investmentSection([], 'USD', 3)).toMatch(/^Pricing: TBD\. The call did not settle/);
    expect(pricingGaps([], 3)).toEqual(['pricing']);
  });

  it('puts the Investment section before the next steps', () => {
    const doc = assembleDraft(draftAnswer(), { company: 'Larkfield Outfitters', catalog }).doc;
    const full = withInvestment(doc, 'Pricing: TBD.');
    const headings = full.sections.map((s) => s.heading);
    expect(headings).toContain(INVESTMENT_HEADING);
    expect(headings.indexOf(INVESTMENT_HEADING)).toBeLessThan(headings.indexOf('Next steps'));
  });
});

describe('the grounding check', () => {
  const doc = assembleDraft(draftAnswer(), { company: 'Larkfield Outfitters', catalog }).doc;

  it('shows the checker the brief, the catalog and the draft, and no prices', () => {
    const input = buildCheckInput({ brief: checkBrief(briefAnswer() as never, index).brief, catalog, doc });
    expect(input).toContain('<brief>');
    expect(input).toContain('<draft>');
    expect(input).toContain(`said: "${SALES_QUOTES.problem}"`);
    expect(input).not.toMatch(/12,?000/);
  });

  it('removes exactly what the check points at, flags what it only doubts, and ignores an excerpt that is not there', () => {
    const result = applyCheck(doc, checkAnswer() as never);
    const text = joinProposal(result.doc);
    expect(text).not.toContain('We guarantee zero failed orders');
    expect(text).not.toContain('A mobile app for the warehouse');
    expect(text).toContain('Phase one builds the sync. Phase two adds the dashboard.');
    expect(text).toContain('- A dashboard for failed orders');
    expect(text).toContain('followed by a dashboard for failed orders');
    expect(result.removed).toBe(2);
    expect(result.ignored).toBe(1);
    expect(result.flags).toEqual([
      'Removed from "Proposed approach": "We guarantee zero failed orders after launch" (no guarantee in the brief)',
      'Removed from "Scope": "A mobile app for the warehouse" (not a scope item in the brief)',
      'Check in "Summary": "followed by a dashboard for failed orders" (the dashboard was only a possible second piece)',
    ]);
  });

  it('leaves out a section that has nothing left', () => {
    const one = { title: 'T', intro: '', sections: [{ heading: 'Promise', body: 'We guarantee zero failed orders after launch.' }, { heading: 'Scope', body: '- A sync' }] };
    const result = applyCheck(one, { issues: [{ excerpt: 'We guarantee zero failed orders after launch.', problem: 'invented', action: 'remove' }] });
    expect(result.doc.sections.map((s) => s.heading)).toEqual(['Scope']);
    expect(result.flags.at(-1)).toBe('The section "Promise" was left out: nothing in it traced to the brief.');
  });
});

describe('deal room files', () => {
  const proposal = ['# Order sync for Larkfield', '', '## Summary', '', 'A sync into billing.', '', '## Scope: phase 1 & 2', '', '- The sync', '', '## Investment', '', '| Service | Total |', '|---|---|', '| Sync | TBD |'].join('\n');

  it('writes an overview and one numbered section file per heading, each with a title line, and no table', () => {
    const prepared = prepareFiles({ slug: 'larkfield', title: 'Order sync for Larkfield', contentMd: proposal });
    expect(prepared.problems).toEqual([]);
    expect(prepared.files.map((f) => f.path)).toEqual(['overview.md', 'proposal/01-summary.md', 'proposal/02-scope-phase-1-2.md', 'proposal/03-investment.md']);
    expect(prepared.files[0]!.content).toBe('# Order sync for Larkfield\n\nA sync into billing.\n');
    expect(prepared.files[2]!.content).toBe('---\ntitle: Scope phase 1 & 2\n---\n\n- The sync\n');
    expect(prepared.files[3]!.content).not.toContain('|');
    expect(prepared.sections).toBe(3);
    // No visual file is written: their shapes are not confirmed.
    expect(prepared.files.some((f) => f.path.endsWith('.json'))).toBe(false);
  });

  it('gives the same files and the same hash for the same proposal, and another hash when a word changes', () => {
    const a = prepareFiles({ slug: 'larkfield', title: 'T', contentMd: proposal });
    const b = prepareFiles({ slug: 'larkfield', title: 'T', contentMd: proposal });
    const c = prepareFiles({ slug: 'larkfield', title: 'T', contentMd: proposal.replace('The sync', 'The sync and more') });
    expect(a.filesHash).toBe(b.filesHash);
    expect(a.filesHash).not.toBe(c.filesHash);
  });

  it('refuses content the room does not show, a bad slug, and a proposal without sections', () => {
    const image = prepareFiles({ slug: 'larkfield', title: 'T', contentMd: '# T\n\n## One\n\n![x](https://x.example/y.png)' });
    expect(image.problems.join(' ')).toMatch(/proposal\/01-one\.md: contains an image/);
    const html = prepareFiles({ slug: 'larkfield', title: 'T', contentMd: '# T\n\n## One\n\n<iframe src="https://x.example"></iframe>' });
    expect(html.problems.join(' ')).toMatch(/raw HTML/);
    expect(prepareFiles({ slug: '../etc', title: 'T', contentMd: proposal }).problems[0]).toBe('The deal room slug is not valid.');
    expect(prepareFiles({ slug: 'larkfield', title: 'T', contentMd: 'Just words.' }).problems.join(' ')).toMatch(/no sections/);
  });

  it('writes a title line any reader takes the same way', () => {
    expect(frontmatterTitle('Scope: "phase 1" #2 --- {x}')).toBe('Scope phase 1 2 --- x');
    expect(frontmatterTitle('::')).toBe('Section');
  });
});

describe('the PDF', () => {
  it('renders a proposal with headings, lists and a table to a PDF', async () => {
    const pdf = await renderProposalPdf('# Title\n\nOpening.\n\n## Scope\n\n- One\n- Two\n\n## Investment\n\n| Service | Total |\n|---|---|\n| Sync | TBD |\n\n**Total: TBD**', {
      title: 'Title',
      subtitle: 'Prepared for Larkfield Outfitters',
    });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
