import type { CallTotals } from '../ai/run.js';
import type { AgentRunRecord } from '../fix/agentFix.js';
import type { IntegrationStatus } from '../integrations/status.js';
import { INTEGRATIONS } from '../integrations/status.js';
import type { InventoryProject } from '../railway/inventory.js';
import type { Recommendation } from '../recommendations/types.js';
import type { Project } from '../registry/registry.js';
import { LINK_KINDS } from '../registry/registry.js';
import { hasRole } from '../settings/users.js';
import type { AuditRun } from '../weekly/delivery.js';
import type { Finding, FindingState } from '../weekly/findings.js';
import type { AnalysisStep, AuditReport, FixInfo, ReportFinding, StepStatus } from '../weekly/report.js';
import { RULES_DETAIL, countsLine, coverageLines, fixText, history } from '../weekly/report.js';
import type { Severity } from '../weekly/types.js';
import { CATEGORIES, categories, subject } from '../weekly/types.js';
import { callsTable } from './aiViews.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';
import type { PageContext } from './views.js';
import { csrf, layout, when } from './views.js';

const SEVERITY_BADGE: Record<Severity, string> = { critical: 'failed', warning: 'posted', info: 'muted' };
const severityBadge = (severity: Severity) => html`<span class="badge badge-${SEVERITY_BADGE[severity]}">${severity}</span>`;

const STATE_LABEL: Record<FindingState, string> = { open: 'Open', resolved: 'Resolved', muted: 'Muted', accepted: 'Accepted' };

