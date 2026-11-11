import type { Call } from '../calls/types.js';
import type { PreparedUpdate } from '../dealroom/files.js';
import type { IntegrationStatus } from '../integrations/status.js';
import type { Recommendation } from '../recommendations/types.js';
import { formatMoney } from '../sales/draft.js';
import type { DealListItem, SalesCallItem } from '../sales/store.js';
import type { Brief, CatalogItem, Deal, DealRoomUpdate, Proposal, ProposalStatus, Quoted, SalesCall, SalesState } from '../sales/types.js';
import { CALL_TYPE_LABEL, isCallType, isSalesType } from '../sales/types.js';
import type { AllSettings } from '../settings/settings.js';
import { settingDefs } from '../settings/settings.js';
import type { User } from '../settings/users.js';
import { canDecide, hasRole } from '../settings/users.js';
import { usd } from './aiViews.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';
import type { PageContext } from './views.js';
import { csrf, layout, when } from './views.js';

const PROPOSAL_BADGE: Record<ProposalStatus, [string, string]> = {
  draft: ['posted', 'Draft'],
  superseded: ['drafted', 'Replaced'],
  final: ['done', 'Final'],
  dismissed: ['dismissed', 'Not a deal'],
};

const SALES_STATE: Record<SalesState, [string, string]> = {
  asked: ['posted', 'Asked: sales call?'],
  drafting: ['executing', 'Drafting'],
  drafted: ['done', 'Proposal drafted'],
  held: ['drafted', 'Waiting'],
  failed: ['failed', 'Draft failed'],
  declined: ['dismissed', 'Not a sales call'],
};

const UPDATE_STATUS: Record<DealRoomUpdate['status'], [string, string]> = {
  prepared: ['executing', 'Opening'],
  pr_open: ['posted', 'Pull request open'],
  draft_written: ['posted', 'Draft written'],
  published: ['done', 'Published'],
  merged: ['done', 'Merged'],
  closed: ['dismissed', 'Closed without merging'],
  failed: ['failed', 'Failed'],
};

