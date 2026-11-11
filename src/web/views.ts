import type { PromptTask } from '../ai/prompts.js';
import type { CallTotals } from '../ai/run.js';
import type { AuditRow } from '../audit/auditLog.js';
import type { QueueStats } from '../queue/queue.js';
import type { ActionRecord, ApprovalRecord, Recommendation, RecommendationStatus } from '../recommendations/types.js';
import type { Schedule } from '../scheduler/schedules.js';
import type { ChannelRoute, ReportType, SlackChannel } from '../settings/routes.js';
import { REPORT_TYPES, reportTypes } from '../settings/routes.js';
import type { AllSettings } from '../settings/settings.js';
import { settingDefs } from '../settings/settings.js';
import type { Role, User } from '../settings/users.js';
import { ROLES, hasRole } from '../settings/users.js';
import { callsTable, usd } from './aiViews.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';
import type { Flash, Session } from './session.js';

export interface PageContext {
  session: Session;
  flash: Flash | null;
  paused: boolean;
  dryRun: boolean;
  path: string;
}

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/audits', label: 'Audits' },
  { href: '/calls', label: 'Calls' },
  { href: '/sales', label: 'Sales' },
  { href: '/projects', label: 'Projects' },
  { href: '/settings', label: 'Settings' },
  { href: '/activity', label: 'Activity' },
];

export const when = (date: Date | null | undefined): SafeHtml =>
  date
    ? html`<time datetime="${date.toISOString()}" title="${date.toISOString()}">${date
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')} UTC</time>`
    : html`<span class="muted">never</span>`;

export const csrf = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.session.csrfToken}" />`;

const personName = (users: Map<string, User>, id: string | null): string =>
  id === null ? '' : id === 'system' ? 'Patcher' : (users.get(id)?.displayName ?? id);

