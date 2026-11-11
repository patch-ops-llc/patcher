import type { Connection } from '../calls/connections.js';
import { MAX_IMPORT_DAYS } from '../calls/connections.js';
import type { CallFilter, CallListItem, ProjectTask } from '../calls/store.js';
import type { Call, CallMatch, CallStatus, CallSuggestion, StoredTranscript } from '../calls/types.js';
import { CALL_STATUS_LABEL, SUGGESTION_LABEL, VENDOR_LABEL, minutes } from '../calls/types.js';
import type { AgentRunRecord } from '../fix/agentFix.js';
import type { Recommendation, RecommendationStatus } from '../recommendations/types.js';
import type { Project } from '../registry/registry.js';
import type { AllSettings } from '../settings/settings.js';
import { PREFERRED_COPIES, settingDefs } from '../settings/settings.js';
import type { User } from '../settings/users.js';
import { hasRole } from '../settings/users.js';
import { usd } from './aiViews.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';
import { callTypeText } from './salesViews.js';
import type { PageContext } from './views.js';
import { csrf, layout, when } from './views.js';

const STATUS_BADGE: Record<CallStatus, string> = {
  received: 'drafted',
  analyzing: 'executing',
  needs_project: 'posted',
  unmatched: 'drafted',
  matched: 'done',
  held: 'drafted',
  failed: 'failed',
  deleted: 'failed',
};

const statusBadge = (status: CallStatus): SafeHtml => html`<span class="badge badge-${STATUS_BADGE[status]}">${CALL_STATUS_LABEL[status]}</span>`;

