import { z } from 'zod';
import { dataBlock } from '../ai/prompts.js';
import type { TaskSpec } from '../ai/run.js';
import { redact } from '../security/redact.js';
import { cleanLine, cleanText } from '../weekly/wording.js';
import { briefText } from './brief.js';
import type { ProposalDoc } from './markdown.js';
import { cleanMarkdown, stripMoney } from './markdown.js';
import type { Brief, CatalogItem, LineItem } from './types.js';

/**
 * The proposal draft (design 6.2, step 3). The model writes the sections and names which
 * catalog services apply and how many of each. It writes no price: code builds the
 * Investment section from the rate card, and turns any amount of money the model wrote
 * anyway into `TBD` (guardrail 4).
 */
const output = z.strictObject({
  title: z.string().max(400),
  summary: z.string().max(600),
  sections: z
    .array(z.strictObject({ heading: z.string().max(300), body: z.string().max(12_000) }))
    .min(1)
    .max(12),
  line_items: z
    .array(z.strictObject({ service: z.string().max(100), quantity: z.number().nullable(), basis: z.string().max(1000) }))
    .max(25),
});
export type DraftOutput = z.infer<typeof output>;

export const DRAFT_TASK: TaskSpec<DraftOutput> = {
  feature: 'sales',
  task: 'proposal-draft',
  tool: { name: 'record_proposal', description: 'Record the drafted proposal: its sections and the catalog services it uses.' },
  schema: output,
  maxTokens: 12_000,
  effort: 'high',
};

const MAX_SECTIONS = 10;
const MAX_BODY = 6000;
const PRICING_HEADING = /\b(investment|pricing|prices?|fees?|costs?|budget|commercials?|payment)\b/i;
export const INVESTMENT_HEADING = 'Investment';

export function catalogText(catalog: CatalogItem[]): string {
  if (!catalog.length) return 'The catalog is empty.';
  return catalog
    .map((item) => `[${item.key}] ${item.name}${item.description ? `: ${item.description.replace(/\s+/g, ' ')}` : ''} Sold per: ${item.unit}.`)
    .join('\n');
}

export function buildDraftInput(input: { company: string; brief: Brief; gaps: string[]; template: string; catalog: CatalogItem[]; note: string | null }): string {
  return [
    dataBlock('prospect', `Company: ${input.company}`),
    dataBlock('brief', briefText(input.brief)),
    dataBlock('gaps', input.gaps.length ? input.gaps.map((g) => `- ${g}`).join('\n') : 'None.'),
    dataBlock('template', input.template),
    dataBlock('catalog', catalogText(input.catalog)),
    // From an approver, through Regenerate. It can ask for a different emphasis; it cannot add facts or prices.
    ...(input.note ? [dataBlock('approver_note', redact(input.note).slice(0, 1000))] : []),
    `Record the proposal by calling ${DRAFT_TASK.tool.name}.`,
  ].join('\n\n');
}