const STATUS_LABEL: Record<RecommendationStatus, string> = {
  drafted: 'Waiting to post',
  posted: 'Pending',
  approved: 'Approved',
  executing: 'Running',
  done: 'Done',
  failed: 'Failed',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

const statusBadge = (status: RecommendationStatus) =>
  html`<span class="badge badge-${status}">${STATUS_LABEL[status]}</span>`;

function document(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title} · Patcher</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    ${body}
  </body>
</html>`.toString();
}

export function layout(ctx: PageContext, title: string, content: SafeHtml): string {
  const user = ctx.session.user;
  const active = (href: string) => (href === '/' ? ctx.path === '/' : ctx.path.startsWith(href));
  return document(
    title,
    html`<header class="topbar">
        <a class="brand" href="/">Patcher</a>
        <nav>
          ${NAV.map(
            (item) => html`<a href="${item.href}" class="${active(item.href) ? 'active' : ''}">${item.label}</a>`,
          )}
        </nav>
        <div class="who">
          ${ctx.dryRun ? html`<span class="badge badge-dry">Dry run</span>` : ''}
          <span>${user.displayName ?? user.slackUserId} · ${user.role}</span>
          <form method="post" action="/logout">${csrf(ctx)}<button class="link" type="submit">Sign out</button></form>
        </div>
      </header>
      ${ctx.paused
        ? html`<div class="banner banner-paused">
            <span><strong>Paused.</strong> Nothing is posted, approved or run until Patcher is resumed.</span>
            ${hasRole(user, 'owner')
              ? html`<form method="post" action="/resume">${csrf(ctx)}<button type="submit">Resume</button></form>`
              : ''}
          </div>`
        : ''}
      <main>
        ${ctx.flash ? html`<div class="flash flash-${ctx.flash.kind}" role="status">${ctx.flash.text}</div>` : ''}
        ${content}
      </main>`,
  );
}

// Sign-in -----------------------------------------------------------------------------------

export function loginPage(options: { configured: boolean; error?: string | undefined }): string {
  return document(
    'Sign in',
    html`<main class="center">
      <div class="card login">
        <h1>Patcher</h1>
        <p class="muted">PatchOps operations bot</p>
        ${options.error ? html`<div class="flash flash-error" role="alert">${options.error}</div>` : ''}
        ${options.configured
          ? html`<a class="button primary" href="/auth/slack">Sign in with Slack</a>
              <p class="muted small">PatchOps workspace members on the access list only.</p>`
          : html`<div class="flash flash-error" role="alert">
              Sign in with Slack is not configured yet. The Slack app's variables have not been set on this
              service; see the setup checklist in the repository.
            </div>`}
      </div>
    </main>`,
  );
}

export function errorPage(status: number, message: string): string {
  return document(
    String(status),
    html`<main class="center">
      <div class="card login">
        <h1>${status}</h1>
        <p>${message}</p>
        <a class="button" href="/">Back to Patcher</a>
      </div>
    </main>`,
  );
}

// Home ----------------------------------------------------------------------------------------

export interface RunRow {
  pipeline: string;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  ok: boolean | null;
  summary: string | null;
}

export function homePage(
  ctx: PageContext,
  data: {
    counts: Record<RecommendationStatus, number>;
    pending: Recommendation[];
    schedules: Schedule[];
    failures: RunRow[];
    queue: QueueStats;
    labelFor: (kind: string) => string;
    slackReady: boolean;
  },
): string {
  const user = ctx.session.user;
  return layout(
    ctx,
    'Home',
    html`<h1>Home</h1>
      ${data.slackReady
        ? ''
        : html`<div class="flash flash-error">
            Slack is not fully configured, so nothing can be posted or approved from Slack yet. See the setup
            checklist in the repository.
          </div>`}
      <section class="stats">
        <a class="stat" href="/approvals"><span class="n">${data.counts.posted}</span><span>Pending approvals</span></a>
        <a class="stat" href="/approvals"><span class="n">${data.counts.drafted}</span><span>Waiting to post</span></a>
        <a class="stat" href="/approvals"><span class="n">${data.counts.failed}</span><span>Failed actions</span></a>
        <div class="stat"><span class="n">${data.queue.depth}</span><span>Jobs queued</span></div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Global pause</h2>
          ${ctx.paused
            ? hasRole(user, 'owner')
              ? html`<form method="post" action="/resume">${csrf(ctx)}<button class="primary" type="submit">Resume</button></form>`
              : html`<span class="muted">Only an owner can resume.</span>`
            : hasRole(user, 'approver')
              ? html`<form method="post" action="/pause">${csrf(ctx)}<button class="danger" type="submit">Pause everything</button></form>`
              : ''}
        </div>
        <p class="muted">
          ${ctx.paused
            ? 'Patcher is paused.'
            : 'Patcher is running. Pausing stops new posts, approvals, actions and schedules. The same switch is /ops pause in Slack.'}
        </p>
      </section>

      <section class="card">
        <div class="card-head"><h2>Pending approvals</h2><a href="/approvals">All approvals</a></div>
        ${data.pending.length
          ? html`<ul class="list">
              ${data.pending.map(
                (r) =>
                  html`<li><a href="/approvals/${r.id}"><strong>${data.labelFor(r.kind)}</strong> · ${r.title}</a>
                    <span class="muted">${when(r.postedAt)}</span></li>`,
              )}
            </ul>`
          : html`<p class="muted">Nothing is waiting for a decision.</p>`}
      </section>

      <section class="card">
        <h2>Last run of each pipeline</h2>
        <table>
          <thead><tr><th>Pipeline</th><th>Last run</th><th>Result</th></tr></thead>
          <tbody>
            ${data.schedules.map(
              (s) =>
                html`<tr><td><code>${s.key}</code></td><td>${when(s.lastRunAt)}</td>
                  <td>${s.lastOk === null ? html`<span class="muted">n/a</span>` : s.lastOk ? 'OK' : html`<span class="bad">Failed</span>`}</td></tr>`,
            )}
          </tbody>
        </table>
      </section>

      <section class="card">
        <div class="card-head"><h2>Recent failures</h2><a href="/activity">Activity</a></div>
        ${data.failures.length
          ? html`<table>
              <thead><tr><th>When</th><th>Where</th><th>What</th></tr></thead>
              <tbody>
                ${data.failures.map(
                  (f) => html`<tr><td>${when(f.started_at)}</td><td><code>${f.pipeline}</code></td><td>${f.summary ?? ''}</td></tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No failures recorded.</p>`}
      </section>`,
  );
}