const REC_LABEL: Record<RecommendationStatus, string> = {
  drafted: 'Waiting to post',
  posted: 'Pending',
  approved: 'Approved',
  executing: 'Running',
  done: 'Done',
  failed: 'Failed',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

const FILTER_LABEL: Record<CallFilter, string> = { all: 'All', needs_answer: 'Needs answer', unmatched: 'Unmatched', waiting: 'Waiting' };
const name = (users: Map<string, User>, id: string | null): string => (id === null ? '' : (users.get(id)?.displayName ?? id));
const safeUrl = (url: string | null | undefined): url is string => Boolean(url && /^https:\/\//.test(url));

export function callsPage(
  ctx: PageContext,
  data: { calls: CallListItem[]; filter: CallFilter; counts: Record<CallFilter, number>; connected: number; enabled: boolean },
): string {
  const approver = hasRole(ctx.session.user, 'approver');
  return layout(
    ctx,
    'Calls',
    html`<div class="card-head">
        <h1>Calls</h1>
        ${approver ? html`<a class="button" href="/calls/upload">Add a transcript</a>` : ''}
      </div>
      ${data.enabled
        ? ''
        : html`<div class="flash flash-error">Calls are switched off in <a href="/settings#calls">Settings</a>. Nothing is collected or analysed.</div>`}
      ${data.connected
        ? ''
        : html`<div class="flash flash-info">
            No call source is connected. Connect Calendly or Fathom in <a href="/settings#calls">Settings</a>, or add a transcript by hand.
          </div>`}
      <section class="card">
        <p class="row">
          ${(Object.keys(FILTER_LABEL) as CallFilter[]).map((f) =>
            f === data.filter
              ? html`<strong>${FILTER_LABEL[f]} (${data.counts[f]})</strong>`
              : html`<a href="/calls?show=${f}">${FILTER_LABEL[f]} (${data.counts[f]})</a>`,
          )}
        </p>
        ${data.calls.length
          ? html`<table>
              <thead><tr><th>Call</th><th>When</th><th>Type</th><th>Host</th><th>From</th><th>Project</th><th>Status</th><th>Suggestions</th></tr></thead>
              <tbody>
                ${data.calls.map(
                  (c) => html`<tr>
                    <td><a href="/calls/${c.id}">${c.title}</a>${c.durationSeconds ? html` <span class="muted small">${minutes(c.durationSeconds)}</span>` : ''}</td>
                    <td>${when(c.startedAt ?? c.createdAt)}</td>
                    <td>${c.callType ? callTypeText(c) : html`<span class="muted">not read</span>`}</td>
                    <td>${c.hostEmail ?? html`<span class="muted">unknown</span>`}</td>
                    <td>${c.sources.map((s) => VENDOR_LABEL[s as keyof typeof VENDOR_LABEL] ?? s).join(' + ')}</td>
                    <td>${c.projects.length ? c.projects.join(', ') : html`<span class="muted">none</span>`}</td>
                    <td>${statusBadge(c.status)}${c.statusDetail ? html`<div class="muted small">${c.statusDetail}</div>` : ''}</td>
                    <td>${c.suggestions ? html`${c.suggestions}${c.pending ? html` <span class="muted">(${c.pending} pending)</span>` : ''}` : ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">None.</p>`}
      </section>`,
  );
}

export interface CallPageData {
  call: Call;
  transcripts: StoredTranscript[];
  matches: CallMatch[];
  suggestions: CallSuggestion[];
  recommendations: Recommendation[];
  agents: AgentRunRecord[];
  projects: Project[];
  /** Outside e-mail domains on the call that a project could be taught. */
  domains: string[];
  users: Map<string, User>;
  /** The preferred copy's text, for checking a quote against what was said. */
  text: string | null;
  /** The call's type and what the sales pipeline made of it, built by the sales screens. */
  salesCard: SafeHtml;
}

function suggestionItem(s: CallSuggestion, data: CallPageData): SafeHtml {
  const rec = data.recommendations.find((r) => r.id === s.recommendationId);
  const agent = rec ? data.agents.filter((a) => a.recommendationId === rec.id).at(-1) : undefined;
  const project = data.matches.find((m) => m.projectId === s.projectId)?.projectName;
  return html`<li>
    <strong>${s.position}. ${s.title}</strong>
    <span class="muted">${SUGGESTION_LABEL[s.type]}${data.matches.filter((m) => m.state === 'matched').length > 1 && project ? ` · ${project}` : ''}${s.repo ? html` · <code>${s.repo}</code>` : ''}</span>
    ${rec
      ? html` <a href="/approvals/${rec.id}"><span class="badge badge-${rec.status}">${REC_LABEL[rec.status]}</span></a>
          ${rec.decidedBy ? html`<span class="muted small">by ${name(data.users, rec.decidedBy)}</span>` : ''}`
      : s.type === 'note'
        ? html` <span class="muted small">for awareness, nothing to approve</span>`
        : ''}
    ${agent
      ? html`<div class="small">
          Agent: ${agent.status.replace('_', ' ')}
          ${safeUrl(agent.prUrl) ? html` · <a href="${agent.prUrl}" rel="noreferrer">pull request</a>` : ''}
          ${safeUrl(agent.agentUrl) ? html` · <a href="${agent.agentUrl}" rel="noreferrer">agent</a>` : ''}
        </div>`
      : ''}
    <blockquote>${s.quote}${s.quoteAt ? html` <span class="muted">(at ${s.quoteAt})</span>` : ''}</blockquote>
    ${s.detail ? html`<p>${s.detail}</p>` : ''}
    ${s.typeNote
      ? html`<p class="muted small">${s.draftedType === 'code_change' ? `Not offered as a code change: ${s.typeNote}.` : `${s.typeNote}.`}</p>`
      : ''}
    ${s.draft ? html`<details><summary>Drafted message</summary><p class="pre">${s.draft}</p></details>` : ''}
    ${s.brief ? html`<details><summary>Brief for the agent, as drafted</summary><pre>${s.brief}</pre></details>` : ''}
  </li>`;
}

export function callPage(ctx: PageContext, data: CallPageData): string {
  const { call } = data;
  const approver = hasRole(ctx.session.user, 'approver');
  const owner = hasRole(ctx.session.user, 'owner');
  const matched = data.matches.filter((m) => m.state === 'matched');
  const candidates = data.matches.filter((m) => m.state === 'candidate');
  const current = matched[0]?.projectId ?? '';
  const canChange = approver && call.status !== 'deleted';

  const matchRow = (m: CallMatch): SafeHtml => html`<tr>
    <td><a href="/projects/${m.projectId}">${m.projectName}</a></td>
    <td>${m.source === 'person' ? `chosen by ${name(data.users, m.decidedBy)}` : m.confidence.toFixed(2)}</td>
    <td>
      ${m.evidence.quote ? html`<blockquote>${m.evidence.quote}${m.evidence.at ? html` <span class="muted">(at ${m.evidence.at})</span>` : ''}</blockquote>` : ''}
      ${(m.evidence.hints ?? []).map((hint) => html`<div class="muted small">${hint}</div>`)}
    </td>
  </tr>`;

  return layout(
    ctx,
    call.title,
    html`<p><a href="/calls">← Calls</a></p>
      <h1>${call.title}</h1>
      <p>
        ${statusBadge(call.status)}
        <span class="muted">${when(call.startedAt ?? call.createdAt)}${call.durationSeconds ? ` · ${minutes(call.durationSeconds)}` : ''}</span>
      </p>
      ${call.statusDetail ? html`<div class="flash flash-info">${call.statusDetail}</div>` : ''}
      ${call.postError
        ? html`<div class="flash flash-error">
            ${call.postError}
            ${approver ? html`<form method="post" action="/calls/${call.id}/post">${csrf(ctx)}<button type="submit">Post to Slack now</button></form>` : ''}
          </div>`
        : ''}

      ${call.summary ? html`<section class="card"><h2>Summary</h2><p>${call.summary}</p></section>` : ''}

      <section class="card" id="project">
        <h2>Project</h2>
        ${matched.length
          ? html`<table>
              <thead><tr><th>Matched to</th><th>Confidence</th><th>Why</th></tr></thead>
              <tbody>${matched.map(matchRow)}</tbody>
            </table>`
          : html`<p class="muted">Not matched to a project.</p>`}
        ${candidates.length
          ? html`<h3>${call.status === 'needs_project' ? 'Asked in Slack: which of these?' : 'Closest'}</h3>
              <table>
                <thead><tr><th>Project</th><th>Confidence</th><th>Why</th></tr></thead>
                <tbody>${candidates.map(matchRow)}</tbody>
              </table>`
          : ''}
        ${canChange
          ? html`<form method="post" action="/calls/${call.id}/project" class="stack">
              ${csrf(ctx)}
              <label>${matched.length ? 'Move to another project' : 'Set the project'}
                <select name="project_id" required>
                  <option value="">Choose…</option>
                  ${data.projects.map((p) => html`<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${p.name}${p.client ? ` (${p.client})` : ''}</option>`)}
                  <option value="none">None of these</option>
                </select>
              </label>
              ${owner && data.domains.length
                ? html`<fieldset>
                    <legend>Teach the registry, so the next call matches by itself</legend>
                    ${data.domains.map(
                      (d) => html`<label class="check"><input type="checkbox" name="save_domain" value="${d}" /> Save <code>${d}</code> as an e-mail domain of the project</label>`,
                    )}
                  </fieldset>`
                : ''}
              ${owner ? html`<label>Also save this name for the project (optional) <input name="save_alias" maxlength="100" placeholder="a name the call uses for it" /></label>` : ''}
              <div><button type="submit">Save project</button></div>
            </form>
            <p class="muted small">Suggestions still waiting for a decision are closed, and new ones are drafted for the project you choose.</p>`
          : ''}
      </section>

      <section class="card" id="suggestions">
        <h2>Suggestions</h2>
        ${data.suggestions.length
          ? html`<ul class="list">${data.suggestions.map((s) => suggestionItem(s, data))}</ul>`
          : html`<p class="muted">${call.status === 'matched' && call.suggestedVersion === call.version ? 'The call asked for nothing on this project.' : 'None yet.'}</p>`}
        ${canChange
          ? html`<form method="post" action="/calls/${call.id}/analyze">
              ${csrf(ctx)}<button type="submit">Analyse again</button>
              <span class="muted small">Matches the call from scratch. Suggestions still waiting are closed.</span>
            </form>`
          : ''}
      </section>

      ${data.salesCard}

      <section class="card" id="people">
        <h2>Who was on it</h2>
        <p>Host: ${call.hostEmail ? html`<code>${call.hostEmail}</code>` : html`<span class="muted">not given by the source</span>`}</p>
        ${call.attendees.length
          ? html`<table class="dense">
              <thead><tr><th>Name</th><th>Address</th><th></th></tr></thead>
              <tbody>
                ${call.attendees.map(
                  (a) => html`<tr>
                    <td>${a.name ?? ''}</td>
                    <td>${a.email ? html`<code>${a.email}</code>` : html`<span class="muted">none</span>`}</td>
                    <td class="muted small">${a.external === true ? 'outside' : a.external === false ? 'inside' : ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">The source gave no attendee list.</p>`}
      </section>

      <section class="card" id="copies">
        <h2>Recordings of this call</h2>
        <table class="dense">
          <thead><tr><th>From</th><th>Title</th><th>Started</th><th>Addresses it carried</th><th>Shape</th><th>Kept until</th><th></th></tr></thead>
          <tbody>
            ${data.transcripts.map(
              (t) => html`<tr>
                <td>${VENDOR_LABEL[t.source]}${t.isPreferred ? html` <span class="badge badge-done">analysed</span>` : html` <span class="muted small">duplicate</span>`}</td>
                <td>${t.title}</td>
                <td>${when(t.startedAt)}</td>
                <td class="small">
                  ${t.hostEmail ? html`<div>host <code>${t.hostEmail}</code></div>` : html`<div class="muted">no host address</div>`}
                  ${t.attendees.filter((a) => a.email).map((a) => html`<div><code>${a.email}</code></div>`)}
                </td>
                <td class="muted small">${t.hasSpeakers ? 'speakers' : 'no speakers'}${t.hasTimestamps ? ', timestamps' : ''}</td>
                <td>${t.purgedAt ? html`<span class="muted">text removed ${when(t.purgedAt)}</span>` : when(t.purgeAfter)}</td>
                <td>${safeUrl(t.url) ? html`<a href="${t.url}" rel="noreferrer">Open at source</a>` : ''}</td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${data.text
          ? html`<details><summary>Transcript that was analysed</summary><pre>${data.text}</pre></details>`
          : html`<p class="muted small">The transcript text is no longer stored.</p>`}
      </section>`,
  );
}

export function uploadPage(ctx: PageContext): string {
  return layout(
    ctx,
    'Add a transcript',
    html`<p><a href="/calls">← Calls</a></p>
      <h1>Add a transcript</h1>
      <section class="card">
        <p class="muted">
          For a call recorded some other way. Paste the text; lines like <code>[00:01:23] Name: words</code> or
          <code>Name: words</code> keep their speakers and times. It is matched and analysed like any other call.
        </p>
        <form method="post" action="/calls/upload" class="stack">
          ${csrf(ctx)}
          <label>Title <input name="title" maxlength="200" required placeholder="What the call was" /></label>
          <label>When it started (optional) <input name="started_at" type="datetime-local" /></label>
          <label>Transcript <textarea name="text" rows="18" required class="mono"></textarea></label>
          <div><button class="primary" type="submit">Add</button></div>
        </form>
      </section>`,
  );
}

const CONNECTION_STATUS: Record<Connection['status'], SafeHtml> = {
  pending: html`<span class="badge badge-drafted">Checking</span>`,
  connected: html`<span class="badge badge-done">Connected</span>`,
  error: html`<span class="badge badge-failed">Error</span>`,
  disconnected: html`<span class="badge badge-failed">Key refused</span>`,
};

/** The Settings card for calls: the connected sources, the switches, and the model settings for calls. */
export function callsSettingsCard(
  ctx: PageContext,
  data: {
    connections: Connection[];
    settings: AllSettings;
    canSeal: boolean;
    ai: { configured: boolean | null; spentDay: number; spentMonth: number };
  },
): SafeHtml {
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const s = data.settings;
  const number = (key: 'calls.settle_minutes' | 'calls.retention_days' | 'ai.calls.max_suggestions' | 'ai.calls.transcript_token_cap', min: number, max: number) =>
    html`<label>${settingDefs[key].label} <input type="number" name="${key}" min="${min}" max="${max}" value="${s[key]}" ${disabled} /></label>`;
  const hasCalendly = data.connections.some((c) => c.source === 'calendly');

  return html`<section class="card" id="calls">
    <h2>Calls</h2>
    <p class="muted">
      Transcripts come from Calendly Notetaker and Fathom by webhook, with a poll every 15 minutes for anything missed.
      A key is stored encrypted, can be read only by the worker, and is never shown again.
    </p>

    <h3>Sources</h3>
    ${data.connections.length
      ? html`<table>
          <thead><tr><th>Source</th><th>Whose key</th><th>Status</th><th>Webhook</th><th>Last success</th><th></th></tr></thead>
          <tbody>
            ${data.connections.map(
              (c) => html`<tr>
                <td>${VENDOR_LABEL[c.source]}${c.source === 'fathom' ? html`<div class="muted small">${c.scope === 'team' ? 'team key' : 'personal key'}</div>` : ''}</td>
                <td>${c.owner}${c.accountLabel && c.accountLabel !== c.owner ? html`<div class="muted small">${c.accountLabel}</div>` : ''}</td>
                <td>${CONNECTION_STATUS[c.status]}${c.lastError ? html`<div class="bad small">${c.lastError}</div>` : ''}</td>
                <td>${c.hasWebhook ? 'Registered' : html`<span class="muted">Poll only</span>`}${c.webhookNote ? html`<div class="muted small">${c.webhookNote}</div>` : ''}</td>
                <td>${when(c.lastOkAt)}</td>
                <td>
                  <div class="row">
                    ${c.status !== 'connected' && c.hasKey
                      ? html`<form method="post" action="/settings/calls/connections/${c.id}/retry">${csrf(ctx)}<button type="submit" ${disabled}>Check again</button></form>`
                      : ''}
                    <form method="post" action="/settings/calls/connections/${c.id}/remove">${csrf(ctx)}<button class="danger" type="submit" ${disabled}>Remove</button></form>
                  </div>
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`
      : html`<p class="muted">No source is connected.</p>`}
    ${owner
      ? data.canSeal
        ? html`<form method="post" action="/settings/calls/connections" class="row add" autocomplete="off">
            ${csrf(ctx)}
            <select name="source" aria-label="Source">
              ${hasCalendly ? '' : html`<option value="calendly">Calendly (personal access token)</option>`}
              <option value="fathom:team">Fathom, one key for the team</option>
              <option value="fathom:personal">Fathom, a teammate's own key</option>
            </select>
            <input name="owner" maxlength="100" required placeholder="Whose key, e.g. a name" aria-label="Whose key" />
            <input name="key" type="password" required minlength="8" maxlength="2000" placeholder="Token or API key" aria-label="Token or API key" autocomplete="off" />
            <label>Earlier calls, days <input name="import_days" type="number" min="0" max="${MAX_IMPORT_DAYS}" value="0" /></label>
            <button type="submit">Connect</button>
          </form>
          <p class="muted small">
            Calendly: a personal access token with the scopes <code>meeting_recaps:read</code>, <code>users:read</code> and
            <code>webhooks:write</code>. Fathom: an API key from the person's Fathom settings; a team key should belong to an
            admin who can view all shared calls. The webhook is registered for you when the key is checked.
          </p>`
        : html`<div class="flash flash-error">
            A key cannot be stored yet: <code>TOKEN_PUBLIC_KEY</code> is not set on the web service. See the setup checklist in the repository.
          </div>`
      : ''}

    <h3>Settings</h3>
    ${data.ai.configured === false
      ? html`<div class="flash flash-error">No model is configured, so calls are collected and wait unanalysed. Set <code>ANTHROPIC_API_KEY</code> on the worker.</div>`
      : ''}
    <form method="post" action="/settings/calls" class="stack">
      ${csrf(ctx)}
      <label class="check"><input type="checkbox" name="calls.enabled" value="1" ${s['calls.enabled'] ? 'checked' : ''} ${disabled} /> ${settingDefs['calls.enabled'].label}</label>
      <label class="check"><input type="checkbox" name="ai.calls.enabled" value="1" ${s['ai.calls.enabled'] ? 'checked' : ''} ${disabled} /> ${settingDefs['ai.calls.enabled'].label}</label>
      ${number('calls.settle_minutes', 0, 240)}
      <label>${settingDefs['calls.preferred_copy'].label}
        <select name="calls.preferred_copy" ${disabled}>
          ${PREFERRED_COPIES.map((p) => html`<option value="${p}" ${s['calls.preferred_copy'] === p ? 'selected' : ''}>${PREFERRED_LABEL[p]}</option>`)}
        </select>
      </label>
      ${number('calls.retention_days', 1, 3650)}
      <label>${settingDefs['calls.internal_domains'].label}
        <input name="calls.internal_domains" value="${s['calls.internal_domains']}" placeholder="youragency.com, another.com" ${disabled} /></label>
      <label>${settingDefs['ai.calls.auto_match_confidence'].label}
        <input type="number" name="ai.calls.auto_match_confidence" min="0.5" max="1" step="0.01" value="${s['ai.calls.auto_match_confidence']}" ${disabled} /></label>
      <label>${settingDefs['ai.calls.ask_confidence'].label}
        <input type="number" name="ai.calls.ask_confidence" min="0" max="1" step="0.01" value="${s['ai.calls.ask_confidence']}" ${disabled} /></label>
      ${number('ai.calls.max_suggestions', 1, 5)}
      ${(['ai.calls.model_match', 'ai.calls.model_suggest', 'ai.calls.model_brief'] as const).map(
        (key) => html`<label>${settingDefs[key].label} <input name="${key}" value="${s[key]}" required class="mono" ${disabled} /></label>`,
      )}
      <label>${settingDefs['ai.calls.daily_budget_usd'].label}
        <input type="number" name="ai.calls.daily_budget_usd" min="0" max="10000" step="0.01" value="${s['ai.calls.daily_budget_usd']}" ${disabled} /></label>
      <label>${settingDefs['ai.calls.monthly_budget_usd'].label}
        <input type="number" name="ai.calls.monthly_budget_usd" min="0" max="100000" step="0.01" value="${s['ai.calls.monthly_budget_usd']}" ${disabled} /></label>
      ${number('ai.calls.transcript_token_cap', 2000, 150000)}
      <div><button type="submit" ${disabled}>Save</button></div>
    </form>
    <p class="muted small">
      Spent on model calls for calls: ${usd(data.ai.spentDay)} in the last 24 hours, ${usd(data.ai.spentMonth)} in the last 30 days, at list prices.
      The table under AI above lists them by task. Suggestions post to the channel routed for Calls.
    </p>
  </section>`;
}

const PREFERRED_LABEL: Record<(typeof PREFERRED_COPIES)[number], string> = {
  speakers: 'The one with speaker labels, then the longer one',
  longest: 'The longer one',
  calendly: 'Calendly',
  fathom: 'Fathom',
};

/** The project page's card for what approved call suggestions left behind. */
export function projectTasksCard(ctx: PageContext, project: Pick<Project, 'id'>, tasks: ProjectTask[], users: Map<string, User>): SafeHtml {
  const approver = hasRole(ctx.session.user, 'approver');
  return html`<section class="card" id="tasks">
    <h2>Tasks and follow-ups from calls</h2>
    ${tasks.length
      ? html`<ul class="list">
          ${tasks.map(
            (t) => html`<li>
              <strong>${t.title}</strong>
              <span class="muted">${t.kind === 'followup' ? 'Follow-up to send' : 'Task'} · ${when(t.createdAt)}</span>
              ${t.status === 'done' ? html`<span class="badge badge-done">Done</span> <span class="muted small">${name(users, t.doneBy)}</span>` : ''}
              ${t.body ? html`<p class="pre">${t.body}</p>` : ''}
              <div class="row">
                ${t.callId ? html`<a href="/calls/${t.callId}">The call</a>` : ''}
                ${approver
                  ? html`<form method="post" action="/projects/${project.id}/tasks/${t.id}/${t.status === 'done' ? 'reopen' : 'done'}">
                      ${csrf(ctx)}<button type="submit">${t.status === 'done' ? 'Reopen' : t.kind === 'followup' ? 'Mark sent' : 'Mark done'}</button>
                    </form>`
                  : ''}
              </div>
            </li>`,
          )}
        </ul>`
      : html`<p class="muted">Nothing yet. An approved task or follow-up from a call is kept here.</p>`}
  </section>`;
}