const badge = ([style, label]: [string, string]): SafeHtml => html`<span class="badge badge-${style}">${label}</span>`;
const name = (users: Map<string, User>, id: string | null): string => (id === null || id === 'system' ? 'Patcher' : (users.get(id)?.displayName ?? id));
const safeUrl = (url: string | null | undefined): url is string => Boolean(url && /^https:\/\//.test(url));
const maySell = (ctx: PageContext): boolean => hasRole(ctx.session.user, 'approver') && canDecide(ctx.session.user, 'proposal');

/** "Sales: discovery (0.84)", or how a person set it. */
export function callTypeText(call: Pick<Call, 'callType' | 'callTypeConf'>): string {
  if (!call.callType) return '';
  const label = isCallType(call.callType) ? CALL_TYPE_LABEL[call.callType] : call.callType;
  if (call.callTypeConf === null) return label;
  return call.callTypeConf >= 1 ? `${label} (set by a person)` : `${label} (${call.callTypeConf.toFixed(2)})`;
}

/** The deal's Penguin mark in words, with why. */
export function penguinMark(deal: Pick<Deal, 'isPenguin' | 'penguinReason' | 'penguinSetBy'>, users: Map<string, User>): SafeHtml {
  if (deal.isPenguin === null) return html`<span class="muted">Not known: the transcript carried no addresses</span>`;
  const why =
    deal.penguinReason === 'host'
      ? 'a Penguin address hosted or recorded the call'
      : deal.penguinReason === 'attendee'
        ? 'a Penguin address was on the call'
        : deal.penguinReason === 'flagged'
          ? `set by ${name(users, deal.penguinSetBy)}`
          : 'no Penguin address was on the call';
  return html`${deal.isPenguin ? html`<span class="badge badge-done">Penguin deal</span>` : 'Not a Penguin deal'} <span class="muted small">${why}</span>`;
}

function penguinForms(ctx: PageContext, deal: Deal): SafeHtml {
  return html`<div class="row">
    ${deal.isPenguin === true && deal.penguinReason === 'flagged'
      ? ''
      : html`<form method="post" action="/sales/deals/${deal.id}/penguin">${csrf(ctx)}<input type="hidden" name="penguin" value="yes" /><button type="submit">Mark as Penguin</button></form>`}
    ${deal.isPenguin === false && deal.penguinReason === 'flagged'
      ? ''
      : html`<form method="post" action="/sales/deals/${deal.id}/penguin">${csrf(ctx)}<input type="hidden" name="penguin" value="no" /><button type="submit">Not Penguin</button></form>`}
  </div>`;
}

export function salesPage(
  ctx: PageContext,
  data: { deals: DealListItem[]; open: SalesCallItem[]; settings: AllSettings; users: Map<string, User>; hasRoute: boolean; penguinEmails: string[] },
): string {
  const seller = maySell(ctx);
  return layout(
    ctx,
    'Sales',
    html`<div class="card-head">
        <h1>Sales</h1>
        <a class="button" href="/sales/catalog">Template and rate card</a>
      </div>
      ${data.settings['sales.enabled']
        ? ''
        : html`<div class="flash flash-error">Sales calls are switched off in <a href="/settings#sales">Settings</a>. No call is read for its type and nothing is drafted.</div>`}
      ${data.hasRoute ? '' : html`<div class="flash flash-info">No channel is set for Sales reports, so proposals wait unposted. Choose one in <a href="/settings#routing">Settings</a>.</div>`}

      <section class="card" id="waiting">
        <h2>Calls in the sales pipeline</h2>
        ${data.open.length
          ? html`<table>
              <thead><tr><th>Call</th><th>When</th><th>State</th><th></th></tr></thead>
              <tbody>
                ${data.open.map(
                  (s) => html`<tr>
                    <td><a href="/calls/${s.callId}#sales">${s.title}</a></td>
                    <td>${when(s.startedAt)}</td>
                    <td>
                      ${badge(SALES_STATE[s.state])}
                      ${s.detail ? html`<div class="muted small">${s.detail}</div>` : ''}
                      ${s.postError ? html`<div class="bad small">${s.postError}</div>` : ''}
                    </td>
                    <td>
                      <div class="row">
                        ${seller && s.state === 'asked'
                          ? html`<form method="post" action="/sales/calls/${s.callId}/type">${csrf(ctx)}<input type="hidden" name="sales" value="yes" /><button class="primary" type="submit">Yes, draft proposal</button></form>
                              <form method="post" action="/sales/calls/${s.callId}/type">${csrf(ctx)}<input type="hidden" name="sales" value="no" /><button type="submit">No</button></form>`
                          : ''}
                        ${seller && s.state === 'failed' ? html`<form method="post" action="/sales/calls/${s.callId}/regenerate">${csrf(ctx)}<button type="submit">Retry</button></form>` : ''}
                        ${seller && s.postError ? html`<form method="post" action="/sales/calls/${s.callId}/post">${csrf(ctx)}<button type="submit">Post to Slack now</button></form>` : ''}
                      </div>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">Nothing is waiting. A call that reads as a sales call appears here while its proposal is drafted.</p>`}
      </section>

      <section class="card" id="deals">
        <h2>Deals</h2>
        ${data.deals.length
          ? html`<table>
              <thead><tr><th>Company</th><th>Penguin</th><th>Proposal</th><th>Deal room</th><th>Calls</th><th>Updated</th></tr></thead>
              <tbody>
                ${data.deals.map(
                  (d) => html`<tr>
                    <td><a href="/sales/deals/${d.id}">${d.company}</a>${d.domain ? html`<div class="muted small">${d.domain}</div>` : ''}</td>
                    <td>${penguinMark(d, data.users)}</td>
                    <td>
                      ${d.proposalId && d.proposalStatus
                        ? html`<a href="/sales/proposals/${d.proposalId}">v${d.proposalVersion}</a> ${badge(PROPOSAL_BADGE[d.proposalStatus])}`
                        : html`<span class="muted">none</span>`}
                    </td>
                    <td>
                      ${d.updateStatus ? badge(UPDATE_STATUS[d.updateStatus]) : d.isPenguin ? (d.dealRoomSkipped ? html`<span class="muted">skipped</span>` : d.dealRoomSlug ? html`<code>${d.dealRoomSlug}</code>` : html`<span class="muted">no slug yet</span>`) : ''}
                      ${safeUrl(d.prUrl) ? html` <a href="${d.prUrl}" rel="noreferrer">pull request</a>` : ''}
                    </td>
                    <td>${d.calls}</td>
                    <td>${when(d.updatedAt)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No deal yet. One is created when a proposal is drafted from a sales call.</p>`}
      </section>

      <section class="card" id="penguin">
        <h2>Penguin email addresses</h2>
        ${data.penguinEmails.length
          ? html`<p>${data.penguinEmails.map((e) => html`<code>${e}</code> `)}</p>
              <p class="muted small">A sales call with one of these as host, recorder or attendee is a Penguin deal. The whole address is compared, not the domain.</p>`
          : html`<p class="muted">None saved, so the rule marks nothing and only a person's flag applies.</p>`}
        <p><a href="/settings#sales">Change in Settings</a></p>
      </section>`,
  );
}

function updatesTable(updates: DealRoomUpdate[]): SafeHtml {
  return html`<table>
    <thead><tr><th>When</th><th>Where</th><th>Status</th><th>Files</th></tr></thead>
    <tbody>
      ${updates.map(
        (u) => html`<tr>
          <td>${when(u.createdAt)}</td>
          <td>
            ${safeUrl(u.prUrl) ? html`<a href="${u.prUrl}" rel="noreferrer">Pull request${u.prNumber ? ` #${u.prNumber}` : ''}</a>` : html`<span class="muted">not opened</span>`}
            <div class="muted small"><code>${u.repo ?? ''}</code> · content/${u.slug}/${u.branch ? html` · branch <code>${u.branch}</code>` : ''}</div>
          </td>
          <td>${badge(UPDATE_STATUS[u.status])}${u.error ? html`<div class="bad small">${u.error}</div>` : ''}</td>
          <td>
            <details>
              <summary>${u.files.length} ${u.files.length === 1 ? 'file' : 'files'}</summary>
              <ul>${u.files.map((f) => html`<li><code>${f.path}</code></li>`)}</ul>
              ${u.manualSteps.length ? html`<p><strong>Still to do by hand</strong></p><ul>${u.manualSteps.map((s) => html`<li>${s}</li>`)}</ul>` : ''}
            </details>
          </td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function dealPage(
  ctx: PageContext,
  data: {
    deal: Deal;
    proposals: Proposal[];
    updates: DealRoomUpdate[];
    calls: SalesCallItem[];
    users: Map<string, User>;
    repo: string;
    dealRoom: IntegrationStatus | undefined;
  },
): string {
  const { deal } = data;
  const seller = maySell(ctx);
  return layout(
    ctx,
    deal.company,
    html`<p><a href="/sales">← Sales</a></p>
      <h1>${deal.company}</h1>
      <p class="muted">${deal.domain ?? 'No e-mail domain known'} · ${deal.stage === 'proposal_final' ? 'proposal final' : deal.stage}</p>

      <section class="card" id="penguin">
        <h2>Penguin deal</h2>
        <p>${penguinMark(deal, data.users)}</p>
        ${seller ? penguinForms(ctx, deal) : ''}
        <p class="muted small">A person's choice wins over the address rule in both directions, and a later call never removes the mark.</p>
      </section>

      <section class="card" id="dealroom">
        <h2>Deal room</h2>
        ${deal.isPenguin === true
          ? html`<p>
                Repository <code>${data.repo}</code> ·
                ${deal.dealRoomSkipped
                  ? html`<strong>skipped for this deal</strong>`
                  : deal.dealRoomSlug
                    ? html`room <code>${deal.dealRoomSlug}</code>, files under <code>content/${deal.dealRoomSlug}/</code>`
                    : html`<strong>no slug yet</strong>`}
              </p>
              ${data.dealRoom?.configured === false
                ? html`<div class="flash flash-error">
                    The deal room GitHub App is not configured on the worker (${data.dealRoom.missing.join(', ')}), so an approved proposal cannot open a pull request yet.
                  </div>`
                : ''}
              ${seller
                ? html`<form method="post" action="/sales/deals/${deal.id}/slug" class="row add">
                      ${csrf(ctx)}
                      <input name="slug" maxlength="63" required pattern="[a-z0-9][a-z0-9-]*" value="${deal.dealRoomSlug ?? ''}" placeholder="the room's slug, e.g. northwind" aria-label="Deal room slug" />
                      <button type="submit">Save slug</button>
                    </form>
                    ${deal.dealRoomSkipped ? '' : html`<form method="post" action="/sales/deals/${deal.id}/skip">${csrf(ctx)}<button type="submit">Skip the deal room for this deal</button></form>`}`
                : ''}
              <p class="muted small">
                Patcher cannot create a room. Create it in the deal room's admin with no client domains, then save its slug here.
                Approving the proposal then opens a pull request with the content files. Patcher never merges it.
              </p>`
          : html`<p class="muted">Only a Penguin deal gets deal room content.</p>`}
        ${data.updates.length ? updatesTable(data.updates) : ''}
      </section>

      <section class="card" id="proposals">
        <h2>Proposal versions</h2>
        ${data.proposals.length
          ? html`<table>
              <thead><tr><th>Version</th><th>Status</th><th>Written by</th><th>When</th><th>Summary</th></tr></thead>
              <tbody>
                ${data.proposals.map(
                  (p) => html`<tr>
                    <td><a href="/sales/proposals/${p.id}">v${p.version}</a></td>
                    <td>${badge(PROPOSAL_BADGE[p.status])}</td>
                    <td>${name(data.users, p.createdBy)}${p.note ? html`<div class="muted small">asked: ${p.note}</div>` : ''}</td>
                    <td>${when(p.createdAt)}</td>
                    <td>${p.summary || p.title}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">None.</p>`}
      </section>

      <section class="card" id="people">
        <h2>People and calls</h2>
        ${deal.contacts.length
          ? html`<ul>${deal.contacts.map((c) => html`<li>${c.name}${c.role ? html` <span class="muted">${c.role}</span>` : ''}${c.email ? html` <code>${c.email}</code>` : ''}</li>`)}</ul>`
          : html`<p class="muted">The calls named nobody on the prospect's side.</p>`}
        ${data.calls.length
          ? html`<ul>${data.calls.map((c) => html`<li><a href="/calls/${c.callId}#sales">${c.title}</a> <span class="muted">${when(c.startedAt)}</span> ${badge(SALES_STATE[c.state])}</li>`)}</ul>`
          : ''}
      </section>`,
  );
}

function briefCard(brief: Brief): SafeHtml {
  const one = (label: string, value: Quoted | null): SafeHtml =>
    html`<tr>
      <th>${label}</th>
      <td>${value ? html`${value.text}<blockquote>${value.quote}${value.at ? html` <span class="muted">(at ${value.at})</span>` : ''}</blockquote>` : html`<span class="muted">not covered in the call</span>`}</td>
    </tr>`;
  const list = (label: string, values: Quoted[]): SafeHtml =>
    html`<tr>
      <th>${label}</th>
      <td>
        ${values.length
          ? values.map((v) => html`<div>${v.text}<blockquote>${v.quote}${v.at ? html` <span class="muted">(at ${v.at})</span>` : ''}</blockquote></div>`)
          : html`<span class="muted">not covered in the call</span>`}
      </td>
    </tr>`;
  return html`<table class="dense">
    <tbody>
      ${one('Company', brief.company)}
      <tr>
        <th>People</th>
        <td>
          ${brief.people?.length
            ? brief.people.map((p) => html`<div>${p.name}${p.role ? `, ${p.role}` : ''} <span class="muted small">${p.side === 'us' ? 'our side' : p.side === 'prospect' ? "the prospect's side" : ''}</span></div>`)
            : html`<span class="muted">none named</span>`}
        </td>
      </tr>
      ${one('Problem', brief.problem)} ${one('Desired outcome', brief.outcome)} ${list('Scope items', brief.scope ?? [])}
      ${list('Constraints', brief.constraints ?? [])} ${one('Timeline', brief.timeline)} ${one('Budget signals', brief.budget)}
      ${list('Objections', brief.objections ?? [])} ${list('Agreed next steps', brief.nextSteps ?? [])}
    </tbody>
  </table>`;
}

export interface ProposalPageData {
  proposal: Proposal;
  deal: Deal;
  call: Call | null;
  sales: SalesCall | null;
  offer: Recommendation | null;
  /** What approving the offer does, in the catalog's words. */
  offerDescription: string | null;
  updates: DealRoomUpdate[];
  versions: Proposal[];
  /** The deal room files this version would become. Null when the deal has no room to write to. */
  files: PreparedUpdate | null;
  users: Map<string, User>;
  currency: string;
}

function offerCard(ctx: PageContext, data: ProposalPageData): SafeHtml {
  const { proposal, deal, offer } = data;
  const seller = maySell(ctx);
  if (proposal.status === 'superseded') {
    const newest = data.versions[0];
    return html`<div class="flash flash-info">A newer version replaced this one.${newest ? html` <a href="/sales/proposals/${newest.id}">Open v${newest.version}</a>.` : ''}</div>`;
  }
  if (proposal.status === 'dismissed') return html`<div class="flash flash-info">The call was marked as not a deal.</div>`;
  if (proposal.status === 'final') {
    return html`<div class="flash flash-ok">
      Final${proposal.finalizedBy ? `, approved by ${name(data.users, proposal.finalizedBy)}` : ''}.
      ${proposal.hasPdf ? html`<a href="/sales/proposals/${proposal.id}/pdf">The PDF</a> is for a person to send; Patcher sends nothing to the prospect.` : ''}
    </div>`;
  }
  if (offer?.status === 'posted') {
    return html`<section class="card" id="approve">
      <h2>Approve</h2>
      <p>${data.offerDescription ?? ''}</p>
      ${seller
        ? html`<div class="row">
            <form method="post" action="/approvals/${offer.id}/approve">${csrf(ctx)}<input type="hidden" name="hash" value="${offer.actionHash}" /><button class="primary" type="submit">Approve</button></form>
            <a href="/approvals/${offer.id}">Details of the approval</a>
          </div>`
        : html`<p class="muted">Waiting for an approver.</p>`}
    </section>`;
  }
  if (offer?.status === 'failed') {
    return html`<div class="flash flash-error">
      Approved, and the action failed: ${offer.lastError ?? 'no reason recorded'}
      ${seller ? html`<form method="post" action="/approvals/${offer.id}/retry">${csrf(ctx)}<input type="hidden" name="hash" value="${offer.actionHash}" /><button type="submit">Retry</button></form>` : ''}
    </div>`;
  }
  if (offer && (offer.status === 'approved' || offer.status === 'executing')) return html`<div class="flash flash-info">Approved. Working on it; reload in a moment.</div>`;
  if (offer?.status === 'done') return html`<div class="flash flash-info">Approved in dry run, so nothing was done. Regenerate or edit to offer it again.</div>`;
  if (offer?.status === 'drafted') return html`<div class="flash flash-info">Waiting to be posted to the sales channel. It can be approved once it is there.</div>`;
  if (offer?.status === 'dismissed') return html`<div class="flash flash-info">Dismissed by ${name(data.users, offer.decidedBy)}. Regenerate or edit to offer it again.</div>`;
  if (offer?.status === 'expired') return html`<div class="flash flash-info">The approval request expired or was closed. Edit or regenerate to offer the proposal again.</div>`;
  if (deal.isPenguin === null) {
    return html`<div class="flash flash-info">
      Before this can be approved: is it a Penguin deal? The transcript carried no addresses, so the rule could not tell.
      ${seller ? penguinForms(ctx, deal) : ''}
    </div>`;
  }
  if (deal.isPenguin && !deal.dealRoomSkipped && !deal.dealRoomSlug) {
    return html`<div class="flash flash-info">
      Before this can be approved: the deal room's slug is needed. <a href="/sales/deals/${deal.id}#dealroom">Enter it, or skip the deal room, on the deal</a>.
    </div>`;
  }
  if (data.files?.problems.length) {
    return html`<div class="flash flash-error">The deal room files cannot be offered: ${data.files.problems.join(' ')} Edit the proposal to fix it.</div>`;
  }
  return html`<div class="flash flash-info">The approval request is being prepared. Reload in a moment.</div>`;
}

export function proposalPage(ctx: PageContext, data: ProposalPageData): string {
  const { proposal, deal, call } = data;
  const seller = maySell(ctx);
  const current = proposal.status === 'draft' || proposal.status === 'final';
  const money = (cents: number | null): string => (cents === null ? 'TBD' : formatMoney(cents, data.currency));
  return layout(
    ctx,
    `${deal.company} proposal v${proposal.version}`,
    html`<p><a href="/sales">← Sales</a> · <a href="/sales/deals/${deal.id}">${deal.company}</a></p>
      <h1>${proposal.title}</h1>
      <p>
        ${badge(PROPOSAL_BADGE[proposal.status])}
        <span class="muted">
          v${proposal.version} · written by ${name(data.users, proposal.createdBy)} · ${when(proposal.createdAt)}
          ${call ? html` · from <a href="/calls/${call.id}">${call.title}</a>` : ''}
        </span>
        ${proposal.hasPdf ? html` · <a href="/sales/proposals/${proposal.id}/pdf">PDF</a>` : ''}
      </p>
      <p>${penguinMark(deal, data.users)}</p>
      ${offerCard(ctx, data)}

      ${proposal.gaps.length || proposal.flags.length
        ? html`<section class="card" id="check">
            <h2>To check</h2>
            ${proposal.gaps.length ? html`<p><strong>Gaps:</strong> ${proposal.gaps.join(', ')}. The call did not cover these; the draft does not guess them.</p>` : ''}
            ${proposal.flags.length ? html`<ul>${proposal.flags.map((f) => html`<li>${f}</li>`)}</ul>` : ''}
          </section>`
        : ''}

      <section class="card" id="text">
        <h2>Proposal</h2>
        ${seller && current
          ? html`<form method="post" action="/sales/proposals/${proposal.id}/edit" class="stack">
              ${csrf(ctx)}
              <label>Markdown. One <code>#</code> title, then <code>##</code> sections.
                <textarea name="content_md" rows="30" class="mono" required>${proposal.contentMd}</textarea>
              </label>
              <div><button type="submit">Save as a new version</button></div>
            </form>
            <p class="muted small">
              Saving makes v${data.versions[0] ? data.versions[0].version + 1 : proposal.version + 1} and closes the approval request of this one.
              Images and raw HTML are removed, and links keep only http, https and mailto addresses.
            </p>`
          : html`<pre>${proposal.contentMd}</pre>`}
      </section>

      ${proposal.lineItems.length
        ? html`<section class="card" id="pricing">
            <h2>Rate card lines behind the Investment section</h2>
            <table class="dense">
              <thead><tr><th>Service</th><th>Quantity</th><th>Unit price</th><th>Total</th><th>Why it is included</th></tr></thead>
              <tbody>
                ${proposal.lineItems.map(
                  (i) => html`<tr>
                    <td>${i.name} <code>${i.key}</code></td>
                    <td>${i.unit === 'fixed' ? 'Fixed' : i.quantity === null ? 'TBD' : `${i.quantity} × ${i.unit}`}</td>
                    <td>${money(i.unitPriceCents)}</td>
                    <td>${money(i.totalCents)}</td>
                    <td class="muted small">${i.basis}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
            <p class="muted small">Every price comes from the <a href="/sales/catalog">rate card</a>. The model is given no prices and any amount it writes becomes TBD.</p>
          </section>`
        : ''}

      ${data.files
        ? html`<section class="card" id="files">
            <h2>Deal room files</h2>
            <p class="muted">
              What approving would put in a pull request under <code>content/${data.files.slug}/</code>. An <code>overview.md</code> already in the room is left as it is.
            </p>
            ${data.files.problems.length ? html`<div class="flash flash-error">${data.files.problems.join(' ')}</div>` : ''}
            ${data.files.files.map((f) => html`<details><summary><code>${f.path}</code></summary><pre>${f.content}</pre></details>`)}
          </section>`
        : ''}
      ${data.updates.length ? html`<section class="card" id="dealroom"><h2>Deal room</h2>${updatesTable(data.updates)}</section>` : ''}

      <section class="card" id="brief">
        <h2>Deal brief</h2>
        <p class="muted">What the call established, each point with the words behind it. The proposal may rely on nothing else.</p>
        ${Object.keys(proposal.brief).length ? briefCard(proposal.brief) : html`<p class="muted">The quotes were removed with the recording.</p>`}
      </section>

      ${seller && proposal.callId && proposal.status !== 'dismissed'
        ? html`<section class="card" id="again">
            <h2>Draft again</h2>
            <form method="post" action="/sales/calls/${proposal.callId}/regenerate" class="stack">
              ${csrf(ctx)}
              <label>What should the new draft do differently? (optional)
                <textarea name="note" rows="3" maxlength="1000"></textarea>
              </label>
              <div><button type="submit">Regenerate</button></div>
            </form>
            <p class="muted small">The note can change emphasis and length. Facts still come only from the call, and prices only from the rate card.</p>
            ${proposal.status === 'draft'
              ? html`<form method="post" action="/sales/calls/${proposal.callId}/not-deal">${csrf(ctx)}<button class="danger" type="submit">Not a deal</button></form>`
              : ''}
          </section>`
        : ''}

      <section class="card" id="versions">
        <h2>Version history</h2>
        <ul>
          ${data.versions.map(
            (v) => html`<li>
              ${v.id === proposal.id ? html`<strong>v${v.version}</strong>` : html`<a href="/sales/proposals/${v.id}">v${v.version}</a>`}
              ${badge(PROPOSAL_BADGE[v.status])} <span class="muted">${name(data.users, v.createdBy)} · ${when(v.createdAt)}${v.note ? ` · asked: ${v.note}` : ''}</span>
            </li>`,
          )}
        </ul>
      </section>`,
  );
}

export function catalogPage(ctx: PageContext, data: { catalog: CatalogItem[]; template: string; currency: string }): string {
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const price = (item: CatalogItem): string => (item.unitPriceCents === null ? '' : (item.unitPriceCents / 100).toFixed(2));
  return layout(
    ctx,
    'Template and rate card',
    html`<p><a href="/sales">← Sales</a></p>
      <h1>Template and rate card</h1>

      <section class="card" id="catalog">
        <h2>Service catalog and rate card</h2>
        <p class="muted">
          The only source of a price in a proposal, in ${data.currency}. The model sees the names and descriptions and never the prices;
          the Investment section is built from this table. A service without a price shows as TBD.
        </p>
        ${data.catalog.length
          ? html`<table>
              <thead><tr><th>Key</th><th>Name and description</th><th>Sold per</th><th>Price</th><th></th><th></th></tr></thead>
              <tbody>
                ${data.catalog.map(
                  (item) => html`<tr>
                    <td><code>${item.key}</code></td>
                    <td colspan="4">
                      <form method="post" action="/sales/catalog" class="row">
                        ${csrf(ctx)}
                        <input type="hidden" name="key" value="${item.key}" />
                        <input name="name" value="${item.name}" maxlength="100" required aria-label="Name" ${disabled} />
                        <input name="description" value="${item.description}" maxlength="500" aria-label="Description" ${disabled} />
                        <input name="unit" value="${item.unit}" maxlength="30" required aria-label="Sold per" ${disabled} />
                        <input name="price" value="${price(item)}" inputmode="decimal" placeholder="no price" aria-label="Price" ${disabled} />
                        <label class="check"><input type="checkbox" name="active" value="1" ${item.active ? 'checked' : ''} ${disabled} /> Offered</label>
                        <button type="submit" ${disabled}>Save</button>
                      </form>
                    </td>
                    <td><form method="post" action="/sales/catalog/${item.id}/remove">${csrf(ctx)}<button class="danger" type="submit" ${disabled}>Remove</button></form></td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">Empty. Until a service is listed, every proposal says "Pricing: TBD".</p>`}
        ${owner
          ? html`<h3>Add a service</h3>
              <form method="post" action="/sales/catalog" class="row add">
                ${csrf(ctx)}
                <input name="key" maxlength="40" required pattern="[a-z0-9][a-z0-9-]+" placeholder="key, e.g. discovery" aria-label="Key" />
                <input name="name" maxlength="100" required placeholder="Name" aria-label="Name" />
                <input name="description" maxlength="500" placeholder="What it is" aria-label="Description" />
                <input name="unit" maxlength="30" value="fixed" required aria-label="Sold per" />
                <input name="price" inputmode="decimal" placeholder="Price, or empty" aria-label="Price" />
                <input type="hidden" name="active" value="1" />
                <button type="submit">Add</button>
              </form>
              <p class="muted small">"Sold per" is what one unit is: <code>fixed</code> for a fixed price, or a unit such as week, month or integration.</p>`
          : ''}
      </section>

      <section class="card" id="template">
        <h2>Proposal template</h2>
        <p class="muted">The <code>##</code> headings are the sections of every draft, in this order. The text under a heading tells the model what the section is for. Do not add a pricing section: it is added from the rate card.</p>
        <form method="post" action="/sales/template" class="stack">
          ${csrf(ctx)}
          <textarea name="template" rows="24" class="mono" required ${disabled}>${data.template}</textarea>
          <div><button type="submit" ${disabled}>Save template</button></div>
        </form>
      </section>`,
  );
}

/** The Sales card on the Settings screen. */
export function salesSettingsCard(
  ctx: PageContext,
  data: { settings: AllSettings; dealRoom: IntegrationStatus | undefined; ai: { configured: boolean | null; spentDay: number; spentMonth: number } },
): SafeHtml {
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const s = data.settings;
  return html`<section class="card" id="sales">
    <h2>Sales</h2>
    <p class="muted">
      A call that reads as a sales call gets a drafted proposal, posted to the channel routed for Sales. Nothing is sent to a prospect by Patcher.
      The template and the rate card are on the <a href="/sales/catalog">Sales screen</a>.
    </p>
    ${data.ai.configured === false
      ? html`<div class="flash flash-error">No model is configured, so no call is read for its type. Set <code>ANTHROPIC_API_KEY</code> on the worker.</div>`
      : ''}
    <form method="post" action="/settings/sales" class="stack">
      ${csrf(ctx)}
      <label class="check"><input type="checkbox" name="sales.enabled" value="1" ${s['sales.enabled'] ? 'checked' : ''} ${disabled} /> ${settingDefs['sales.enabled'].label}</label>
      <label class="check"><input type="checkbox" name="ai.sales.enabled" value="1" ${s['ai.sales.enabled'] ? 'checked' : ''} ${disabled} /> ${settingDefs['ai.sales.enabled'].label}</label>
      <label>${settingDefs['sales.penguin_emails'].label}
        <input name="sales.penguin_emails" value="${s['sales.penguin_emails']}" placeholder="you@penguin.example, alias@penguin.example" ${disabled} /></label>
      <p class="muted small">
        A sales call with one of these addresses on it (the Calendly host, the Fathom recorder, or an attendee or invitee) is a Penguin deal.
        The whole address is compared, ignoring case. Until one is saved, only a person's flag marks a deal.
      </p>
      <label>${settingDefs['sales.title_patterns'].label}
        <input name="sales.title_patterns" value="${s['sales.title_patterns']}" ${disabled} /></label>
      <label>${settingDefs['ai.sales.auto_confidence'].label}
        <input type="number" name="ai.sales.auto_confidence" min="0.5" max="1" step="0.01" value="${s['ai.sales.auto_confidence']}" ${disabled} /></label>
      <label>${settingDefs['ai.sales.ask_confidence'].label}
        <input type="number" name="ai.sales.ask_confidence" min="0" max="1" step="0.01" value="${s['ai.sales.ask_confidence']}" ${disabled} /></label>
      ${(['ai.sales.model_classify', 'ai.sales.model_brief', 'ai.sales.model_draft', 'ai.sales.model_check'] as const).map(
        (key) => html`<label>${settingDefs[key].label} <input name="${key}" value="${s[key]}" required class="mono" ${disabled} /></label>`,
      )}
      <label>${settingDefs['ai.sales.daily_budget_usd'].label}
        <input type="number" name="ai.sales.daily_budget_usd" min="0" max="10000" step="0.01" value="${s['ai.sales.daily_budget_usd']}" ${disabled} /></label>
      <label>${settingDefs['ai.sales.monthly_budget_usd'].label}
        <input type="number" name="ai.sales.monthly_budget_usd" min="0" max="100000" step="0.01" value="${s['ai.sales.monthly_budget_usd']}" ${disabled} /></label>
      <label>${settingDefs['sales.currency'].label}
        <input name="sales.currency" value="${s['sales.currency']}" maxlength="3" class="mono" ${disabled} /></label>

      <h3>Penguin deal room</h3>
      <label>${settingDefs['sales.dealroom_repo'].label}
        <input name="sales.dealroom_repo" value="${s['sales.dealroom_repo']}" class="mono" ${disabled} /></label>
      <p>
        ${data.dealRoom === undefined
          ? html`<span class="muted">The worker has not reported yet.</span>`
          : data.dealRoom.configured
            ? html`<span class="badge badge-done">GitHub App configured</span>
                <span class="muted small">Last read ${data.dealRoom.lastOkAt ? when(data.dealRoom.lastOkAt) : 'never'}${data.dealRoom.lastError ? ` · last error: ${data.dealRoom.lastError}` : ''}</span>`
            : html`<span class="badge badge-failed">Not configured</span> <span class="muted small">Missing on the worker: ${data.dealRoom.missing.join(', ')}</span>`}
      </p>
      <p class="muted small">
        Patcher opens a pull request with files under <code>content/[slug]/</code> after a person approves the proposal. It never merges and never
        writes to the default branch. The slug is saved per deal on the Sales screen.
      </p>
      <div><button type="submit" ${disabled}>Save</button></div>
    </form>
    <p class="muted small">
      Spent on model calls for sales: ${usd(data.ai.spentDay)} in the last 24 hours, ${usd(data.ai.spentMonth)} in the last 30 days, at list prices.
    </p>
  </section>`;
}

/** The Sales card on a call's page: what kind of call it was, and what the sales pipeline made of it. */
export function callSalesCard(
  ctx: PageContext,
  data: { call: Call; sales: SalesCall | null; proposal: Proposal | null; deal: Deal | null },
): SafeHtml {
  const { call, sales, proposal, deal } = data;
  const seller = maySell(ctx) && call.status !== 'deleted';
  const typed = callTypeText(call);
  const inPipeline = sales && sales.state !== 'declined';
  return html`<section class="card" id="sales">
    <h2>Call type and sales</h2>
    <p>${typed ? typed : html`<span class="muted">Not read for its type yet.</span>`} ${sales ? badge(SALES_STATE[sales.state]) : ''}</p>
    ${sales?.detail ? html`<p class="muted">${sales.detail}</p>` : ''}
    ${sales?.postError ? html`<div class="flash flash-error">${sales.postError}</div>` : ''}
    ${proposal && deal
      ? html`<p>
          <a href="/sales/proposals/${proposal.id}">Proposal v${proposal.version}</a> for <a href="/sales/deals/${deal.id}">${deal.company}</a>
        </p>`
      : ''}
    ${seller
      ? html`<div class="row">
          ${inPipeline
            ? ''
            : html`<form method="post" action="/sales/calls/${call.id}/type">${csrf(ctx)}<input type="hidden" name="sales" value="yes" /><button type="submit">Treat as a sales call</button></form>`}
          ${sales?.state === 'declined' || (!sales && !isSalesType(call.callType))
            ? ''
            : html`<form method="post" action="/sales/calls/${call.id}/type">${csrf(ctx)}<input type="hidden" name="sales" value="no" /><button type="submit">Not a sales call</button></form>`}
          ${sales?.state === 'failed' ? html`<form method="post" action="/sales/calls/${call.id}/regenerate">${csrf(ctx)}<button type="submit">Retry the draft</button></form>` : ''}
        </div>
        <p class="muted small">Treating it as a sales call drafts a proposal from it. Nothing is sent to anyone outside.</p>`
      : ''}
  </section>`;
}