// Approvals -----------------------------------------------------------------------------------

function recRow(r: Recommendation, labelFor: (kind: string) => string, users: Map<string, User>): SafeHtml {
  return html`<tr>
    <td><a href="/approvals/${r.id}"><strong>${labelFor(r.kind)}</strong> · ${r.title}</a>
      ${r.status === 'drafted' && r.lastError ? html`<div class="muted small">${r.lastError}</div>` : ''}</td>
    <td>${statusBadge(r.status)}</td>
    <td>${personName(users, r.decidedBy)}</td>
    <td>${when(r.decidedAt ?? r.postedAt ?? r.createdAt)}</td>
  </tr>`;
}

export function approvalsPage(
  ctx: PageContext,
  data: {
    pending: Recommendation[];
    waiting: Recommendation[];
    recent: Recommendation[];
    labelFor: (kind: string) => string;
    users: Map<string, User>;
  },
): string {
  const table = (rows: Recommendation[], empty: string) =>
    rows.length
      ? html`<table>
          <thead><tr><th>Recommendation</th><th>Status</th><th>Decided by</th><th>When</th></tr></thead>
          <tbody>${rows.map((r) => recRow(r, data.labelFor, data.users))}</tbody>
        </table>`
      : html`<p class="muted">${empty}</p>`;
  return layout(
    ctx,
    'Approvals',
    html`<h1>Approvals</h1>
      <section class="card"><h2>Pending</h2>${table(data.pending, 'Nothing is waiting for a decision.')}</section>
      ${data.waiting.length
        ? html`<section class="card">
            <h2>Waiting to post</h2>
            <p class="muted">Drafted but not in Slack yet. Each row says what it is waiting for.</p>
            ${table(data.waiting, '')}
          </section>`
        : ''}
      <section class="card"><h2>Recently decided</h2>${table(data.recent, 'No decisions yet.')}</section>`,
  );
}