export function formatMoney(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

const cell = (text: string): string => text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const plural = (unit: string, n: number): string => (n === 1 || unit.endsWith('s') ? unit : `${unit}s`);

/** The lines the model named, priced from the rate card. A service that is not in the catalog is left out. */
export function priceLineItems(lines: DraftOutput['line_items'], catalog: CatalogItem[]): { items: LineItem[]; unknown: string[] } {
  const byKey = new Map(catalog.map((item) => [item.key, item]));
  const items: LineItem[] = [];
  const unknown: string[] = [];
  for (const line of lines) {
    const key = line.service.trim().replace(/^\[|\]$/g, '').toLowerCase();
    const entry = byKey.get(key);
    if (!entry) {
      if (key) unknown.push(key.slice(0, 40));
      continue;
    }
    if (items.some((i) => i.key === entry.key)) continue;
    const quantity = line.quantity !== null && Number.isFinite(line.quantity) && line.quantity > 0 && line.quantity <= 100_000 ? Math.round(line.quantity * 100) / 100 : null;
    const fixed = entry.unit === 'fixed';
    const effective = fixed ? 1 : quantity;
    items.push({
      key: entry.key,
      name: entry.name,
      unit: entry.unit,
      quantity: effective,
      unitPriceCents: entry.unitPriceCents,
      totalCents: effective !== null && entry.unitPriceCents !== null ? Math.round(effective * entry.unitPriceCents) : null,
      basis: stripMoney(cleanText(line.basis, 200)).text,
    });
    if (items.length === 15) break;
  }
  return { items, unknown };
}

/** What the Investment section cannot say yet, as gaps for the Slack message. */
export function pricingGaps(items: LineItem[], catalogSize: number): string[] {
  if (!catalogSize) return ['rate card'];
  if (!items.length) return ['pricing'];
  const gaps: string[] = [];
  for (const item of items) {
    if (item.unitPriceCents === null) gaps.push(`price for ${item.name}`);
    else if (item.quantity === null) gaps.push(`quantity for ${item.name}`);
  }
  return gaps;
}

/** The Investment section. Every figure in it comes from the rate card; what cannot be derived says TBD and why. */
export function investmentSection(items: LineItem[], currency: string, catalogSize: number): string {
  if (!catalogSize) return 'Pricing: TBD. The rate card in Patcher is empty, so no price can be given yet.';
  if (!items.length) return 'Pricing: TBD. The call did not settle which services from the rate card apply.';
  const rows = items.map((item) => {
    const quantity = item.unit === 'fixed' ? 'Fixed' : item.quantity === null ? 'TBD' : `${item.quantity} ${plural(item.unit, item.quantity)}`;
    const price = item.unitPriceCents === null ? 'TBD' : item.unit === 'fixed' ? formatMoney(item.unitPriceCents, currency) : `${formatMoney(item.unitPriceCents, currency)} per ${item.unit}`;
    const total = item.totalCents === null ? 'TBD' : formatMoney(item.totalCents, currency);
    return `| ${cell(item.name)} | ${quantity} | ${price} | ${total} |`;
  });
  const missing = pricingGaps(items, catalogSize);
  const total = missing.length ? `**Total: TBD** (missing: ${missing.join(', ')})` : `**Total: ${formatMoney(items.reduce((sum, i) => sum + (i.totalCents ?? 0), 0), currency)}**`;
  return ['| Service | Quantity | Unit price | Total |', '|---|---|---|---|', ...rows, '', total, '', 'Prices are from the rate card. Anything marked TBD has no price or quantity yet.'].join('\n');
}

export interface Assembled {
  title: string;
  summary: string;
  /** The sections the model wrote, cleaned. The Investment section is not among them. */
  doc: ProposalDoc;
  lineItems: LineItem[];
  flags: string[];
}

/** Turns the model's reply into a proposal that fits the rules, and says what it changed. */
export function assembleDraft(reply: DraftOutput, input: { company: string; catalog: CatalogItem[] }): Assembled {
  const flags: string[] = [];
  const title = cleanLine(stripMoney(reply.title).text, 120) || `Proposal for ${input.company}`;
  const summary = cleanLine(stripMoney(reply.summary).text, 120);

  const sections: ProposalDoc['sections'] = [];
  let moneyRemoved = 0;
  const removed = new Set<string>();
  for (const section of reply.sections) {
    const heading = cleanLine(section.heading.replace(/^#+\s*/, ''), 80);
    if (!heading) continue;
    if (PRICING_HEADING.test(heading)) {
      flags.push(`The draft's own "${heading}" section was left out: prices come only from the rate card.`);
      continue;
    }
    const cleaned = cleanMarkdown(redact(section.body).slice(0, MAX_BODY));
    cleaned.removed.forEach((r) => removed.add(r));
    const money = stripMoney(cleaned.text);
    moneyRemoved += money.count;
    // A section's own headings sit below the section heading, so they cannot start a new section.
    const body = money.text.replace(/^(#{1,2})\s+/gm, '### ').trim();
    if (!body) continue;
    sections.push({ heading, body });
    if (sections.length === MAX_SECTIONS) break;
  }
  if (moneyRemoved) flags.push(`${moneyRemoved} ${moneyRemoved === 1 ? 'amount' : 'amounts'} of money the draft wrote outside the rate card became TBD.`);
  if (removed.size) flags.push(`Removed from the draft: ${[...removed].join(', ')}.`);

  const priced = priceLineItems(reply.line_items, input.catalog);
  if (priced.unknown.length) flags.push(`The draft named services that are not in the catalog (${[...new Set(priced.unknown)].join(', ')}); they were left out.`);

  return { title, summary, doc: { title, intro: '', sections }, lineItems: priced.items, flags };
}

/** Puts the Investment section where a reader expects it: before the next steps, or last. */
export function withInvestment(doc: ProposalDoc, investment: string): ProposalDoc {
  const sections = doc.sections.filter((s) => s.heading !== INVESTMENT_HEADING);
  const at = sections.findIndex((s) => /next steps?/i.test(s.heading));
  const entry = { heading: INVESTMENT_HEADING, body: investment };
  if (at < 0) sections.push(entry);
  else sections.splice(at, 0, entry);
  return { ...doc, sections };
}