const safeUrl = (url: string | undefined): url is string => Boolean(url && /^https:\/\//.test(url));

function integrationsCard(integrations: IntegrationStatus[]): SafeHtml {
  const byName = new Map(integrations.map((i) => [i.name, i]));
  const purpose: Record<string, string> = {
    railway: 'Reads the workspace for the audit and the inventory. Read-only.',
    github: 'Commits behind the default branch and open critical dependency alerts.',
    cursor: 'Starts an agent on a linked repository after a fix is approved.',
    anthropic: 'Assesses findings, ranks the weekly report and drafts fix briefs. Without it the rules rank and word the report.',
  };
  return html`<section class="card">
    <h2>Connections</h2>
    <table>
      <thead><tr><th>System</th><th>Status</th><th>Last success</th><th>Used for</th></tr></thead>
      <tbody>
        ${Object.entries(INTEGRATIONS).map(([name, label]) => {
          const status = byName.get(name);
          return html`<tr>
            <td><strong>${label}</strong></td>
            <td>
              ${!status
                ? html`<span class="muted">The worker has not reported yet.</span>`
                : status.configured
                  ? status.lastError && (!status.lastOkAt || (status.lastErrorAt && status.lastErrorAt > status.lastOkAt))
                    ? html`<span class="bad">Last call failed</span><div class="muted small">${status.lastError}</div>`
                    : 'Configured'
                  : html`<span class="bad">Not configured</span>
                      <div class="muted small">Set on the worker: <code>${status.missing.join(', ')}</code></div>`}
            </td>
            <td>${when(status?.lastOkAt)}</td>
            <td class="muted">${purpose[name] ?? ''}</td>
          </tr>`;
        })}
      </tbody>
    </table>
  </section>`;
}

// Audits --------------------------------------------------------------------------------------

function findingRow(f: Finding): SafeHtml {
  return html`<tr>
    <td>${severityBadge(f.severity)}</td>
    <td><a href="/audits/findings/${f.id}"><strong>${subject(f.scope)}</strong> ${f.title}</a></td>
    <td>${CATEGORIES[f.category]}</td>
    <td>${when(f.firstSeenAt)}</td>
    <td>${f.prUrl && safeUrl(f.prUrl) ? html`<a href="${f.prUrl}" rel="noreferrer">Pull request</a>` : ''}</td>
  </tr>`;
}

const runStatus = (run: AuditRun): SafeHtml =>
  run.status === 'failed'
    ? html`<span class="bad">Failed</span>`
    : run.status === 'running'
      ? html`Running`
      : run.status === 'analyzing'
        ? html`Waiting for the model`
        : run.postedAt
        ? html`Posted to Slack`
        : html`<span class="muted">${run.postError ?? 'Waiting to post'}</span>`;

export function auditsPage(
  ctx: PageContext,
  data: {
    runs: AuditRun[];
    findings: Finding[];
    state: FindingState;
    stateCounts: Record<FindingState, number>;
    integrations: IntegrationStatus[];
  },
): string {
  const approver = hasRole(ctx.session.user, 'approver');
  const railway = data.integrations.find((i) => i.name === 'railway');
  return layout(
    ctx,
    'Audits',
    html`<div class="card-head">
        <h1>Audits</h1>
        <form method="post" action="/audits/run">
          ${csrf(ctx)}<button class="primary" type="submit" ${approver && railway?.configured ? '' : 'disabled'}>Run audit now</button>
        </form>
      </div>
      ${railway?.configured
        ? ''
        : html`<div class="flash flash-error">
            The audit cannot run yet: Railway is not configured. Set <code>RAILWAY_API_TOKEN</code> on the worker;
            see the setup checklist in the repository.
          </div>`}

      <section class="card">
        <h2>Runs</h2>
        ${data.runs.length
          ? html`<table>
              <thead><tr><th>Started</th><th>Trigger</th><th>Result</th><th>Slack</th></tr></thead>
              <tbody>
                ${data.runs.map(
                  (run) => html`<tr>
                    <td><a href="/audits/${run.id}">${when(run.startedAt)}</a></td>
                    <td>${run.trigger}</td>
                    <td>${run.counts ? countsLine(run.counts) : run.error ? html`<span class="bad">${run.error}</span>` : ''}</td>
                    <td>${runStatus(run)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No audit has run yet.</p>`}
      </section>

      <section class="card" id="findings">
        <h2>Findings</h2>
        <p class="row">
          ${(Object.keys(STATE_LABEL) as FindingState[]).map((state) =>
            state === data.state
              ? html`<strong>${STATE_LABEL[state]} (${data.stateCounts[state]})</strong>`
              : html`<a href="/audits?state=${state}#findings">${STATE_LABEL[state]} (${data.stateCounts[state]})</a>`,
          )}
        </p>
        ${data.findings.length
          ? html`<table>
              <thead><tr><th></th><th>Finding</th><th>Category</th><th>First seen</th><th>Fix</th></tr></thead>
              <tbody>${data.findings.map(findingRow)}</tbody>
            </table>`
          : html`<p class="muted">None.</p>`}
      </section>

      ${integrationsCard(data.integrations)}`,
  );
}

const STEP_LABEL: Record<AnalysisStep['key'], string> = {
  service: 'Assessment, per service',
  rollup: 'Ranking and Slack wording',
  brief: 'Fix briefs',
};
const STEP_STATUS: Record<StepStatus, string> = { done: 'Done', partial: 'Partly', skipped: 'Not run', failed: 'Failed' };

function analysisCard(report: AuditReport, calls: CallTotals[]): SafeHtml {
  const analysis = report.analysis;
  if (!analysis) return html``;
  return html`<section class="card" id="analysis">
    <h2>AI analysis</h2>
    <p>
      ${analysis.ranking === 'model'
        ? 'A model ranked this report and worded its findings, from the evidence the checks collected.'
        : analysis.reason
          ? `The rules ranked and worded this report: ${RULES_DETAIL[analysis.reason]}.`
          : 'The rules ranked this report: there was nothing above informational for a model to rank.'}
      <span class="muted">Severity and evidence always come from the checks. A model cannot change either, and cannot start anything.</span>
    </p>
    <table>
      <thead><tr><th>Step</th><th>Result</th><th></th></tr></thead>
      <tbody>
        ${analysis.steps.map(
          (s) => html`<tr>
            <td><strong>${STEP_LABEL[s.key]}</strong></td>
            <td>${s.status === 'failed' ? html`<span class="bad">${STEP_STATUS[s.status]}</span>` : STEP_STATUS[s.status]}</td>
            <td class="muted">${s.detail}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${calls.length ? html`<h3>Model calls</h3>${callsTable(calls)}` : ''}
  </section>`;
}

function reportFindingItem(f: ReportFinding): SafeHtml {
  const tail = history(f);
  const fix = fixText(f.fix);
  return html`<li class="finding">
    <div>${severityBadge(f.severity)}</div>
    <div>
      <a href="/audits/findings/${f.id}"><strong>${f.subject}</strong> ${f.title}</a>
      ${tail ? html`<span class="muted">· ${tail}</span>` : ''}
      ${f.ai ? html`<span class="badge" title="Worded by a model from the evidence the checks collected">AI</span>` : ''}
      <div class="muted small">
        ${f.recommendation}
        ${fix
          ? f.fix.recommendationId
            ? html` · <a href="/approvals/${f.fix.recommendationId}">${fix}</a>`
            : ` · ${fix}`
          : ''}
      </div>
    </div>
  </li>`;
}

export function auditRunPage(ctx: PageContext, data: { run: AuditRun; calls: CallTotals[] }): string {
  const { run } = data;
  const report: AuditReport | null = run.report;
  const approver = hasRole(ctx.session.user, 'approver');
  const head = html`<p><a href="/audits">← Audits</a></p>
    <h1>Audit of ${when(run.startedAt)}</h1>`;

  if (!report || !run.counts) {
    return layout(
      ctx,
      'Audit',
      html`${head}
        <section class="card">
          ${run.status === 'failed'
            ? html`<div class="flash flash-error">This audit failed: ${run.error ?? 'unknown error'}</div>`
            : html`<p class="muted">This audit is still running. Reload in a few minutes.</p>`}
        </section>`,
    );
  }

  const coverage = coverageLines(report.coverage);
  const lines = (items: string[]) => html`<ul class="list">${items.map((l) => html`<li>${l}</li>`)}</ul>`;
  const unfinished = run.status === 'running' || run.status === 'analyzing';
  return layout(
    ctx,
    'Audit',
    html`${head}
      <p>
        ${report.counts.projects} projects · ${report.counts.services} services · <strong>${countsLine(report.counts)}</strong>
        · ${report.counts.info} informational
      </p>
      <p class="muted">
        ${report.windowDays} days from ${report.windowStart.slice(0, 10)} · ${run.trigger} run ·
        ${report.railwayRequests} Railway requests · ${report.counts.resolved} resolved since the last audit ·
        ${report.counts.muted} muted · ${report.counts.accepted} accepted
      </p>

      ${unfinished
        ? html`<div class="flash flash-info">
            ${run.status === 'analyzing'
              ? 'The checks are done and the findings below are in the order the rules give them. A model is assessing them; the report is ranked and posted to Slack when it answers, or by the rules if it does not answer in time.'
              : 'This audit is still finishing. Reload in a minute.'}
          </div>`
        : run.status === 'failed'
          ? html`<div class="flash flash-error">This audit failed after its checks: ${run.error ?? 'unknown error'}</div>`
          : html`<section class="card">
              <div class="card-head">
                <h2>Slack</h2>
                ${!run.postedAt && approver
                  ? html`<form method="post" action="/audits/${run.id}/post">${csrf(ctx)}<button type="submit">Post to Slack now</button></form>`
                  : ''}
              </div>
              <p>${run.postedAt ? html`Posted ${when(run.postedAt)}.` : html`<span class="muted">${run.postError ?? 'Waiting to post.'}</span>`}</p>
            </section>`}

      ${analysisCard(report, data.calls)}

      ${report.unread.length
        ? html`<section class="card">
            <h2>Could not be read</h2>
            <p class="muted">These environments were skipped. Nothing about them is reported as healthy or resolved.</p>
            ${lines(report.unread.map((u) => `${u.projectName} (${u.environmentName}): ${u.reason}`))}
          </section>`
        : ''}

      ${categories.map((category) => {
        const found = report.findings.filter((f) => f.category === category);
        return found.length
          ? html`<section class="card">
              <h2>${CATEGORIES[category]} (${found.length})</h2>
              <ul class="list">${found.map(reportFindingItem)}</ul>
            </section>`
          : '';
      })}
      ${report.findings.length ? '' : html`<section class="card"><p class="muted">No open findings.</p></section>`}

      <section class="card">
        <h2>What was checked</h2>
        <p class="muted">A check that could not read what it needs says so here. It never counts as healthy.</p>
        ${coverage.notRun.length ? html`<h3>Could not run</h3>${lines(coverage.notRun)}` : ''}
        ${coverage.partly.length ? html`<h3>Ran for some services</h3>${lines(coverage.partly)}` : ''}
        <h3>Ran</h3>
        ${lines(coverage.ran)}
      </section>

      <section class="card">
        <h2>Inventory changes</h2>
        ${report.inventory.initial
          ? html`<p class="muted">First inventory. Later audits list what was added, removed or renamed.</p>`
          : report.inventory.changes.length
            ? lines(
                report.inventory.changes.map((c) =>
                  c.change === 'renamed'
                    ? `${c.kind} renamed: ${c.previousName ?? '?'} is now ${c.name} (${c.projectName})`
                    : `${c.kind} ${c.change}: ${c.name}${c.kind === 'project' ? '' : ` (${c.projectName})`}`,
                ),
              )
            : html`<p class="muted">Nothing was added, removed or renamed.</p>`}
      </section>`,
  );
}

export function findingPage(
  ctx: PageContext,
  data: {
    finding: Finding;
    fix: FixInfo;
    recommendation: Recommendation | null;
    agents: AgentRunRecord[];
    stateByName: string;
  },
): string {
  const { finding: f } = data;
  const approver = hasRole(ctx.session.user, 'approver');
  const stateForm = (state: 'open' | 'muted' | 'accepted', label: string, withNote: boolean) =>
    html`<form method="post" action="/audits/findings/${f.id}/state" class="row">
      ${csrf(ctx)}<input type="hidden" name="state" value="${state}" />
      ${withNote ? html`<input name="note" maxlength="300" placeholder="Why (optional)" aria-label="Note" />` : ''}
      <button type="submit">${label}</button>
    </form>`;

  return layout(
    ctx,
    f.title,
    html`<p><a href="/audits">← Audits</a></p>
      <h1>${subject(f.scope)} ${f.title}</h1>
      <p>
        ${severityBadge(f.severity)} <span class="badge">${STATE_LABEL[f.state]}</span>
        <span class="muted">${CATEGORIES[f.category]} · first seen ${when(f.firstSeenAt)} · last seen ${when(f.lastSeenAt)}</span>
      </p>
      ${f.state === 'muted' || f.state === 'accepted'
        ? html`<p class="muted">${STATE_LABEL[f.state]} by ${data.stateByName} ${when(f.stateAt)}${f.stateNote ? `: ${f.stateNote}` : ''}</p>`
        : ''}

      <section class="card">
        <h2>Evidence</h2>
        <ul class="list">
          ${f.evidence.map(
            (e) =>
              html`<li><blockquote>${e.quote}</blockquote>
                <span class="muted">${safeUrl(e.url) ? html`<a href="${e.url}" rel="noreferrer">${e.source}</a>` : e.source}</span></li>`,
          )}
        </ul>
        ${f.cause ? html`<p><strong>Likely cause.</strong> ${f.cause}</p>` : ''}
        <p><strong>Recommended.</strong> ${f.recommendation}</p>
        ${f.assessment
          ? html`<p class="muted small">
                The heading, cause and recommendation were drafted by <code>${f.assessment.model}</code> (prompt
                audit-service/${f.assessment.promptVersion}) from the evidence above, citing:
                “${f.assessment.quote}”. The severity and the evidence come from the check.
              </p>
              <details>
                <summary>What the check itself says</summary>
                <p><strong>${f.rule.title}</strong></p>
                ${f.rule.cause ? html`<p>Likely cause. ${f.rule.cause}</p>` : ''}
                <p>Recommended. ${f.rule.recommendation}</p>
              </details>`
          : ''}
      </section>

      <section class="card">
        <h2>Fix via agent</h2>
        ${f.prUrl && safeUrl(f.prUrl) ? html`<p><a href="${f.prUrl}" rel="noreferrer">Pull request</a> opened by the agent. Patcher never merges it.</p>` : ''}
        ${data.recommendation
          ? html`<p><a href="/approvals/${data.recommendation.id}">Fix recommendation</a>: ${data.recommendation.status}</p>`
          : ''}
        ${data.agents.length
          ? html`<ul class="list">
              ${data.agents.map(
                (a) =>
                  html`<li><span>${safeUrl(a.agentUrl) ? html`<a href="${a.agentUrl}" rel="noreferrer">Agent</a>` : 'Agent'} on
                    <code>${a.repo}</code>: ${a.status.replace('_', ' ')}${a.lastError ? `. ${a.lastError}` : ''}</span>
                    <span class="muted">${when(a.startedAt)}</span></li>`,
              )}
            </ul>`
          : ''}
        ${data.fix.status === 'available'
          ? approver && f.state === 'open'
            ? html`<p class="muted">
                  Drafts a recommendation with the brief for the agent and posts it to Slack. An agent starts on
                  <code>${f.repo ?? ''}</code> only after it is approved, and opens a pull request.
                </p>
                <form method="post" action="/audits/findings/${f.id}/fix">${csrf(ctx)}<button class="primary" type="submit">Propose fix via agent</button></form>`
            : html`<p class="muted">An approver can propose a fix while the finding is open.</p>`
          : data.fix.status === 'unavailable'
            ? html`<p class="muted">Not available: ${data.fix.reason ?? ''}.</p>`
            : data.fix.status === 'none'
              ? html`<p class="muted">A code change does not address this finding.</p>`
              : ''}
      </section>

      ${approver && f.state !== 'resolved'
        ? html`<section class="card">
            <h2>Stop reporting</h2>
            <p class="muted">
              Mute hides the finding from reports. Accept records that the risk is known and will not be fixed. Either
              can be undone.
            </p>
            ${f.state === 'open'
              ? html`${stateForm('muted', 'Mute', true)}${stateForm('accepted', 'Accept risk', true)}`
              : stateForm('open', 'Reopen', false)}
          </section>`
        : ''}`,
  );
}

// Projects ------------------------------------------------------------------------------------

export function projectsPage(
  ctx: PageContext,
  data: { projects: Project[]; unlinked: InventoryProject[]; integrations: IntegrationStatus[]; inventoryAt: Date | null },
): string {
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const count = (p: Project, kind: string) => p.links.filter((l) => l.kind === kind).length;
  return layout(
    ctx,
    'Projects',
    html`<h1>Projects</h1>
      <p class="muted">
        The registry links each project to its Railway projects and repositories. An agent can be started only on a
        repository linked here to an active project.
      </p>

      <section class="card">
        <h2>Registry</h2>
        ${data.projects.length
          ? html`<table>
              <thead><tr><th>Project</th><th>Client</th><th>Status</th><th>Railway projects</th><th>Repositories</th><th>Checks</th></tr></thead>
              <tbody>
                ${data.projects.map(
                  (p) => html`<tr>
                    <td><a href="/projects/${p.id}"><strong>${p.name}</strong></a></td>
                    <td>${p.client}</td><td>${p.status}</td>
                    <td>${count(p, 'railway_project')}</td><td>${count(p, 'repo')}</td><td>${p.checks.length}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No projects yet. Import them from Railway below, or add one by hand.</p>`}
        ${owner
          ? html`<form method="post" action="/projects" class="row add">
              ${csrf(ctx)}
              <input name="name" placeholder="Project name" maxlength="100" required aria-label="Project name" />
              <input name="client" placeholder="Client" maxlength="100" aria-label="Client" />
              <button type="submit">Add project</button>
            </form>`
          : ''}
      </section>

      <section class="card" id="railway">
        <h2>Railway projects not in the registry</h2>
        <p class="muted">
          From the last inventory (${when(data.inventoryAt)}). Importing creates a project linked to the Railway project
          and to the repositories its services deploy from, which allows fixes by an agent on those repositories.
        </p>
        ${data.unlinked.length
          ? html`<form method="post" action="/projects/import">
              ${csrf(ctx)}
              <table>
                <thead><tr><th></th><th>Railway project</th><th>Services</th><th>Repositories</th></tr></thead>
                <tbody>
                  ${data.unlinked.map(
                    (p) => html`<tr>
                      <td><input type="checkbox" name="railway_project" value="${p.id}" aria-label="Import ${p.name}" ${disabled} /></td>
                      <td>${p.name}</td><td>${p.services}</td>
                      <td>${p.repos.length ? p.repos.map((r) => html`<code>${r}</code> `) : html`<span class="muted">none</span>`}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
              <div class="row">
                <button type="submit" ${disabled}>Import selected</button>
                <button type="submit" name="all" value="1" ${disabled}>Import all ${data.unlinked.length}</button>
              </div>
            </form>`
          : html`<p class="muted">
              ${data.inventoryAt ? 'Every Railway project is in the registry.' : 'No inventory yet. It is filled by the first audit or health probe once Railway is configured.'}
            </p>`}
      </section>

      ${integrationsCard(data.integrations)}`,
  );
}

export function projectPage(ctx: PageContext, data: { project: Project; railwayNames: Map<string, string> }): string {
  const { project: p } = data;
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const linkLabel: Record<string, string> = {
    repo: 'Repository',
    railway_project: 'Railway project',
    slack_channel: 'Slack channel',
    contact: 'Contact',
  };
  return layout(
    ctx,
    p.name,
    html`<p><a href="/projects">← Projects</a></p>
      <h1>${p.name}</h1>
      ${owner ? '' : html`<p class="muted">Only an owner can change the registry.</p>`}

      <section class="card">
        <h2>Details</h2>
        <form method="post" action="/projects/${p.id}" class="stack">
          ${csrf(ctx)}
          <label>Name <input name="name" maxlength="100" required value="${p.name}" ${disabled} /></label>
          <label>Client <input name="client" maxlength="100" value="${p.client}" ${disabled} /></label>
          <label>Status
            <select name="status" ${disabled}>
              ${(['active', 'paused', 'archived'] as const).map(
                (s) => html`<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`,
              )}
            </select>
          </label>
          <label>Notes <textarea name="description" rows="3" maxlength="1000" ${disabled}>${p.description}</textarea></label>
          <label>Other names it goes by, separated by commas <input name="aliases" value="${p.aliases.join(', ')}" ${disabled} /></label>
          <label>Email domains, separated by commas <input name="domains" value="${p.domains.join(', ')}" ${disabled} /></label>
          <div><button type="submit" ${disabled}>Save</button></div>
        </form>
        <p class="muted small">Only an active project's repositories can be handed to an agent.</p>
      </section>

      <section class="card" id="links">
        <h2>Links</h2>
        ${p.links.length
          ? html`<table>
              <thead><tr><th>Kind</th><th>Linked to</th><th></th></tr></thead>
              <tbody>
                ${p.links.map(
                  (l) => html`<tr>
                    <td>${linkLabel[l.kind] ?? l.kind}</td>
                    <td>${l.kind === 'railway_project' ? html`${data.railwayNames.get(l.externalId) ?? 'not in the inventory'} <span class="muted small"><code>${l.externalId}</code></span>` : html`<code>${l.externalId}</code>`}</td>
                    <td><form method="post" action="/projects/${p.id}/links/${l.id}/remove">${csrf(ctx)}<button class="danger" type="submit" ${disabled}>Remove</button></form></td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">Nothing linked yet.</p>`}
        ${owner
          ? html`<form method="post" action="/projects/${p.id}/links" class="row add">
              ${csrf(ctx)}
              <select name="kind" aria-label="Kind of link">
                ${LINK_KINDS.map((k) => html`<option value="${k}">${linkLabel[k] ?? k}</option>`)}
              </select>
              <input name="external_id" placeholder="owner/name, Railway project ID, C…, or email" required aria-label="Linked to" />
              <button type="submit">Add link</button>
            </form>`
          : ''}
      </section>

      <section class="card" id="checks">
        <h2>Project-specific checks</h2>
        <p class="muted">
          An address probed every five minutes with a GET. It fails when the status differs or, if set, when the JSON
          reply lacks the expected fields. Public https addresses only.
        </p>
        ${p.checks.length
          ? html`<table>
              <thead><tr><th>Check</th><th>Address</th><th>Expects</th><th></th></tr></thead>
              <tbody>
                ${p.checks.map(
                  (c) => html`<tr>
                    <td>${c.name}</td><td><code>${c.url}</code></td>
                    <td>${c.expectStatus}${c.expectJson ? html` and <code>${JSON.stringify(c.expectJson)}</code>` : ''}</td>
                    <td><form method="post" action="/projects/${p.id}/checks/${c.id}/remove">${csrf(ctx)}<button class="danger" type="submit" ${disabled}>Remove</button></form></td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No checks.</p>`}
        ${owner
          ? html`<form method="post" action="/projects/${p.id}/checks" class="row add">
              ${csrf(ctx)}
              <input name="name" placeholder="Name, e.g. Sync is current" maxlength="80" required aria-label="Check name" />
              <input name="url" type="url" placeholder="https://…" maxlength="500" required aria-label="Address" />
              <input name="expect_status" type="number" min="100" max="599" value="200" aria-label="Expected status" />
              <input name="expect_json" class="mono" placeholder='optional JSON, e.g. {"ok": true}' aria-label="Expected JSON fields" />
              <button type="submit">Add check</button>
            </form>`
          : ''}
      </section>

      ${owner
        ? html`<section class="card">
            <h2>Remove</h2>
            <p class="muted">Removes the project, its links and its checks from the registry. Nothing in Railway or GitHub changes.</p>
            <form method="post" action="/projects/${p.id}/delete">${csrf(ctx)}<button class="danger" type="submit">Remove project</button></form>
          </section>`
        : ''}`,
  );
}