export function approvalDetailPage(
  ctx: PageContext,
  data: {
    rec: Recommendation;
    label: string;
    actionDescription: string;
    approvals: ApprovalRecord[];
    actions: ActionRecord[];
    users: Map<string, User>;
    canDecide: boolean;
  },
): string {
  const { rec } = data;
  const hash = html`<input type="hidden" name="hash" value="${rec.actionHash}" />`;
  const post = (action: string, label: string, cls = '') =>
    html`<form method="post" action="/approvals/${rec.id}/${action}">${csrf(ctx)}${hash}<button class="${cls}" type="submit">${label}</button></form>`;

  const buttons =
    !data.canDecide
      ? html`<p class="muted">You can view this but not decide it.</p>`
      : rec.status === 'posted'
        ? html`<div class="row">${post('approve', 'Approve', 'primary')}${post('dismiss', 'Dismiss')}</div>`
        : rec.status === 'failed'
          ? html`<div class="row">${post('retry', 'Retry', 'primary')}</div>`
          : rec.status === 'drafted'
            ? html`<div class="row">${post('post', 'Post to Slack now')}</div>`
            : '';

  return layout(
    ctx,
    rec.title,
    html`<p><a href="/approvals">← Approvals</a></p>
      <h1>${data.label} · ${rec.title}</h1>
      <p>${statusBadge(rec.status)} <span class="muted">version ${rec.version} · ${rec.risk} risk · created ${when(rec.createdAt)}</span></p>
      ${rec.lastError ? html`<div class="flash flash-error">${rec.lastError}</div>` : ''}

      <section class="card">
        <h2>Summary</h2>
        ${rec.body ? html`<p class="pre">${rec.body}</p>` : html`<p class="muted">No summary.</p>`}
        ${buttons}
      </section>

      <section class="card">
        <h2>What approval does</h2>
        <p>${data.actionDescription}</p>
        <pre>${JSON.stringify(rec.action, null, 2)}</pre>
        <p class="muted small">Content hash <code>${rec.actionHash.slice(0, 16)}…</code>. An approval applies to this exact content.</p>
      </section>

      <section class="card">
        <h2>Evidence</h2>
        <ul class="list">
          ${rec.evidence.map(
            (e) =>
              html`<li><blockquote>${e.quote}</blockquote>
                <span class="muted">${e.url && /^https?:\/\//.test(e.url) ? html`<a href="${e.url}" rel="noreferrer">${e.source}</a>` : e.source}</span></li>`,
          )}
        </ul>
      </section>

      ${data.canDecide && rec.status === 'posted'
        ? html`<section class="card">
            <h2>Edit</h2>
            <p class="muted">Saving makes a new version. Buttons on the old version stop working.</p>
            <form method="post" action="/approvals/${rec.id}/edit" class="stack">
              ${csrf(ctx)}${hash}
              <label>Title <input name="title" maxlength="150" required value="${rec.title}" /></label>
              <label>Summary <textarea name="body" rows="4" maxlength="2000">${rec.body}</textarea></label>
              <label>Action parameters (${rec.action.type}), as JSON
                <textarea name="params" rows="5" class="mono" required>${JSON.stringify(rec.action.params, null, 2)}</textarea></label>
              <div><button type="submit">Save new version</button></div>
            </form>
          </section>`
        : ''}

      <section class="card">
        <h2>History</h2>
        ${data.approvals.length || data.actions.length
          ? html`<table>
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Where</th></tr></thead>
              <tbody>
                ${data.approvals.map(
                  (a) =>
                    html`<tr><td>${when(a.at)}</td><td>${personName(data.users, a.actor)}</td>
                      <td>${a.decision} (version ${a.version})</td><td>${a.via === 'ui' ? 'Patcher' : 'Slack'}</td></tr>`,
                )}
                ${data.actions.map(
                  (a) =>
                    html`<tr><td></td><td>Patcher</td>
                      <td>Action <code>${a.type}</code>: ${a.status}${a.dryRun ? ' (dry run)' : ''}${a.lastError ? `: ${a.lastError}` : ''}
                        ${a.externalRef ? html`<span class="muted">${a.externalRef}</span>` : ''}</td>
                      <td>attempt ${a.attempts}</td></tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No decisions yet.</p>`}
      </section>`,
  );
}

// Settings ------------------------------------------------------------------------------------

