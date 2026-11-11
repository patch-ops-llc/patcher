import { ModelApiError } from '../ai/client.js';
import type { GateReason } from '../ai/gate.js';
import { GATE_DETAIL, salesModelGate } from '../ai/gate.js';
import { costUsd, estimateTokens } from '../ai/models.js';
import { loadPrompt } from '../ai/prompts.js';
import type { ModelDeps, TaskSpec } from '../ai/run.js';
import { ModelOutputError, callModel } from '../ai/run.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import { externalDomains, parseDomains } from '../calls/hints.js';
import { capTranscript, indexTranscript } from '../calls/quotes.js';
import { onCallAnalysed } from '../calls/seam.js';
import { getCall, listMatches, listTranscripts, preferredTranscript } from '../calls/store.js';
import type { Attendee, Call } from '../calls/types.js';
import type { Pool, PoolClient } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { listProjects } from '../registry/registry.js';
import { getAllSettings, getSetting } from '../settings/settings.js';
import { clip } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { BRIEF_TASK, briefGaps, buildBriefInput, checkBrief, hasSubstance, mergeBriefs } from './brief.js';
import { CLASSIFY_TASK, buildClassifyInput, checkType, parsePatterns, typeHints } from './classify.js';
import { DRAFT_TASK, INVESTMENT_HEADING, assembleDraft, buildDraftInput, investmentSection, pricingGaps, withInvestment } from './draft.js';
import { CHECK_TASK, applyCheck, buildCheckInput } from './grounding.js';
import { cleanMarkdown, joinProposal } from './markdown.js';
import { renderProposalPdf } from './pdf.js';
import { applyFinding, parseEmails, penguinRule } from './penguin.js';
import { getDeal, getSalesCall, insertProposal, listCatalog, setSalesState } from './store.js';
import type { Brief, Contact, Deal, DealRow, ProposalRow, SalesCallRow, SalesStep } from './types.js';
import { EMPTY_BRIEF, dealFromRow, isSalesType, salesCallFromRow } from './types.js';

/**
 * The sales pipeline (design section 6), attached to the call pipeline through its seam:
 *
 *   sales.classify   what kind of call was it → nothing, "Sales call?" in Slack, or a draft
 *   sales.draft      deal brief → proposal draft → grounding check → PDF → the sales message
 *
 * As everywhere, the model drafts and classifies and nothing it returns starts an action.
 * Code checks every quote against the transcript, takes prices only from the rate card, and
 * the finished proposal waits for a person: approving it is a recommendation in the shared
 * loop. When a step cannot run (paused, no key, switched off, over budget, provider down)
 * the call waits and is picked up again by the poll schedule and after a resume.
 */
type HoldReason = GateReason | 'off' | 'provider';

const HOLD_DETAIL: Record<HoldReason, string> = {
  ...GATE_DETAIL,
  off: 'sales calls are switched off in Settings',
  provider: 'the model provider did not answer',
};

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

let seamRegistered = false;

/** Attaches sales detection to the call pipeline. Once per process, however often it is called. */
export function registerSalesSeam(): void {
  if (seamRegistered) return;
  seamRegistered = true;
  onCallAnalysed(async (deps, call) => {
    if (call.status === 'deleted' || !(await getSetting(deps.pool, 'sales.enabled'))) return;
    await deps.queue.enqueue('sales.classify', { callId: call.id });
  });
}

