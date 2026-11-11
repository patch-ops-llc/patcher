import type { CompanionOverview, CompanionState, Device, WorkspaceStatus } from '../inbox/companion.js';
import { GAP_SECONDS } from '../inbox/companion.js';
import type { Workspace } from '../inbox/types.js';
import { hasRole } from '../settings/users.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';
import type { PageContext } from './views.js';
import { csrf, when } from './views.js';

const badge = (style: string, label: string): SafeHtml => html`<span class="badge badge-${style}">${label}</span>`;

export const COMPANION_STATE: Record<CompanionState, [string, string]> = {
  open: ['done', 'Open'],
  asleep: ['failed', 'Tab not answering'],
  signed_out: ['failed', 'Signed out'],
  closed: ['drafted', 'No tab'],
};

export const CAPTURE_LEVEL: Record<Workspace['captureLevel'], string> = {
  notifications: 'Direct messages and mentions only',
  page: 'Every message the reader receives',
};

export interface CompanionPageData {
  overview: CompanionOverview;
  /** The address the extension is pointed at. */
  appBaseUrl: string;
  /** A device key, shown once, straight after it was issued. */
  issuedDevice?: { label: string; key: string } | null;
  now?: Date;
}

const reporting = (device: Device, now: Date): boolean => Boolean(device.lastHeartbeatAt && now.getTime() - device.lastHeartbeatAt.getTime() < GAP_SECONDS * 1000);

