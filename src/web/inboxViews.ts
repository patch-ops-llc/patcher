import type { MailLogEntry } from '../inbox/email.js';
import { itemState } from '../inbox/delivery.js';
import type { Item, LooseTask, RuleSuggestion } from '../inbox/store.js';
import type { Bundle, BundleStatus, ChannelRule, Digest, Workspace } from '../inbox/types.js';
import { DISMISS_REASONS, DROP_REASONS, RULES, RULE_LABEL, channelLabel } from '../inbox/types.js';
import type { BackfillRow } from '../inbox/workspace.js';
import { MAX_BACKFILL_HOURS } from '../inbox/workspace.js';
import type { Project } from '../registry/registry.js';
import type { AllSettings } from '../settings/settings.js';
import { settingDefs } from '../settings/settings.js';
import { canDecide, hasRole } from '../settings/users.js';
import { usd } from './aiViews.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';
import type { PageContext } from './views.js';
import { csrf, layout, when } from './views.js';

const badge = (style: string, label: string): SafeHtml => html`<span class="badge badge-${style}">${label}</span>`;
const safeUrl = (url: string | null | undefined): url is string => Boolean(url && /^https:\/\//.test(url));

const READ_MODE: Record<Workspace['readMode'], string> = {
  api: 'Through the app',
  email_only: 'Forwarded email',
  companion: 'Browser companion (not built yet)',
  connect: 'Slack Connect',
};

const BUNDLE_STATUS: Record<BundleStatus, [string, string]> = {
  open: ['drafted', 'Settling'],
  reading: ['executing', 'Being read'],
  held: ['drafted', 'Waiting'],
  dropped: ['dismissed', 'Nothing for you'],
  fyi: ['dismissed', 'For your information'],
  recommended: ['posted', 'Recommended'],
  unanalysed: ['failed', 'Not analysed'],
  handled: ['done', 'Handled'],
  failed: ['failed', 'Not used'],
};

const itemBadge = (item: Item): SafeHtml => {
  const status = item.rec?.status;
  if (!status) return badge(...BUNDLE_STATUS[item.bundle.status]);
  if (status === 'drafted') return badge('drafted', item.bundle.delivery === 'digest' ? 'Waiting for the digest' : 'Waiting to post');
  if (status === 'posted') return badge('posted', 'Pending');
  if (status === 'expired' && item.bundle.status === 'handled') return badge('done', 'Handled');
  return badge(status, status === 'done' ? 'Done' : status === 'dismissed' ? 'Dismissed' : status === 'failed' ? 'Failed' : status === 'expired' ? 'Expired' : 'Running');
};

const projectSelect = (name: string, projects: Project[], current: string | null, disabled: string): SafeHtml =>
  html`<select name="${name}" aria-label="Project" ${disabled}>
    <option value="">No project</option>
    ${projects.map((p) => html`<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${p.name}</option>`)}
  </select>`;

export interface InboxPageData {
  settings: AllSettings;
  workspaces: Workspace[];
  backfills: Map<string, BackfillRow>;
  rules: ChannelRule[];
  suggestions: RuleSuggestion[];
  projects: Project[];
  items: Item[];
  log: Bundle[];
  drops: { workspaceId: string; reason: string; n: number }[];
  digests: Digest[];
  mail: MailLogEntry[];
  tasks: LooseTask[];
  hasRoute: boolean;
  /** Whether the app's client id and secret, the workspace id and the sealing key are all set. */
  canConnect: boolean;
  mailReady: boolean;
  hasAlias: boolean;
  /** The forwarding address, shown once, straight after it was issued. */
  issuedAddress?: string | null;
}

export function inboxPage(ctx: PageContext, data: InboxPageData): string {
  const owner = hasRole(ctx.session.user, 'owner');
  const approver = hasRole(ctx.session.user, 'approver');
  const disabled = owner ? '' : 'disabled';
  const s = data.settings;
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  const projectName = new Map(data.projects.map((p) => [p.id, p.name]));
  const hub = data.workspaces.find((w) => w.readMode === 'api');

  const workspaceRow = (w: Workspace): SafeHtml => {
    const backfill = data.backfills.get(w.id);
    return html`<tr>
      <td>
        <strong>${w.name}</strong>
        <div class="muted small">${w.domain ? `${w.domain}.slack.com` : (w.teamId ?? '')} · ${READ_MODE[w.readMode]}</div>
      </td>
      <td>
        ${w.readMode === 'api'
          ? w.status === 'connected'
            ? badge('done', 'Connected')
            : badge('failed', w.status === 'new' ? 'Not connected' : 'Disconnected')
          : w.enabled
            ? badge('done', 'On')
            : badge('drafted', 'Off')}
        ${w.statusDetail ? html`<div class="bad small">${w.statusDetail}</div>` : ''}
        ${w.readMode === 'api' && owner && data.canConnect
          ? html`<div class="small"><a href="/inbox/connect">${w.status === 'connected' ? 'Authorise again' : 'Connect'}</a></div>`
          : ''}
      </td>
      <td>
        ${when(w.lastMessageAt)}
        ${w.readMode === 'api' ? html`<div class="muted small">last event ${when(w.lastEventAt)}</div>` : html`<div class="muted small">mentions and direct messages only, while you are away</div>`}
        ${backfill
          ? html`<div class="muted small">
              Catch-up from ${when(backfill.since)}: ${backfill.status === 'running' ? 'running' : backfill.status === 'done' ? 'done' : `failed (${backfill.error ?? 'unknown'})`},
              ${backfill.messages} messages in ${backfill.channels} conversations
            </div>`
          : ''}
      </td>
      <td>
        <form method="post" action="/inbox/workspaces/${w.id}" class="stack">
          ${csrf(ctx)}
          <label class="check"><input type="checkbox" name="enabled" value="1" ${w.enabled ? 'checked' : ''} ${disabled} /> Read this workspace</label>
          <label class="check"><input type="checkbox" name="read_dms" value="1" ${w.readDms ? 'checked' : ''} ${disabled} /> Direct messages too</label>
          <label>Channels without a rule
            <select name="channel_default" ${disabled}>
              <option value="include" ${w.channelDefault === 'include' ? 'selected' : ''}>are read</option>
              <option value="exclude" ${w.channelDefault === 'exclude' ? 'selected' : ''}>are left out</option>
            </select></label>
          <label>Belongs to ${projectSelect('project_id', data.projects, w.projectId, disabled)}</label>
          <div><button type="submit" ${disabled}>Save</button></div>
        </form>
        ${w.readMode === 'api' && w.status === 'connected' && owner
          ? html`<form method="post" action="/inbox/workspaces/${w.id}/backfill" class="row">
              ${csrf(ctx)}
              <input type="number" name="hours" min="1" max="${MAX_BACKFILL_HOURS}" value="12" aria-label="Hours" />
              <button type="submit">Catch up on the last hours</button>
            </form>`
          : ''}
      </td>
    </tr>`;
  };

  return layout(
    ctx,
    'Slack inbox',
    html`<div class="card-head">
        <h1>Slack inbox</h1>
        ${approver ? html`<form method="post" action="/inbox/digest/run">${csrf(ctx)}<button type="submit">Post a digest now</button></form>` : ''}
      </div>
      ${s['inbox.enabled']
        ? ''
        : html`<div class="flash flash-error">The Slack reader is switched off in <a href="/settings#inbox">Settings</a>. Every message is dropped as it arrives and nothing is stored.</div>`}
      ${data.hasRoute ? '' : html`<div class="flash flash-info">No channel is set for Slack inbox reports, so items wait unposted. Choose one in <a href="/settings#routing">Settings</a>.</div>`}

      <section class="card" id="workspaces">
        <h2>Workspaces</h2>
        <p class="muted">
          PatchOps is read through the app, with your own authorisation: read-only scopes, for the conversations you can see.
          Every other workspace is read only from the notification mail Slack sends you and you forward here. A workspace reads nothing until it is switched on.
          Switching one off deletes the messages stored for it.
        </p>
        ${data.workspaces.length
          ? html`<table>
              <thead><tr><th>Workspace</th><th>State</th><th>Last message</th><th>Settings</th></tr></thead>
              <tbody>${data.workspaces.map(workspaceRow)}</tbody>
            </table>`
          : html`<p class="muted">No workspace yet.</p>`}
        ${hub
          ? ''
          : owner && data.canConnect
            ? html`<p><a class="button" href="/inbox/connect">Connect PatchOps</a></p>
                <p class="muted small">Slack asks you to allow Patcher to read the channels and messages you can see. It asks for no permission to post.</p>`
            : html`<p class="muted small">
                ${data.canConnect
                  ? 'An owner connects PatchOps here.'
                  : 'PatchOps cannot be connected yet: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_TEAM_ID and TOKEN_PUBLIC_KEY must be set on the web service.'}
              </p>`}
        ${owner
          ? html`<form method="post" action="/inbox/workspaces" class="row add">
              ${csrf(ctx)}
              <input name="domain" placeholder="acme (from acme.slack.com)" required aria-label="Workspace address" />
              <input name="name" placeholder="Name shown in Patcher" aria-label="Name" />
              <button type="submit">Add a workspace read from email</button>
            </form>`
          : ''}
      </section>

      <section class="card" id="rules">
        <h2>Channel rules</h2>
        ${data.suggestions.map(
          (sug) => html`<div class="flash flash-info">
            ${sug.channelName ? `#${sug.channelName}` : (sug.channelId ?? 'A channel')} in ${workspaceName.get(sug.workspaceId) ?? 'a workspace'} was dismissed as "wrong channel"
            ${sug.dismissals} times in 30 days.
            ${owner
              ? html`<form method="post" action="/inbox/rules" class="row">
                  ${csrf(ctx)}
                  <input type="hidden" name="workspace_id" value="${sug.workspaceId}" />
                  <input type="hidden" name="channel" value="${sug.channelId ?? sug.channelName ?? ''}" />
                  <input type="hidden" name="rule" value="exclude" />
                  <button type="submit">Leave it out</button>
                </form>`
              : ''}
          </div>`,
        )}
        ${data.rules.length
          ? html`<table>
              <thead><tr><th>Workspace</th><th>Channel</th><th>Rule</th><th>Project</th><th></th></tr></thead>
              <tbody>
                ${data.rules.map(
                  (r) => html`<tr>
                    <td>${workspaceName.get(r.workspaceId) ?? ''}</td>
                    <td>${r.channelId ? html`<code>${r.channelId}</code>` : `#${r.channelName ?? ''}`}</td>
                    <td>${RULE_LABEL[r.rule]}</td>
                    <td>${r.projectId ? (projectName.get(r.projectId) ?? '') : ''}</td>
                    <td><form method="post" action="/inbox/rules/${r.id}/remove">${csrf(ctx)}<button class="danger" type="submit" ${disabled}>Remove</button></form></td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">No rule. Every channel follows its workspace's setting, and Patcher's own channels are never read.</p>`}
        ${owner && data.workspaces.length
          ? html`<form method="post" action="/inbox/rules" class="row add">
              ${csrf(ctx)}
              <select name="workspace_id" aria-label="Workspace">${data.workspaces.map((w) => html`<option value="${w.id}">${w.name}</option>`)}</select>
              <input name="channel" placeholder="Channel ID (C…) or name" required aria-label="Channel" />
              <select name="rule" aria-label="Rule">${RULES.map((r) => html`<option value="${r}">${RULE_LABEL[r]}</option>`)}</select>
              ${projectSelect('project_id', data.projects, null, '')}
              <button type="submit">Save rule</button>
            </form>
            <p class="muted small">
              "Digest only" never posts at once. "Always urgent" posts at once, also in quiet hours, and lists a message even when it could not be analysed.
              A project on a rule tells Patcher which project that channel is about.
            </p>`
          : ''}
      </section>

      <section class="card" id="items">
        <h2>Items</h2>
        ${data.items.length
          ? html`<table>
              <thead><tr><th>When</th><th>Where</th><th>Item</th><th>State</th></tr></thead>
              <tbody>
                ${data.items.map(
                  (item) => html`<tr>
                    <td>${when(item.bundle.lastAt ?? item.bundle.createdAt)}</td>
                    <td>${item.workspaceName}<div class="muted small">${channelLabel(item.bundle)}${item.bundle.senderName ? ` · ${item.bundle.senderName}` : ''}</div></td>
                    <td>
                      <a href="/inbox/items/${item.bundle.id}">${item.bundle.summary ?? 'A Slack message'}</a>
                      ${item.bundle.suggestion ? html`<div class="muted small">Suggest: ${item.bundle.suggestion}</div>` : ''}
                      ${item.bundle.postError ? html`<div class="bad small">${item.bundle.postError}</div>` : ''}
                    </td>
                    <td>${itemBadge(item)}${item.feedback?.reason ? html`<div class="muted small">${DISMISS_REASONS[item.feedback.reason]}</div>` : ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">Nothing yet. A message that needs you appears here with what Patcher recommends.</p>`}
        ${data.digests.length
          ? html`<p class="muted small">
              Digests: ${data.digests.map((d) => html`<a href="/inbox/digests/${d.id}">${d.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</a> (${d.stats.items}) `)}
            </p>`
          : ''}
      </section>

      <section class="card" id="log">
        <h2>Triage log</h2>
        <p class="muted small">What became of each conversation, without its text. Patcher's reason is one line the model wrote about its label.</p>
        ${data.log.length
          ? html`<table>
              <thead><tr><th>When</th><th>Where</th><th>Outcome</th><th>Label</th><th>Why</th></tr></thead>
              <tbody>
                ${data.log.map(
                  (b) => html`<tr>
                    <td>${when(b.lastAt ?? b.createdAt)}</td>
                    <td>${workspaceName.get(b.workspaceId) ?? ''}<div class="muted small">${channelLabel(b)} · ${b.messageCount} ${b.messageCount === 1 ? 'message' : 'messages'} · ${b.source}</div></td>
                    <td>${badge(...BUNDLE_STATUS[b.status])}</td>
                    <td>${b.triage ? `${b.triage.label} · ${b.triage.urgency}${b.triage.addressed ? ' · to you' : ''}` : ''}</td>
                    <td class="small">${b.statusDetail ?? b.triage?.reason ?? ''}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="muted">Nothing has been read yet.</p>`}
        ${data.drops.length
          ? html`<h3>Left out before reading, last 7 days</h3>
              <table>
                <thead><tr><th>Workspace</th><th>Reason</th><th>Messages</th></tr></thead>
                <tbody>
                  ${data.drops.map(
                    (d) => html`<tr>
                      <td>${workspaceName.get(d.workspaceId) ?? ''}</td>
                      <td>${(DROP_REASONS as Record<string, string>)[d.reason] ?? d.reason}</td>
                      <td>${d.n}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>`
          : ''}
      </section>

      <section class="card" id="email">
        <h2>Forwarded notification email</h2>
        <p class="muted">
          For workspaces the app cannot read. Turn on Slack's email notifications there, and forward them with a mail rule to the address below.
          Patcher reads the workspace, the sender and the text from the mail. It sees mentions and direct messages only, and only while Slack mails you.
        </p>
        ${data.mailReady
          ? ''
          : html`<div class="flash flash-info">
              Not ready: ${s['inbox.email_address'] ? '' : html`save the inbound address of the mail service in <a href="/settings#inbox">Settings</a>; `}set
              <code>INBOUND_EMAIL_WEBHOOK_SECRET</code> on the web service. The steps are in <code>docs/setup-checklist.md</code>.
            </div>`}
        ${data.issuedAddress
          ? html`<div class="flash flash-ok">
              Forward to <code>${data.issuedAddress}</code><br />
              Copy it now. It is shown once, and only its hash is kept. Issuing a new one stops the old one.
            </div>`
          : html`<p>${data.hasAlias ? 'A forwarding address is in use. Its secret part is not shown again.' : 'No forwarding address has been issued.'}</p>`}
        ${owner && s['inbox.email_address']
          ? html`<form method="post" action="/inbox/email/alias">${csrf(ctx)}<button type="submit">${data.hasAlias ? 'Issue a new address' : 'Issue the forwarding address'}</button></form>`
          : ''}
        ${data.mail.length
          ? html`<h3>Recent mail</h3>
              <table>
                <thead><tr><th>When</th><th>From</th><th>Workspace</th><th>Outcome</th><th>Subject</th></tr></thead>
                <tbody>
                  ${data.mail.map(
                    (m) => html`<tr>
                      <td>${when(m.receivedAt)}</td>
                      <td>${m.sender ?? ''}</td>
                      <td>${m.workspaceId ? (workspaceName.get(m.workspaceId) ?? '') : ''}</td>
                      <td>${MAIL_OUTCOME[m.outcome] ?? (DROP_REASONS as Record<string, string>)[m.outcome] ?? m.outcome}${m.outcome === 'stored' && !m.parsedOk ? ' (sender and channel not recognised)' : ''}</td>
                      <td class="small">${m.subject ?? ''}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
              <p class="muted small">The subject is kept only for mail that was not read, for a week: a mail provider's forwarding confirmation code arrives that way.</p>`
          : ''}
      </section>

      ${data.tasks.length
        ? html`<section class="card" id="tasks">
            <h2>Tasks without a project</h2>
            <table>
              <thead><tr><th>Task</th><th>Created</th><th></th></tr></thead>
              <tbody>
                ${data.tasks.map(
                  (t) => html`<tr>
                    <td>${t.status === 'done' ? html`<s>${t.title}</s>` : t.title}${t.bundleId ? html` <a class="small" href="/inbox/items/${t.bundleId}">item</a>` : ''}</td>
                    <td>${when(t.createdAt)}</td>
                    <td>
                      ${approver
                        ? html`<form method="post" action="/inbox/tasks/${t.id}/done">
                            ${csrf(ctx)}<input type="hidden" name="done" value="${t.status === 'done' ? '0' : '1'}" />
                            <button type="submit">${t.status === 'done' ? 'Reopen' : 'Done'}</button>
                          </form>`
                        : ''}
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </section>`
        : ''}`,
  );
}

const MAIL_OUTCOME: Record<string, string> = {
  stored: 'Read',
  not_slack: 'Not from Slack, not read',
  no_workspace: 'No workspace found in the mail',
  workspace_new: 'New workspace, added switched off',
};

function itemRows(ctx: PageContext, items: Item[], numbered: boolean): SafeHtml {
  return html`<table>
    <thead><tr>${numbered ? html`<th>#</th>` : ''}<th>Where</th><th>Item</th><th>State</th><th></th></tr></thead>
    <tbody>
      ${items.map(
        (item) => html`<tr>
          ${numbered ? html`<td>${item.bundle.digestPosition ?? ''}</td>` : ''}
          <td>${item.workspaceName}<div class="muted small">${channelLabel(item.bundle)}${item.bundle.senderName ? ` · ${item.bundle.senderName}` : ''}</div></td>
          <td>
            <a href="/inbox/items/${item.bundle.id}">${item.bundle.summary ?? 'A Slack message'}</a>
            ${item.bundle.suggestion ? html`<div class="muted small">Suggest: ${item.bundle.suggestion}</div>` : ''}
          </td>
          <td>${itemBadge(item)}</td>
          <td>${safeUrl(item.bundle.link) ? html`<a href="${item.bundle.link}" rel="noreferrer">Open in Slack</a>` : ''}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}

export function digestPage(ctx: PageContext, data: { digest: Digest; items: Item[] }): string {
  const { digest } = data;
  return layout(
    ctx,
    'Slack digest',
    html`<p><a href="/inbox">Slack inbox</a></p>
      <h1>Slack digest</h1>
      <p class="muted">
        ${when(digest.createdAt)} · ${digest.stats.workspaces} ${digest.stats.workspaces === 1 ? 'workspace' : 'workspaces'} · ${digest.stats.messages} new ·
        ${digest.stats.items} needed you
        ${digest.postedAt ? '' : html` · ${badge('drafted', 'Not posted yet')}`}
      </p>
      ${digest.postError ? html`<div class="flash flash-error">${digest.postError}</div>` : ''}
      <section class="card">${itemRows(ctx, data.items, true)}</section>`,
  );
}

export function itemPage(ctx: PageContext, data: { item: Item }): string {
  const { item } = data;
  const { bundle, rec, feedback } = item;
  const mayDecide = Boolean(rec && hasRole(ctx.session.user, 'approver') && canDecide(ctx.session.user, rec.kind));
  return layout(
    ctx,
    'Slack item',
    html`<p><a href="/inbox">Slack inbox</a>${bundle.digestId ? html` · <a href="/inbox/digests/${bundle.digestId}">digest</a>` : ''}</p>
      <h1>${bundle.summary ?? 'A Slack message'}</h1>
      <p class="muted">
        ${item.workspaceName} Slack · ${channelLabel(bundle)}${bundle.senderName ? ` · ${bundle.senderName}` : ''} · ${when(bundle.lastAt ?? bundle.createdAt)}
        · ${bundle.messageCount} ${bundle.messageCount === 1 ? 'message' : 'messages'}
      </p>
      <section class="card">
        <p>${itemBadge(item)} <span class="muted">${itemState(item).replace(/<@([A-Z0-9]+)>/g, '$1')}</span></p>
        ${bundle.status === 'unanalysed' ? html`<p class="bad">${bundle.statusDetail ?? 'Not analysed.'}</p>` : ''}
        ${bundle.suggestion ? html`<p><strong>Suggest:</strong> ${bundle.suggestion}</p>` : ''}
        ${bundle.triage ? html`<p class="muted small">Sorted as ${bundle.triage.label}, ${bundle.triage.urgency}${bundle.triage.reason ? `: ${bundle.triage.reason}` : ''}</p>` : ''}
        ${bundle.draft
          ? html`<h3>Draft reply</h3>
              <pre>${bundle.draft}</pre>
              <p class="muted small">Copy it and send it yourself in Slack. Patcher sends nothing.</p>`
          : ''}
        <div class="row">
          ${safeUrl(bundle.link) ? html`<a class="button" href="${bundle.link}" rel="noreferrer">Open in Slack</a>` : ''}
          ${rec ? html`<a class="button" href="/approvals/${rec.id}">${rec.status === 'posted' && mayDecide ? 'Decide' : 'Evidence and action'}</a>` : ''}
          ${bundle.postError && mayDecide ? html`<form method="post" action="/inbox/items/${bundle.id}/post">${csrf(ctx)}<button type="submit">Post to Slack now</button></form>` : ''}
        </div>
        ${bundle.postError ? html`<p class="bad small">${bundle.postError}</p>` : ''}
        ${rec?.status === 'dismissed' && mayDecide
          ? html`<form method="post" action="/inbox/items/${bundle.id}/reason" class="row">
              ${csrf(ctx)}
              <span>Why was it dismissed?</span>
              ${Object.entries(DISMISS_REASONS).map(
                ([reason, label]) => html`<button type="submit" name="reason" value="${reason}" ${feedback?.reason === reason ? 'disabled' : ''}>${label}</button>`,
              )}
            </form>`
          : ''}
      </section>`,
  );
}

export function inboxSettingsCard(ctx: PageContext, data: { settings: AllSettings; ai: { configured: boolean | null; spentDay: number; spentMonth: number } }): SafeHtml {
  const owner = hasRole(ctx.session.user, 'owner');
  const disabled = owner ? '' : 'disabled';
  const s = data.settings;
  const check = (key: 'inbox.enabled' | 'ai.inbox.enabled' | 'inbox.digest_only' | 'inbox.agent_enabled') =>
    html`<label class="check"><input type="checkbox" name="${key}" value="1" ${s[key] ? 'checked' : ''} ${disabled} /> ${settingDefs[key].label}</label>`;
  const number = (key: 'inbox.settle_seconds' | 'inbox.unanalysed_after_minutes' | 'inbox.retention_days', min: number, max: number) =>
    html`<label>${settingDefs[key].label} <input type="number" name="${key}" min="${min}" max="${max}" step="1" value="${s[key]}" ${disabled} /></label>`;
  return html`<section class="card" id="inbox">
    <h2>Slack inbox</h2>
    <p class="muted">
      Messages that need you are posted to the channel routed for Slack inbox: urgent ones at once, the rest in a digest at the times of the
      <code>slack.digest</code> schedule below. Workspaces, channel rules and the forwarding address are on the <a href="/inbox">Slack inbox screen</a>.
    </p>
    ${data.ai.configured === false
      ? html`<div class="flash flash-error">No model is configured, so messages addressed to you are listed unanalysed and the rest wait. Set <code>ANTHROPIC_API_KEY</code> on the worker.</div>`
      : ''}
    <form method="post" action="/settings/inbox" class="stack">
      ${csrf(ctx)}
      ${check('inbox.enabled')}
      ${check('ai.inbox.enabled')}
      ${number('inbox.settle_seconds', 0, 1800)}
      ${check('inbox.digest_only')}
      <label>${settingDefs['inbox.quiet_hours'].label}
        <input name="inbox.quiet_hours" value="${s['inbox.quiet_hours']}" placeholder="19:00-07:00" class="mono" ${disabled} /></label>
      <label>${settingDefs['inbox.quiet_tz'].label}
        <input name="inbox.quiet_tz" value="${s['inbox.quiet_tz']}" class="mono" ${disabled} /></label>
      ${number('inbox.unanalysed_after_minutes', 1, 1440)}
      ${number('inbox.retention_days', 1, 30)}
      ${check('inbox.agent_enabled')}
      ${(['ai.inbox.model_triage', 'ai.inbox.model_recommend'] as const).map(
        (key) => html`<label>${settingDefs[key].label} <input name="${key}" value="${s[key]}" required class="mono" ${disabled} /></label>`,
      )}
      <label>${settingDefs['ai.inbox.daily_budget_usd'].label}
        <input type="number" name="ai.inbox.daily_budget_usd" min="0" max="10000" step="0.01" value="${s['ai.inbox.daily_budget_usd']}" ${disabled} /></label>
      <label>${settingDefs['ai.inbox.monthly_budget_usd'].label}
        <input type="number" name="ai.inbox.monthly_budget_usd" min="0" max="100000" step="0.01" value="${s['ai.inbox.monthly_budget_usd']}" ${disabled} /></label>

      <h3>Forwarded email</h3>
      <label>${settingDefs['inbox.email_address'].label}
        <input name="inbox.email_address" value="${s['inbox.email_address']}" placeholder="abc123@inbound.postmarkapp.com" class="mono" ${disabled} /></label>
      <label>${settingDefs['inbox.email_senders'].label}
        <input name="inbox.email_senders" value="${s['inbox.email_senders']}" class="mono" ${disabled} /></label>
      <div><button type="submit" ${disabled}>Save</button></div>
    </form>
    <p class="muted small">
      Spent on model calls for Slack: ${usd(data.ai.spentDay)} in the last 24 hours, ${usd(data.ai.spentMonth)} in the last 30 days, at list prices.
    </p>
  </section>`;
}