/** One job at a time per call. `busy` when another process holds it. */
async function withSalesLock<T>(pool: Pool, callId: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const session = await pool.connect();
  let locked = false;
  try {
    const got = await session.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('sales:' || $1, 0)) AS locked`, [callId]);
    locked = got.rows[0]?.locked === true;
    if (!locked) return 'busy';
    return await fn();
  } finally {
    if (locked) await session.query(`SELECT pg_advisory_unlock(hashtextextended('sales:' || $1, 0))`, [callId]).catch(() => undefined);
    session.release();
  }
}

type Asked<T> = { ok: true; value: T } | { ok: false; hold: HoldReason; detail?: string } | { ok: false; failed: string };

/** One gated model call: the switch and the budget first, then the provider, with both ways of failing sorted. */
async function ask<T>(deps: WorkerDeps, callId: string, spec: TaskSpec<T>, model: string, user: string, typicalOutputTokens: number): Promise<Asked<T>> {
  const inputTokens = estimateTokens(loadPrompt(spec.task).system) + estimateTokens(user);
  const estimate = costUsd(model, { inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: typicalOutputTokens }) ?? 0;
  const gate = await salesModelGate({ pool: deps.pool, client: deps.integrations.model }, estimate);
  if (!gate.ok) return { ok: false, hold: gate.reason };
  const modelDeps: ModelDeps = { pool: deps.pool, client: gate.client, log: deps.log };
  try {
    return { ok: true, value: await callModel(modelDeps, spec, { model, runId: callId }, user) };
  } catch (err) {
    // Nothing is used from a reply that failed validation twice (design 13.1).
    if (err instanceof ModelOutputError) return { ok: false, failed: err.message };
    if (err instanceof ModelApiError) return { ok: false, hold: 'provider', detail: `the model provider did not answer (${reasonOf(err)})` };
    throw err;
  }
}

/**
 * Makes the call wait. `expectedVersion` is the version the running step started from: when a
 * person has changed the call since, the step's outcome no longer matters and nothing is written.
 */
async function hold(
  deps: WorkerDeps,
  callId: string,
  step: SalesStep,
  expectedVersion: number | null,
  reason: HoldReason,
  detail?: string,
): Promise<'held' | 'superseded'> {
  const held = await withTx(deps.pool, async (tx) => {
    const { rows } = await tx.query<{ state: string; held_step: string | null; version: number; hold_reason: string | null }>(
      'SELECT state, held_step, version, hold_reason FROM sales_calls WHERE call_id = $1 FOR UPDATE',
      [callId],
    );
    const row = rows[0];
    if (expectedVersion === null ? row && !(row.state === 'held' && row.held_step === 'classify') : row?.version !== expectedVersion) return null;
    await setSalesState(tx, callId, { state: 'held', holdReason: reason, heldStep: step, detail: `Waiting: ${detail ?? HOLD_DETAIL[reason]}.` });
    if (step === 'draft') await deps.queue.enqueue('sales.post', { callId }, { tx });
    return { first: row?.hold_reason !== 'budget' };
  });
  if (!held) return 'superseded';
  if (reason === 'budget' && held.first) {
    // One notice when the budget first stops a sales call, not one per call.
    const waiting = await deps.pool.query(`SELECT 1 FROM sales_calls WHERE state = 'held' AND hold_reason = 'budget' LIMIT 2`);
    if (waiting.rowCount === 1) await notifyOps(deps, 'Sales calls are waiting: the model budget for sales is used up. Raise it in Settings, or wait for the window to pass.');
  }
  return 'held';
}

export type ClassifyOutcome = 'not_found' | 'skipped' | 'off' | 'held' | 'superseded' | 'failed' | 'not_sales' | 'asked' | 'drafting' | 'busy';

export async function classifyCall(deps: WorkerDeps, callId: string): Promise<ClassifyOutcome> {
  const outcome = await withSalesLock(deps.pool, callId, () => classifyLocked(deps, callId));
  if (outcome === 'busy') await deps.queue.enqueue('sales.classify', { callId }, { startAfter: 30 });
  return outcome;
}

async function classifyLocked(deps: WorkerDeps, callId: string): Promise<ClassifyOutcome> {
  const call = await getCall(deps.pool, callId);
  if (!call) return 'not_found';
  if (call.status === 'deleted') return 'skipped';
  const settings = await getAllSettings(deps.pool);
  if (!settings['sales.enabled']) return 'off';
  // Classified already, or a person has said what it is: neither is asked of the model again.
  const existing = await getSalesCall(deps.pool, callId);
  if (existing && !(existing.state === 'held' && existing.heldStep === 'classify')) return 'skipped';
  // Read before, and found not to be a sales call: the seam can fire again for a call that waited.
  if (!existing && call.callType) return 'skipped';
  const transcript = await preferredTranscript(deps.pool, callId);
  if (!transcript?.text) return 'skipped';

  const projects = await listProjects(deps.pool);
  const matched = (await listMatches(deps.pool, callId)).some((m) => m.state === 'matched');
  const hints = typeHints(call, {
    projects,
    internalDomains: parseDomains(settings['calls.internal_domains']),
    titlePatterns: parsePatterns(settings['sales.title_patterns']),
    matchedProject: matched,
  });
  const capped = capTranscript(transcript.text, settings['ai.calls.transcript_token_cap']);
  const asked = await ask(deps, callId, CLASSIFY_TASK, settings['ai.sales.model_classify'], buildClassifyInput(call, hints, capped.text), 150);
  if (!asked.ok) {
    if ('failed' in asked) {
      deps.log.warn('call type not read', { callId, reason: asked.failed });
      return 'failed';
    }
    // With no key or the model switched off, nothing is classified and nothing queues up; a person can still mark the call by hand.
    if (asked.hold === 'not_configured' || asked.hold === 'disabled') return 'off';
    return hold(deps, callId, 'classify', null, asked.hold, asked.detail);
  }
  const auto = settings['ai.sales.auto_confidence'];
  const checked = checkType(asked.value, indexTranscript(transcript.text), auto);
  const sales = isSalesType(checked.type);

  return withTx(deps.pool, async (tx): Promise<ClassifyOutcome> => {
    const current = await tx.query<{ status: string }>('SELECT status FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    if (!current.rows[0] || current.rows[0].status === 'deleted') return 'skipped';
    const row = await tx.query<{ state: string; held_step: string | null }>('SELECT state, held_step FROM sales_calls WHERE call_id = $1 FOR UPDATE', [callId]);
    // A person marked the call while the model was reading.
    if (row.rows[0] && !(row.rows[0].state === 'held' && row.rows[0].held_step === 'classify')) return 'skipped';
    await tx.query('UPDATE calls SET call_type = $2, call_type_conf = $3, updated_at = now() WHERE id = $1', [callId, checked.type, checked.confidence]);
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'call.classify',
      target: callId,
      after: { type: checked.type, confidence: checked.confidence, quoted: checked.quote !== null, hints },
    });
    if (!sales || checked.confidence < settings['ai.sales.ask_confidence']) {
      await tx.query(`DELETE FROM sales_calls WHERE call_id = $1 AND state = 'held'`, [callId]);
      return 'not_sales';
    }
    if (checked.confidence >= auto) {
      await setSalesState(tx, callId, { state: 'drafting' });
      await deps.queue.enqueue('sales.draft', { callId }, { tx });
      return 'drafting';
    }
    await setSalesState(tx, callId, { state: 'asked', detail: `This looks like a sales call (${checked.confidence.toFixed(2)}). Draft a proposal from it?` });
    await deps.queue.enqueue('sales.post', { callId }, { tx });
    return 'asked';
  });
}

const domainOf = (email: string | null): string | null => {
  const at = email ? email.lastIndexOf('@') : -1;
  return email && at > 0 ? email.slice(at + 1).toLowerCase() : null;
};

/** The prospect's e-mail domain: the outside domain most people on the call share. Never ours, a Penguin address's, or a public mail provider's. */
export function prospectDomain(call: { hostEmail: string | null; attendees: Attendee[] }, internal: string[], penguinEmails: string[]): string | null {
  const ours = [...internal, ...penguinEmails.flatMap((e) => domainOf(e) ?? [])];
  const outside = new Set(externalDomains(call, ours));
  const counts = new Map<string, number>();
  for (const attendee of call.attendees) {
    const domain = domainOf(attendee.email);
    if (domain && outside.has(domain)) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

const companyKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|sa|bv|ag)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function findDeal(tx: PoolClient, input: { dealId: string | null; domain: string | null; company: string | null }): Promise<Deal | null> {
  if (input.dealId) {
    const known = await getDeal(tx, input.dealId);
    if (known) return known;
  }
  if (input.domain) {
    const { rows } = await tx.query<DealRow>('SELECT * FROM deals WHERE domain = $1 ORDER BY created_at LIMIT 1', [input.domain]);
    if (rows[0]) return dealFromRow(rows[0]);
  }
  const key = input.company ? companyKey(input.company) : '';
  if (key) {
    const { rows } = await tx.query<DealRow>('SELECT * FROM deals ORDER BY created_at LIMIT 500');
    // A name alone joins a call to a deal only when the deal has no domain to contradict it.
    const same = rows.find((r) => companyKey(r.company) === key && (!r.domain || !input.domain));
    if (same) return dealFromRow(same);
  }
  return null;
}

/** The prospect's people the calls named, with an address where an attendee of that name carried one. */
function contactsFrom(brief: Brief, call: Call, domain: string | null, existing: Contact[]): Contact[] {
  const out = [...existing];
  for (const person of brief.people) {
    if (person.side === 'us') continue;
    const first = person.name.toLowerCase().split(/\s+/)[0] ?? '';
    const attendee = call.attendees.find((a) => a.name && a.name.toLowerCase().split(/\s+/)[0] === first && (!domain || domainOf(a.email) === domain));
    const at = out.findIndex((c) => c.name.toLowerCase() === person.name.toLowerCase());
    const contact = { name: person.name, role: person.role, email: attendee?.email ?? (at >= 0 ? out[at]!.email : null) };
    if (at >= 0) out[at] = contact;
    else out.push(contact);
  }
  return out.slice(0, 12);
}

export type DraftOutcome = 'not_found' | 'skipped' | 'held' | 'failed' | 'drafted' | 'superseded' | 'busy';

export async function draftProposal(deps: WorkerDeps, callId: string): Promise<DraftOutcome> {
  const outcome = await withSalesLock(deps.pool, callId, () => draftLocked(deps, callId));
  if (outcome === 'busy') await deps.queue.enqueue('sales.draft', { callId }, { startAfter: 30 });
  return outcome;
}

async function fail(deps: WorkerDeps, callId: string, version: number, reason: string): Promise<'failed' | 'superseded'> {
  const updated = await deps.pool.query(
    `UPDATE sales_calls SET state = 'failed', detail = $2, hold_reason = NULL, held_step = NULL, version = version + 1, updated_at = now()
      WHERE call_id = $1 AND version = $3 AND state IN ('drafting', 'held')`,
    [callId, clip(reason, 300), version],
  );
  if (!updated.rowCount) return 'superseded';
  deps.log.warn('proposal draft failed', { callId, reason });
  await deps.queue.enqueue('sales.post', { callId });
  return 'failed';
}

async function draftLocked(deps: WorkerDeps, callId: string): Promise<DraftOutcome> {
  const started = await getSalesCall(deps.pool, callId);
  if (!started) return 'not_found';
  const waiting = started.state === 'drafting' || (started.state === 'held' && started.heldStep === 'draft');
  if (!waiting) return 'skipped';
  const call = await getCall(deps.pool, callId);
  if (!call) return 'not_found';
  if (call.status === 'deleted') return 'skipped';
  const settings = await getAllSettings(deps.pool);
  if (!settings['sales.enabled']) return hold(deps, callId, 'draft', started.version, 'off');
  // From here the row is in `drafting`; `version` tells a later step whether a person stepped in meanwhile.
  let sales = started;
  if (started.state === 'held') {
    const resumed = await deps.pool.query<SalesCallRow>(
      `UPDATE sales_calls SET state = 'drafting', detail = NULL, hold_reason = NULL, held_step = NULL, version = version + 1, updated_at = now()
        WHERE call_id = $1 AND version = $2 RETURNING *`,
      [callId, started.version],
    );
    if (!resumed.rows[0]) return 'superseded';
    sales = salesCallFromRow(resumed.rows[0]);
    await deps.queue.enqueue('sales.post', { callId });
  }
  const wait = (asked: { hold: HoldReason; detail?: string }) => hold(deps, callId, 'draft', sales.version, asked.hold, asked.detail);

  const transcript = await preferredTranscript(deps.pool, callId);
  if (!transcript?.text) return fail(deps, callId, sales.version, 'The transcript text is no longer stored, so no proposal can be drafted from this call.');
  const index = indexTranscript(transcript.text);
  const capped = capTranscript(transcript.text, settings['ai.calls.transcript_token_cap']);
  const internal = parseDomains(settings['calls.internal_domains']);
  const penguinEmails = parseEmails(settings['sales.penguin_emails']);
  const domain = prospectDomain(call, internal, penguinEmails);

  // What earlier calls with the same prospect established, when the deal is already known.
  const known = await withTx(deps.pool, (tx) => findDeal(tx, { dealId: sales.dealId, domain, company: null }));
  const earlier = known ? await earlierBrief(deps.pool, known.id, callId) : null;

  // 1. The deal brief, every field checked against the transcript.
  const briefed = await ask(deps, callId, BRIEF_TASK, settings['ai.sales.model_brief'], buildBriefInput(call, capped.text, earlier), 1500);
  if (!briefed.ok) return 'failed' in briefed ? fail(deps, callId, sales.version, briefed.failed) : wait(briefed);
  const checked = checkBrief(briefed.value, index);
  if (checked.dropped.length) deps.log.info('brief fields not used', { callId, dropped: checked.dropped });
  const brief = mergeBriefs(earlier, checked.brief);
  if (!hasSubstance(brief)) {
    return fail(deps, callId, sales.version, 'The call gave nothing a proposal could stand on: no problem, outcome or scope with words from the call behind it.');
  }
  // 2. The gaps, named and not guessed.
  const gaps = briefGaps(brief);
  const company = brief.company?.text ?? known?.company ?? domain ?? clip(call.title, 80);

  // 3. The draft, from the brief, the template and the catalog. No price reaches the model.
  const catalog = await listCatalog(deps.pool, { activeOnly: true });
  const drafted = await ask(
    deps,
    callId,
    DRAFT_TASK,
    settings['ai.sales.model_draft'],
    buildDraftInput({ company, brief, gaps, template: settings['sales.proposal_template'], catalog, note: sales.note }),
    3000,
  );
  if (!drafted.ok) return 'failed' in drafted ? fail(deps, callId, sales.version, drafted.failed) : wait(drafted);
  const assembled = assembleDraft(drafted.value, { company, catalog });
  if (!assembled.doc.sections.length) return fail(deps, callId, sales.version, 'The draft had no usable section after the checks.');

  // 4. The grounding check: a second call with its own prompt. Code applies what it points at.
  const verdict = await ask(deps, callId, CHECK_TASK, settings['ai.sales.model_check'], buildCheckInput({ brief, catalog, doc: assembled.doc }), 800);
  if (!verdict.ok) return 'failed' in verdict ? fail(deps, callId, sales.version, verdict.failed) : wait(verdict);
  const grounded = applyCheck(assembled.doc, verdict.value);
  if (grounded.ignored) deps.log.info('grounding issues not found in the draft', { callId, ignored: grounded.ignored });
  if (!grounded.doc.sections.length) return fail(deps, callId, sales.version, 'Nothing in the draft traced to the brief, so there is no proposal to show.');

  // Prices: the Investment section is built here from the rate card, after both model steps.
  const doc = withInvestment(grounded.doc, investmentSection(assembled.lineItems, settings['sales.currency'], catalog.length));
  const contentMd = `${cleanMarkdown(joinProposal(doc)).text}\n`;
  const allGaps = [...gaps, ...pricingGaps(assembled.lineItems, catalog.length)].slice(0, 12);
  const flags = [...assembled.flags, ...grounded.flags].slice(0, 30);
  const sections = doc.sections.filter((s) => s.heading !== INVESTMENT_HEADING).length;
  const summary = assembled.summary || `${sections} ${sections === 1 ? 'section' : 'sections'}`;

  // 5. The PDF. A proposal that cannot be rendered is still a proposal; the link is simply absent.
  const pdf = await renderProposalPdf(contentMd, { title: assembled.title, subtitle: `Prepared for ${company}` }).catch((err: unknown) => {
    deps.log.warn('proposal pdf failed', { callId, err });
    return null;
  });

  const copies = await listTranscripts(deps.pool, callId);
  const finding = penguinRule(
    penguinEmails,
    copies.map((copy) => ({ hostEmail: copy.hostEmail, attendees: copy.attendees })),
  );

  const stored = await withTx(deps.pool, async (tx) => {
    const current = await tx.query<{ state: string; version: number }>('SELECT state, version FROM sales_calls WHERE call_id = $1 FOR UPDATE', [callId]);
    // A person said "not a deal", or asked for another draft, while this one was being written.
    if (current.rows[0]?.state !== 'drafting' || current.rows[0].version !== sales.version) return null;

    let deal = await findDeal(tx, { dealId: sales.dealId, domain, company });
    if (!deal) {
      const created = await tx.query<DealRow>('INSERT INTO deals (company, domain) VALUES ($1, $2) RETURNING *', [clip(company, 150), domain]);
      deal = dealFromRow(created.rows[0]!);
      await recordAudit(tx, { actor: SYSTEM_ACTOR, action: 'deal.create', target: deal.id, after: { company: deal.company, domain, call: callId } });
    } else {
      await tx.query('SELECT id FROM deals WHERE id = $1 FOR UPDATE', [deal.id]);
    }

    // The Penguin rule, checked only now that the call is a sales call (design 6.4).
    const mark = applyFinding({ isPenguin: deal.isPenguin, reason: deal.penguinReason, setBy: deal.penguinSetBy }, finding);
    if (mark.isPenguin !== deal.isPenguin || mark.reason !== deal.penguinReason) {
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'deal.penguin',
        target: deal.id,
        before: { isPenguin: deal.isPenguin, reason: deal.penguinReason },
        after: { isPenguin: mark.isPenguin, reason: mark.reason, rule: finding.outcome, call: callId },
      });
    }
    await tx.query(
      `UPDATE deals SET is_penguin = $2, penguin_reason = $3, penguin_set_by = $4, contacts = $5, domain = COALESCE(domain, $6), updated_at = now() WHERE id = $1`,
      [deal.id, mark.isPenguin, mark.reason, mark.setBy, JSON.stringify(contactsFrom(brief, call, domain, deal.contacts)), domain],
    );

    const { proposal, affectedCalls } = await insertProposal(tx, {
      dealId: deal.id,
      callId,
      title: assembled.title,
      summary,
      brief,
      contentMd,
      gaps: allGaps,
      flags,
      lineItems: assembled.lineItems,
      pdf,
      createdBy: SYSTEM_ACTOR,
      note: sales.note,
    });
    await setSalesState(tx, callId, { state: 'drafted', dealId: deal.id, note: null, requestedBy: null });
    await recordAudit(tx, {
      actor: sales.requestedBy ?? SYSTEM_ACTOR,
      action: 'proposal.draft',
      target: proposal.id,
      after: { deal: deal.id, call: callId, version: proposal.version, gaps: allGaps, flags: flags.length, removedByCheck: grounded.removed, penguin: mark.isPenguin },
    });
    for (const affected of new Set([...affectedCalls, callId])) await deps.queue.enqueue('sales.post', { callId: affected }, { tx });
    return proposal;
  });
  return stored ? 'drafted' : 'superseded';
}

/** The brief of the deal's newest proposal that came from another call. */
async function earlierBrief(pool: Pool, dealId: string, callId: string): Promise<Brief | null> {
  const { rows } = await pool.query<Pick<ProposalRow, 'brief'>>(
    `SELECT brief FROM proposals WHERE deal_id = $1 AND call_id IS DISTINCT FROM $2 AND brief <> '{}'::jsonb ORDER BY version DESC LIMIT 1`,
    [dealId, callId],
  );
  return rows[0] ? { ...EMPTY_BRIEF, ...rows[0].brief } : null;
}

/**
 * Picks up sales calls that are waiting: held for something that has since changed, or left
 * in `drafting` by a job that never finished. Runs with the poll schedule and after a resume.
 */
export async function resumeWaitingSales(deps: Pick<WorkerDeps, 'pool' | 'queue'>): Promise<number> {
  if (!(await getSetting(deps.pool, 'sales.enabled'))) return 0;
  const { rows } = await deps.pool.query<{ call_id: string; state: string; held_step: SalesStep | null }>(
    `SELECT call_id, state, held_step FROM sales_calls
      WHERE state = 'held' OR (state = 'drafting' AND updated_at < now() - interval '45 minutes')
      ORDER BY updated_at LIMIT 50`,
  );
  for (const row of rows) {
    await deps.queue.enqueue(row.state === 'held' && row.held_step === 'classify' ? 'sales.classify' : 'sales.draft', { callId: row.call_id });
  }
  return rows.length;
}