const duration = (from: Date, to: Date): string => {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.round(hours / 24)} days`;
};

/** The companion's state for one workspace, as a line in that workspace's row. */
export function companionBadge(workspace: Workspace, overview: CompanionOverview, now: Date = new Date()): SafeHtml {
  if (!workspace.companionEnabled) return html``;
  const live = new Set(overview.devices.filter((d) => !d.revokedAt && reporting(d, now)).map((d) => d.id));
  const statuses = overview.statuses.filter((s) => s.workspaceId === workspace.id);
  const current = statuses.find((s) => live.has(s.deviceId) && s.state === 'open') ?? statuses.find((s) => live.has(s.deviceId));
  if (current) return html`<div class="small">Reader: ${badge(...COMPANION_STATE[current.state])}</div>`;
  return html`<div class="small">Reader: ${badge('drafted', statuses.length ? 'Not reporting' : 'Not seen yet')}</div>`;
}

/** The member id the extension read from the page, when the workspace has none saved. */
export function suggestedMember(workspace: Workspace, overview: CompanionOverview): string | null {
  if (workspace.readerUserId) return null;
  return overview.statuses.find((s) => s.workspaceId === workspace.id && s.suggestedUserId)?.suggestedUserId ?? null;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(obj) : []);

interface Check {
  label: string;
  /** True or false when the extension or Patcher can tell; null when only the owner can. */
  ok: boolean | null;
  detail?: string;
}

function checklist(data: CompanionPageData, workspaces: Workspace[], now: Date): Check[] {
  const { overview } = data;
  const active = overview.devices.filter((d) => !d.revokedAt);
  const live = active.filter((d) => reporting(d, now));
  const tabs = live.flatMap((d) => list(obj(d.diagnostics).tabs));
  const on = workspaces.filter((w) => w.enabled && w.companionEnabled);
  const liveIds = new Set(live.map((d) => d.id));
  const open = (w: Workspace) => overview.statuses.some((s) => s.workspaceId === w.id && liveIds.has(s.deviceId) && s.state === 'open');
  const notOpen = on.filter((w) => !open(w));
  const unblocked = tabs.filter((t) => t.notification !== 'denied').length;
  const unpinned = tabs.filter((t) => t.pinned !== true).length;
  const noMember = on.filter((w) => !w.readerUserId);
  return [
    { label: 'A separate Chrome profile for the reader, with the extension loaded in it', ok: active.some((d) => d.pairedAt) ? true : null, detail: active.some((d) => d.pairedAt) ? 'An extension has paired.' : 'Nothing has paired yet.' },
    { label: 'The extension is paired and reporting', ok: live.length > 0, detail: live.length ? undefined : active.length ? 'No report in the last minutes.' : 'No reader has been paired.' },
    {
      label: 'Signed in to each workspace that is switched on, with its tab open',
      ok: on.length ? notOpen.length === 0 : null,
      detail: on.length ? (notOpen.length ? `Not open: ${notOpen.map((w) => w.name).join(', ')}.` : undefined) : 'No workspace is switched on for the companion.',
    },
    {
      label: "Slack's notifications are blocked in the reader profile, so you are not alerted twice",
      ok: tabs.length ? unblocked === 0 : null,
      detail: tabs.length ? (unblocked ? `${unblocked} of ${tabs.length} ${tabs.length === 1 ? 'tab has' : 'tabs have'} them allowed or not decided.` : undefined) : 'Known once a tab reports.',
    },
    {
      label: 'The Slack tabs are pinned',
      ok: tabs.length ? unpinned === 0 : null,
      detail: tabs.length ? (unpinned ? `${unpinned} of ${tabs.length} not pinned.` : undefined) : 'Known once a tab reports.',
    },
    {
      label: 'Your member ID is saved for each workspace, so a mention and your own reply are recognised',
      ok: on.length ? noMember.length === 0 : null,
      detail: noMember.length ? `Missing for: ${noMember.map((w) => w.name).join(', ')}.` : undefined,
    },
    { label: 'app.slack.com is on Chrome\'s "Always keep these sites active" list (chrome://settings/performance)', ok: null, detail: 'The extension cannot see this setting.' },
    { label: 'The reader profile opens when you log in to the computer', ok: null, detail: 'The extension cannot see this.' },
  ];
}

const mark = (ok: boolean | null): SafeHtml => (ok === true ? badge('done', 'Confirmed') : ok === false ? badge('failed', 'Not yet') : badge('drafted', 'Check yourself'));

/** One cell per hour of the last 24: how much of the hour the reader reported with the workspace open. */
function coverageStrip(overview: CompanionOverview, workspaceId: string, now: Date): SafeHtml {
  const byHour = new Map(overview.coverage.filter((c) => c.workspaceId === workspaceId).map((c) => [c.hour.getTime(), c]));
  const thisHour = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const cells: SafeHtml[] = [];
  for (let i = 23; i >= 0; i -= 1) {
    const at = thisHour - i * 3_600_000;
    const c = byHour.get(at);
    // The running hour is measured against the minutes of it that have passed.
    const expected = i === 0 ? Math.max(1, Math.floor((now.getTime() - at) / 60_000)) : 60;
    const share = c ? Math.min(1, c.openBeats / expected) : 0;
    const level = share >= 0.9 ? 'full' : share >= 0.5 ? 'most' : share > 0 ? 'some' : 'none';
    const label = `${new Date(at).toISOString().slice(11, 16)} UTC: open ${c?.openBeats ?? 0} of ${expected} minutes, ${c?.seen ?? 0} seen, ${c?.sent ?? 0} sent, ${c?.stored ?? 0} kept`;
    cells.push(html`<span class="cov cov-${level}" title="${label}"></span>`);
  }
  return html`<span class="cov-strip" role="img" aria-label="Coverage by hour, last 24 hours, oldest first">${cells}</span>`;
}

function healthRow(status: WorkspaceStatus, workspace: Workspace | undefined, data: CompanionPageData, now: Date, live: boolean): SafeHtml {
  const { overview } = data;
  const hours = overview.coverage.filter((c) => c.workspaceId === status.workspaceId);
  const sum = (pick: (c: (typeof hours)[number]) => number) => hours.reduce((n, c) => n + pick(c), 0);
  const openMinutes = sum((c) => c.openBeats);
  const captured = workspace?.enabled && workspace.companionEnabled;
  return html`<tr>
    <td>
      <strong>${workspace?.name ?? 'A workspace'}</strong>
      <div class="muted small">${status.deviceLabel} · ${captured ? CAPTURE_LEVEL[workspace.captureLevel] : 'switched off, nothing is captured'}</div>
    </td>
    <td>
      ${live ? badge(...COMPANION_STATE[status.state]) : badge('drafted', 'Not reporting')}
      <div class="muted small">${live ? html`for ${duration(status.stateSince, now)}` : html`last report ${when(status.lastSeenAt)}`}</div>
      ${status.stateDetail ? html`<div class="muted small">${status.stateDetail}</div>` : ''}
    </td>
    <td>${when(status.lastMessageAt)}</td>
    <td>
      ${coverageStrip(overview, status.workspaceId, now)}
      <div class="muted small">
        open ${Math.floor(openMinutes / 60)} h ${openMinutes % 60} min of the last 24 h · ${sum((c) => c.seen)} seen · ${sum((c) => c.sent)} sent · ${sum((c) => c.stored)} kept
      </div>
    </td>
    <td>${overview.signOuts.get(status.workspaceId) ?? 0}</td>
  </tr>`;
}

/** What the reader last said about how it captures: the spike's questions 4 and 5, in counts. */
function capturePoints(device: Device, teamName: (id: string) => string): SafeHtml {
  const d = obj(device.diagnostics);
  const tabs = list(d.tabs);
  if (!tabs.length) return html`<p class="muted small">${device.label}: no tab has reported yet.</p>`;
  const worker = obj(d.worker);
  return html`<h4>${device.label}</h4>
    <table>
      <thead>
        <tr><th>Tab</th><th>Chrome's view</th><th>Sockets</th><th>Frames</th><th>Workspace named in frames</th><th>Workers</th><th>Page</th></tr>
      </thead>
      <tbody>
        ${tabs.map((t) => {
          const teams = Object.entries(obj(t.teams)).filter(([, n]) => num(n) !== null);
          const page = obj(t.dom);
          const flags = [t.pinned === true ? 'pinned' : 'not pinned', t.discarded === true ? 'discarded' : null, t.frozen === true ? 'frozen' : null, t.hidden === true ? 'hidden' : 'visible']
            .filter(Boolean)
            .join(', ');
          return html`<tr>
            <td>${typeof t.team === 'string' ? teamName(t.team) : 'not a workspace'}<div class="muted small">${typeof t.state === 'string' ? t.state : ''}</div></td>
            <td class="small">${flags}<div class="muted">notifications: ${typeof t.notification === 'string' ? t.notification : 'unknown'}</div></td>
            <td>${num(t.socketsOpen) ?? 0} open<div class="muted small">${num(t.sockets) ?? 0} opened</div></td>
            <td>
              ${num(t.frames) ?? 0}
              <div class="muted small">
                ${num(t.messageFrames) ?? 0} messages, ${num(t.notificationFrames) ?? 0} notifications, ${num(t.binary) ?? 0} binary, ${num(t.unparsed) ?? 0} unread
                ${num(t.lastFrameAgoS) === null ? '' : `, last ${num(t.lastFrameAgoS)} s ago`}
              </div>
            </td>
            <td class="small">${teams.length ? teams.map(([team, n]) => html`${teamName(team)}: ${num(n)}<br />`) : html`<span class="muted">none yet</span>`}</td>
            <td class="small">${num(t.workers) ?? 0} worker, ${num(t.sharedWorkers) ?? 0} shared</td>
            <td class="small">${num(page.channels) ?? 0} channels, ${num(page.messages) ?? 0} messages on screen</td>
          </tr>`;
        })}
      </tbody>
    </table>
    <p class="muted small">
      Extension ${device.version ?? 'unknown'} · background worker started ${num(worker.starts) ?? 0} times · ${num(worker.queue) ?? 0} waiting to send ·
      ${num(worker.dropped) ?? 0} dropped unsent
    </p>`;
}

export function companionSection(ctx: PageContext, data: CompanionPageData, workspaces: Workspace[]): SafeHtml {
  const owner = hasRole(ctx.session.user, 'owner');
  const now = data.now ?? new Date();
  const { overview } = data;
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const byTeam = new Map(workspaces.flatMap((w) => (w.teamId ? [[w.teamId, w.name] as const] : [])));
  const teamName = (id: string) => byTeam.get(id) ?? id;
  const active = overview.devices.filter((d) => !d.revokedAt);
  const liveIds = new Set(active.filter((d) => reporting(d, now)).map((d) => d.id));
  const checks = checklist(data, workspaces, now);

  return html`<section class="card" id="companion">
    <h2>Browser companion</h2>
    <p class="muted">
      Reads workspaces where the app cannot be installed. A Chrome extension in a separate reader profile on your computer sees the messages Slack's web client receives
      there and sends them to Patcher. It reads only: it never posts, reacts or marks anything read, makes no request to Slack, and never reads or sends a cookie or a token.
      A workspace it finds starts switched off; switch it on in the table above.
    </p>
    <div class="flash flash-info">
      How it captures has not been proven against Slack. Run the spike in PatchOps first (<code>docs/slack-companion.md</code>), and switch on no client workspace until it passes.
      Design section 8.4 lists what a client's admin can see and what can break.
    </div>

    ${data.issuedDevice
      ? html`<div class="flash flash-ok">
          Key for "${data.issuedDevice.label}": <code>${data.issuedDevice.key}</code><br />
          Patcher address: <code>${data.appBaseUrl}</code><br />
          Paste both into the extension's page. The key is shown once, and only its hash is kept.
        </div>`
      : ''}

    <h3>Readers</h3>
    ${overview.devices.length
      ? html`<table>
          <thead><tr><th>Reader</th><th>State</th><th>Last report</th><th>Seen / sent / kept</th><th></th></tr></thead>
          <tbody>
            ${overview.devices.map(
              (d) => html`<tr>
                <td><strong>${d.label}</strong><div class="muted small">${d.version ? `extension ${d.version}` : 'no report yet'}</div></td>
                <td>
                  ${d.revokedAt
                    ? badge('dismissed', 'Revoked')
                    : !d.pairedAt
                      ? badge('drafted', 'Key not used yet')
                      : liveIds.has(d.id)
                        ? badge('done', 'Reporting')
                        : badge('failed', 'Not reporting')}
                </td>
                <td>${when(d.lastHeartbeatAt)}</td>
                <td>${d.seenCount} / ${d.sentCount} / ${d.storedCount}</td>
                <td>
                  ${d.revokedAt || !owner
                    ? ''
                    : html`<form method="post" action="/inbox/companion/devices/${d.id}/revoke">${csrf(ctx)}<button class="danger" type="submit">Revoke</button></form>`}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`
      : html`<p class="muted">No reader is paired.</p>`}
    ${owner
      ? html`<form method="post" action="/inbox/companion/devices" class="row add">
          ${csrf(ctx)}
          <input name="label" placeholder="Reader profile on the laptop" required maxlength="60" aria-label="Name of the reader" />
          <button type="submit">Pair a reader</button>
        </form>
        <p class="muted small">Revoking a key stops that reader at its next report: it sends nothing more and forgets what it had not sent yet.</p>`
      : ''}

    <h3>Reader health</h3>
    ${overview.statuses.length
      ? html`<table>
            <thead><tr><th>Workspace</th><th>Reader</th><th>Last message seen</th><th>Last 24 hours</th><th>Signed out, 30 days</th></tr></thead>
            <tbody>${overview.statuses.map((s) => healthRow(s, byId.get(s.workspaceId), data, now, liveIds.has(s.deviceId)))}</tbody>
          </table>
          <p class="muted small">
            Each cell is one hour, oldest first: filled when the reader reported every minute with the workspace open, empty when it did not report at all.
            Nothing is captured in an empty hour and nothing is filled in afterwards; only forwarded mail covers it.
          </p>`
      : html`<p class="muted">No reader has reported a workspace yet.</p>`}

    ${overview.events.length
      ? html`<h3>Gaps and changes, last 14 days</h3>
          <table>
            <thead><tr><th>When</th><th>Reader</th><th>What</th></tr></thead>
            <tbody>
              ${overview.events.map(
                (e) => html`<tr>
                  <td>${when(e.toAt)}</td>
                  <td>${e.deviceLabel}</td>
                  <td>
                    ${e.kind === 'gap'
                      ? html`No report for ${e.fromAt ? duration(e.fromAt, e.toAt) : 'a while'}: Chrome was closed, or the computer was asleep or offline.`
                      : html`${e.workspaceId ? (byId.get(e.workspaceId)?.name ?? 'A workspace') : ''}:
                          ${COMPANION_STATE[e.fromState as CompanionState]?.[1] ?? e.fromState ?? ''} → ${COMPANION_STATE[e.toState as CompanionState]?.[1] ?? e.toState ?? ''}
                          ${e.fromAt ? html`<span class="muted">after ${duration(e.fromAt, e.toAt)}</span>` : ''}`}
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`
      : ''}

    <h3>Setup checklist</h3>
    <table>
      <tbody>
        ${checks.map((c) => html`<tr><td>${mark(c.ok)}</td><td>${c.label}${c.detail ? html`<div class="muted small">${c.detail}</div>` : ''}</td></tr>`)}
      </tbody>
    </table>

    ${active.some((d) => d.diagnostics)
      ? html`<h3>How the reader captures</h3>
          <p class="muted small">
            Counts from each reader's last report, for the spike: whether one tab receives messages for more than one workspace, and whether Slack's socket is where the
            extension expects it. No message text is reported here.
          </p>
          ${active.filter((d) => d.diagnostics).map((d) => capturePoints(d, teamName))}`
      : ''}
  </section>`;
}
