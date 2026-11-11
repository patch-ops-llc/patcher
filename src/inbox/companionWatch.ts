import { getRoute } from '../settings/routes.js';
import { getSetting, isPaused } from '../settings/settings.js';
import { escapeMrkdwn } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import type { CompanionState } from './companion.js';
import { inQuietHours } from './triage.js';

/**
 * Tells the hub what the browser companion cannot tell the owner itself (design 8.5): a
 * workspace signed the reader out, the reader stopped reporting, or it is open and sees
 * nothing while messages arrive another way. Each thing is said once, when it starts.
 *
 * The sign-out notice goes to the Slack inbox channel, because it asks the owner to do
 * something. The rest are notes for the errors channel.
 */

/** A state has to hold this long before anything is said, so a reload or a restart says nothing. */
const SIGNED_OUT_AFTER_SECONDS = 120;
const TAB_GONE_AFTER_SECONDS = 600;
/** How far back capture is compared with what arrived another way. */
const CAPTURE_WINDOW_MINUTES = 180;
const CAPTURE_MIN_OPEN_BEATS = 120;
const CAPTURE_RENOTIFY_HOURS = 24;

async function notifyInbox(deps: WorkerDeps, text: string): Promise<boolean> {
  try {
    if (await isPaused(deps.pool)) return false;
    const route = await getRoute(deps.pool, 'inbox');
    if (!route) return await notifyOps(deps, text);
    await deps.slack.postMessage({ channel: route.channelId, text });
    return true;
  } catch (err) {
    deps.log.warn('companion notice failed', { err });
    return false;
  }
}

const clock = (at: Date, timeZone: string): string => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', weekday: 'short' }).format(at);

interface StatusRow {
  device_id: string;
  label: string;
  workspace_id: string;
  name: string;
  capture_level: 'notifications' | 'page';
  state: CompanionState;
  state_since: Date;
  notified_state: string | null;
  capture_notified_at: Date | null;
}