export function settingsPage(
  ctx: PageContext,
  data: {
    routes: Map<ReportType, ChannelRoute>;
    channels: SlackChannel[];
    schedules: Schedule[];
    users: User[];
    settings: AllSettings;
    kinds: string[];
    dryRunEnv: boolean;
    slackReady: boolean;
    ai: {
      /** Null until the worker has reported. */
      configured: boolean | null;
      prompts: Record<PromptTask, string>;
      spentDay: number;
      spentMonth: number;
      calls: CallTotals[];
    },
    /** The Calls card, built by the calls screens. */
    callsCard: SafeHtml;
    /** The Sales card, built by the sales screens. */
    salesCard: SafeHtml;
  },
): string {
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const channelName = new Map(data.channels.map((c) => [c.channelId, c]));

  const routeRow = (type: ReportType) => {
    const route = data.routes.get(type);
    const known = route ? channelName.get(route.channelId) : undefined;
    return html`<tr>
      <td><strong>${REPORT_TYPES[type].label}</strong><div class="muted small">suggested ${REPORT_TYPES[type].suggestedChannel}</div></td>
      <td>
        ${route
          ? html`${known ? `#${known.name}` : html`<code>${route.channelId}</code>`}
              ${known && !known.isMember ? html`<div class="bad small">The bot is not in this channel. Invite it.</div>` : ''}`
          : html`<span class="muted">not set</span>`}
      </td>
      <td>
        <form method="post" action="/settings/routes/${type}" class="row">
          ${csrf(ctx)}
          <select name="channel" ${disabled} aria-label="Channel for ${REPORT_TYPES[type].label}">
            <option value="">Not set</option>
            ${data.channels.map(
              (c) =>
                html`<option value="${c.channelId}" ${route?.channelId === c.channelId ? 'selected' : ''}>
                  ${c.isPrivate ? '(private) ' : '#'}${c.name}${c.isMember ? '' : ' (bot not invited)'}
                </option>`,
            )}
          </select>
          <input name="channel_id" placeholder="or channel ID, C…" pattern="[CG][A-Z0-9]+" ${disabled} aria-label="Channel ID" />
          <button type="submit" ${disabled}>Save</button>
        </form>
      </td>
      <td>
        <form method="post" action="/settings/routes/${type}/test">
          ${csrf(ctx)}<button type="submit" ${owner && route ? '' : 'disabled'}>Send test</button>
        </form>
      </td>
    </tr>`;
  };

  return layout(
    ctx,
    'Settings',
    html`<h1>Settings</h1>
      ${owner ? '' : html`<p class="muted">Only an owner can change settings.</p>`}

      <section class="card" id="routing">
        <div class="card-head">
          <h2>Slack routing</h2>
          <form method="post" action="/settings/channels/refresh">
            ${csrf(ctx)}<button type="submit" ${owner && data.slackReady ? '' : 'disabled'}>Refresh channel list</button>
          </form>
        </div>
        <p class="muted">
          The hub channel each report type posts to. One channel can serve several. Invite the bot to a
          channel before routing to it. "Send test" posts a test recommendation there.
        </p>
        <table>
          <thead><tr><th>Report</th><th>Channel</th><th>Change</th><th>Test</th></tr></thead>
          <tbody>${reportTypes.map(routeRow)}</tbody>
        </table>
      </section>

      <section class="card" id="switches">
        <h2>Switches</h2>
        <form method="post" action="/settings/switches" class="stack">
          ${csrf(ctx)}
          <label class="check">
            <input type="checkbox" name="dry_run" value="1" ${data.settings.dry_run || data.dryRunEnv ? 'checked' : ''} ${data.dryRunEnv ? 'disabled' : disabled} />
            ${settingDefs.dry_run.label}: log approved actions without executing them
            ${data.dryRunEnv ? html`<span class="muted">(forced on by DRY_RUN in this environment)</span>` : ''}
          </label>
          <label>${settingDefs['approvals.expire_hours'].label}
            <input type="number" name="approvals.expire_hours" min="1" max="720" value="${data.settings['approvals.expire_hours']}" ${disabled} /></label>
          <label>${settingDefs['approvals.reminder_hours'].label}
            <input type="number" name="approvals.reminder_hours" min="1" max="720" value="${data.settings['approvals.reminder_hours']}" ${disabled} /></label>
          <label>${settingDefs['slack.max_posts_per_hour'].label}
            <input type="number" name="slack.max_posts_per_hour" min="1" max="60" value="${data.settings['slack.max_posts_per_hour']}" ${disabled} /></label>
          <label>${settingDefs['audit.agent_timeout_minutes'].label}
            <input type="number" name="audit.agent_timeout_minutes" min="10" max="1440" value="${data.settings['audit.agent_timeout_minutes']}" ${disabled} /></label>
          <div><button type="submit" ${disabled}>Save</button></div>
        </form>
        <p class="muted small">The global pause is on the Home screen and in <code>/ops pause</code>.</p>
      </section>

      <section class="card" id="ai">
        <h2>AI</h2>
        <p class="muted">
          The weekly audit's checks collect the evidence. A model then says what each finding most likely means,
          ranks the report, words its Slack lines and drafts the brief for a fix. It is given redacted text and
          returns data; it holds no credentials and cannot start anything.
        </p>
        ${data.ai.configured === false
          ? html`<div class="flash flash-error">
              No model is configured, so the rules rank and word the report, and the report says so. Set
              <code>ANTHROPIC_API_KEY</code> on the worker.
            </div>`
          : ''}
        <form method="post" action="/settings/ai" class="stack">
          ${csrf(ctx)}
          <label class="check">
            <input type="checkbox" name="ai.audit.enabled" value="1" ${data.settings['ai.audit.enabled'] ? 'checked' : ''} ${disabled} />
            ${settingDefs['ai.audit.enabled'].label}
          </label>
          ${(['ai.audit.model_service', 'ai.audit.model_rollup', 'ai.audit.model_brief'] as const).map(
            (key) =>
              html`<label>${settingDefs[key].label}
                <input name="${key}" value="${data.settings[key]}" required class="mono" ${disabled} /></label>`,
          )}
          <label>${settingDefs['ai.audit.daily_budget_usd'].label}
            <input type="number" name="ai.audit.daily_budget_usd" min="0" max="10000" step="0.01" value="${data.settings['ai.audit.daily_budget_usd']}" ${disabled} /></label>
          <label>${settingDefs['ai.audit.monthly_budget_usd'].label}
            <input type="number" name="ai.audit.monthly_budget_usd" min="0" max="100000" step="0.01" value="${data.settings['ai.audit.monthly_budget_usd']}" ${disabled} /></label>
          <label>${settingDefs['ai.audit.log_token_cap'].label}
            <input type="number" name="ai.audit.log_token_cap" min="200" max="50000" value="${data.settings['ai.audit.log_token_cap']}" ${disabled} /></label>
          <label>${settingDefs['ai.audit.wait_minutes'].label}
            <input type="number" name="ai.audit.wait_minutes" min="5" max="1440" value="${data.settings['ai.audit.wait_minutes']}" ${disabled} /></label>
          <div><button type="submit" ${disabled}>Save</button></div>
        </form>
        <p class="muted small">
          Spent on audit model calls: ${usd(data.ai.spentDay)} in the last 24 hours, ${usd(data.ai.spentMonth)} in the last 30 days,
          at list prices. Prompt versions in use:
          ${Object.entries(data.ai.prompts)
            .map(([task, version]) => `${task}/${version}`)
            .join(', ')}.
          A prompt changes with a release, not here.
        </p>
        ${data.ai.calls.length ? html`<h3>Model calls, last 30 days</h3>${callsTable(data.ai.calls)}` : ''}
      </section>

      ${data.callsCard}

      ${data.salesCard}

      <section class="card" id="schedules">
        <h2>Schedules</h2>
        <p class="muted">Cron expression and time zone. A change takes effect within a minute.</p>
        <table>
          <thead><tr><th>Schedule</th><th>Cron and time zone</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            ${data.schedules.map(
              (s) => html`<tr>
                <td><code>${s.key}</code></td>
                <td>
                  <form method="post" action="/settings/schedules/${s.key}" class="row">
                    ${csrf(ctx)}
                    <input name="cron_expr" value="${s.cronExpr}" required class="mono" aria-label="Cron expression" ${disabled} />
                    <input name="tz" value="${s.tz}" required aria-label="Time zone" ${disabled} />
                    <label class="check"><input type="checkbox" name="enabled" value="1" ${s.enabled ? 'checked' : ''} ${disabled} /> On</label>
                    <button type="submit" ${disabled}>Save</button>
                  </form>
                </td>
                <td>${when(s.lastRunAt)} ${s.lastOk === false ? html`<span class="bad">failed</span>` : ''}</td>
                <td><form method="post" action="/settings/schedules/${s.key}/run">${csrf(ctx)}<button type="submit" ${disabled}>Run now</button></form></td>
              </tr>`,
            )}
          </tbody>
        </table>
      </section>

      <section class="card" id="people">
        <h2>People</h2>
        <p class="muted">
          Who may sign in, and in which role. Owners change settings; approvers approve and edit; viewers
          read. "Kinds" limits which recommendation kinds a person may decide; empty means all.
        </p>
        <table>
          <thead><tr><th>Person</th><th>Role and kinds</th><th></th></tr></thead>
          <tbody>
            ${data.users.map(
              (u) => html`<tr>
                <td>${u.displayName ?? html`<span class="muted">not signed in yet</span>`}<div class="muted small"><code>${u.slackUserId}</code></div></td>
                <td>
                  <form method="post" action="/settings/people" class="row">
                    ${csrf(ctx)}<input type="hidden" name="slack_user_id" value="${u.slackUserId}" />
                    ${roleSelect(u.role, disabled)}
                    <input name="kinds" value="${(u.approvalKinds ?? []).join(', ')}" placeholder="all kinds" aria-label="Kinds" ${disabled} />
                    <button type="submit" ${disabled}>Save</button>
                  </form>
                </td>
                <td><form method="post" action="/settings/people/${u.slackUserId}/remove">${csrf(ctx)}<button class="danger" type="submit" ${disabled}>Remove</button></form></td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${owner
          ? html`<form method="post" action="/settings/people" class="row add">
              ${csrf(ctx)}
              <input name="slack_user_id" placeholder="Slack member ID, U…" pattern="[UW][A-Z0-9]+" required aria-label="Slack member ID" />
              ${roleSelect('approver', '')}
              <input name="kinds" placeholder="all kinds" aria-label="Kinds" />
              <button type="submit">Add person</button>
            </form>
            <p class="muted small">Registered kinds: ${data.kinds.join(', ')}. A member ID is under "Copy member ID" in a Slack profile.</p>`
          : ''}
      </section>`,
  );
}

function roleSelect(current: Role, disabled: string): SafeHtml {
  return html`<select name="role" aria-label="Role" ${disabled}>
    ${ROLES.map((r) => html`<option value="${r}" ${r === current ? 'selected' : ''}>${r}</option>`)}
  </select>`;
}

// Activity ------------------------------------------------------------------------------------

/** Where an audit-log target lives, from the action that wrote it. */
function targetPath(action: string): string | null {
  if (action.startsWith('calls.connection.')) return null;
  if (action.startsWith('call.') || action === 'sales.post') return '/calls';
  if (action.startsWith('proposal.')) return '/sales/proposals';
  if (action.startsWith('deal.')) return '/sales/deals';
  if (action.startsWith('dealroom.') || action.startsWith('sales.')) return null;
  if (action.startsWith('finding.')) return '/audits/findings';
  if (action.startsWith('audit.')) return '/audits';
  if (action.startsWith('project.')) return '/projects';
  return '/approvals';
}

export function activityPage(
  ctx: PageContext,
  data: { audit: AuditRow[]; runs: RunRow[]; users: Map<string, User>; nextBefore: string | null },
): string {
  const compact = (value: unknown) => (value === null || value === undefined ? '' : JSON.stringify(value));
  return layout(
    ctx,
    'Activity',
    html`<h1>Activity</h1>
      <section class="card">
        <h2>Audit log</h2>
        <p class="muted">Every setting change, sign-in and decision, with who made it.</p>
        <table class="dense">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            ${data.audit.map(
              (a) => html`<tr>
                <td>${when(a.at)}</td><td>${personName(data.users, a.actor)}</td><td><code>${a.action}</code></td>
                <td>${a.target && /^[0-9a-f-]{36}$/.test(a.target) && targetPath(a.action) ? html`<a href="${targetPath(a.action)}/${a.target}"><code>${a.target.slice(0, 8)}</code></a>` : html`<code>${a.target?.slice(0, 40) ?? ''}</code>`}</td>
                <td class="json">${compact(a.before)}</td><td class="json">${compact(a.after)}</td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${data.nextBefore ? html`<p><a href="/activity?before=${data.nextBefore}">Older entries</a></p>` : ''}
      </section>
      <section class="card">
        <h2>Runs and job failures</h2>
        ${data.runs.length
          ? html`<table class="dense">
              <thead><tr><th>Started</th><th>Pipeline</th><th>Trigger</th><th>Result</th><th>Summary</th></tr></thead>
              <tbody>
                ${data.runs.map(
                  (r) => html`<tr><td>${when(r.started_at)}</td><td><code>${r.pipeline}</code></td><td>${r.trigger}</td>
                    <td>${r.ok === null ? 'running' : r.ok ? 'OK' : html`<span class="bad">Failed</span>`}</td><td>${r.summary ?? ''}</td></tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No runs yet.</p>`}
      </section>`,
  );
}