export async function watchCompanion(deps: WorkerDeps, now: Date = new Date()): Promise<string> {
  const { pool } = deps;
  if (!(await getSetting(pool, 'inbox.enabled'))) return 'Skipped: the Slack reader is switched off.';
  const [silentMinutes, quietHours, timeZone] = await Promise.all([
    getSetting(pool, 'inbox.companion_silent_minutes'),
    getSetting(pool, 'inbox.quiet_hours'),
    getSetting(pool, 'inbox.quiet_tz'),
  ]);
  const working = !inQuietHours(now, quietHours, timeZone);
  const link = `<${deps.appBaseUrl}/inbox#companion|Reader health>`;
  const said: string[] = [];

  // A reader that has stopped reporting. Outside working hours a sleeping machine is the normal case and nothing is said.
  const silent = await pool.query<{ id: string; label: string; last_heartbeat_at: Date }>(
    `SELECT d.id, d.label, d.last_heartbeat_at FROM companion_devices d
      WHERE d.revoked_at IS NULL AND d.silent_notified_at IS NULL AND d.last_heartbeat_at IS NOT NULL
        AND d.last_heartbeat_at < $1::timestamptz - make_interval(mins => $2)
        AND EXISTS (SELECT 1 FROM companion_workspace_status s JOIN slack_workspaces w ON w.id = s.workspace_id
                     WHERE s.device_id = d.id AND w.enabled AND w.companion_enabled)`,
    [now, silentMinutes],
  );
  if (working) {
    for (const device of silent.rows) {
      const sent = await notifyOps(
        deps,
        `The Slack reader "${escapeMrkdwn(device.label)}" has not reported since ${clock(device.last_heartbeat_at, timeZone)}. Nothing is captured from the browser until Chrome's reader profile is running again; forwarded mail still arrives. ${link}`,
      );
      if (sent) {
        await pool.query('UPDATE companion_devices SET silent_notified_at = now() WHERE id = $1', [device.id]);
        said.push('silent reader');
      }
    }
  }

  // What each reporting reader says about each workspace that is switched on.
  const statuses = await pool.query<StatusRow>(
    `SELECT s.device_id, d.label, s.workspace_id, w.name, w.capture_level, s.state, s.state_since, s.notified_state, s.capture_notified_at
       FROM companion_workspace_status s
       JOIN companion_devices d ON d.id = s.device_id
       JOIN slack_workspaces w ON w.id = s.workspace_id
      WHERE d.revoked_at IS NULL AND w.enabled AND w.companion_enabled
        AND d.last_heartbeat_at >= $1::timestamptz - make_interval(mins => $2)`,
    [now, silentMinutes],
  );
  for (const row of statuses.rows) {
    const heldSeconds = (now.getTime() - row.state_since.getTime()) / 1000;
    const name = escapeMrkdwn(row.name);
    const mark = (state: string | null) =>
      pool.query('UPDATE companion_workspace_status SET notified_state = $3, notified_at = now() WHERE device_id = $1 AND workspace_id = $2', [row.device_id, row.workspace_id, state]);

    if (row.state === 'open') {
      if (row.notified_state) await mark(null);
    } else if (row.notified_state !== row.state) {
      if (row.state === 'signed_out' && heldSeconds >= SIGNED_OUT_AFTER_SECONDS) {
        const sent = await notifyInbox(
          deps,
          `Slack has signed the reader out of *${name}*. Nothing is captured there from the browser until you sign in again in the reader window; Patcher cannot do it for you. Forwarded mail still arrives. ${link}`,
        );
        if (sent) {
          await mark('signed_out');
          said.push('signed out');
        }
      } else if (row.state !== 'signed_out' && heldSeconds >= TAB_GONE_AFTER_SECONDS && working) {
        const what =
          row.state === 'asleep'
            ? `The reader's tab for ${name} is not answering: Chrome has put it to sleep, or it was opened before the extension was loaded. Reload the tab in the reader window.`
            : `The reader has no tab open for ${name}. Open it again in the reader window and pin it.`;
        const sent = await notifyOps(deps, `${what} Nothing is captured there from the browser until then. ${link}`);
        if (sent) {
          await mark(row.state);
          said.push(row.state);
        }
      }
    }

    // Capture that has stopped working shows as an open reader that sees nothing while messages arrive another way.
    if (row.state !== 'open' || !working) continue;
    const recently = row.capture_notified_at && now.getTime() - row.capture_notified_at.getTime() < CAPTURE_RENOTIFY_HOURS * 3_600_000;
    const window = await pool.query<{ open_beats: string; seen: string; sent: string }>(
      `SELECT coalesce(sum(open_beats), 0) AS open_beats, coalesce(sum(seen), 0) AS seen, coalesce(sum(sent), 0) AS sent
         FROM companion_coverage
        WHERE device_id = $1 AND workspace_id = $2 AND hour > $3::timestamptz - make_interval(mins => $4)`,
      [row.device_id, row.workspace_id, now, CAPTURE_WINDOW_MINUTES + 60],
    );
    const openBeats = Number(window.rows[0]?.open_beats ?? 0);
    const seen = Number(window.rows[0]?.seen ?? 0);
    const sent = Number(window.rows[0]?.sent ?? 0);
    if (seen > 0 && !(row.capture_level === 'page' && sent === 0)) {
      if (row.capture_notified_at) await pool.query('UPDATE companion_workspace_status SET capture_notified_at = NULL WHERE device_id = $1 AND workspace_id = $2', [row.device_id, row.workspace_id]);
      continue;
    }
    if (recently || openBeats < CAPTURE_MIN_OPEN_BEATS) continue;
    let text: string | null = null;
    if (seen === 0) {
      const other = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM slack_messages
          WHERE workspace_id = $1 AND source IN ('api', 'email') AND NOT own AND created_at > $2::timestamptz - make_interval(mins => $3)`,
        [row.workspace_id, now, CAPTURE_WINDOW_MINUTES],
      );
      const n = Number(other.rows[0]?.n ?? 0);
      if (n > 0) {
        text = `The reader has been open on ${name} for hours and has seen no message, while ${n} arrived another way. Slack may have changed its web client, or the tab needs a reload.`;
      }
    } else {
      text = `The reader saw ${seen} ${seen === 1 ? 'message' : 'messages'} in ${name} and sent none, although it is set to send everything there. The extension may need an update.`;
    }
    if (text && (await notifyOps(deps, `${text} ${link}`))) {
      await pool.query('UPDATE companion_workspace_status SET capture_notified_at = now() WHERE device_id = $1 AND workspace_id = $2', [row.device_id, row.workspace_id]);
      said.push('capture');
    }
  }

  return said.length ? `Told the hub: ${said.join(', ')}.` : 'Nothing to tell.';
}
