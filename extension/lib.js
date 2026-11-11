/*
 * The companion's logic that touches neither the page nor the browser: which frames become
 * messages for Patcher, what state a workspace is in, and what the spike readout says.
 * Loaded by the content script, the background worker and the extension's page, and by the
 * tests as it is.
 */
(() => {
  'use strict';

  const TEAM = /^[TE][A-Z0-9]{2,20}$/;
  const CHANNEL = /^[A-Z0-9]{3,40}$/;
  const MEMBER = /^[UW][A-Z0-9]{2,30}$/;
  const TS = /^\d{9,11}\.\d{1,6}$/;
  const TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{8,}/g;

  const RECENT_MAX = 300;
  const RECENT_MS = 10 * 60 * 1000;
  const MAX_TEXT = 40000;

  /** Removes anything shaped like a Slack token. Patcher does the same on its side. */
  const scrub = (text) => String(text).replace(TOKEN, '[removed]');

  /** The workspace a client page shows, from its path: /client/T0123ABC/C0456DEF. */
  function teamFromPath(pathname) {
    const m = /^\/client\/([A-Z0-9]+)(?:\/|$)/.exec(String(pathname || ''));
    return m && TEAM.test(m[1]) ? m[1] : null;
  }

  /** What kind of page a tab on app.slack.com shows. Only a client page captures anything. */
  function pageKind(pathname) {
    if (teamFromPath(pathname)) return 'client';
    return /signin|sign_in|login|sso|checkcookie|workspace-signin/i.test(String(pathname || '')) ? 'signin' : 'other';
  }

  const isDirect = (channelId, channelType) => channelType === 'im' || channelType === 'mpim' || (!channelType && /^D/.test(channelId));

  const channelTypeOf = (channelId, channelType) => {
    if (channelType === 'im' || channelType === 'mpim' || channelType === 'channel' || channelType === 'group') return channelType;
    if (/^D/.test(channelId)) return 'im';
    if (/^G/.test(channelId)) return 'group';
    return /^C/.test(channelId) ? 'channel' : 'unknown';
  };

  /**
   * Turns the frames one tab hears into what is sent to Patcher. One per tab.
   *
   *   - A workspace that is not switched on in Patcher is counted and otherwise ignored: its
   *     messages are not kept in memory, not even for a moment.
   *   - At the "notifications" level a message leaves the tab only when it is a direct
   *     message, mentions the owner, or Slack itself asked for a notification for it.
   *   - Every frame is taken to belong to the workspace the tab shows. When two sockets in
   *     one tab carry messages at the same time, that can no longer be assumed, and without
   *     reading a socket's address, which this extension never does, the two cannot be told
   *     apart. Nothing is sent from the tab while that lasts.
   */
  function createCapture(options) {
    const clock = (options && options.now) || Date.now;
    let workspaces = new Map();
    let reading = false;
    const recent = new Map();
    const counts = {};
    const totals = { ambiguous: 0, notificationOnly: 0, unattributed: 0, unusable: 0 };
    const frameTeams = {};
    const previews = [];
    let previewOn = false;

    const countsFor = (team) => {
      if (!counts[team]) counts[team] = { seen: 0, sent: 0, lastFrameAt: 0 };
      return counts[team];
    };

    function setConfig(config) {
      const next = new Map();
      for (const w of (config && config.workspaces) || []) {
        if (w && TEAM.test(w.teamId)) next.set(w.teamId, { level: w.level === 'page' ? 'page' : 'notifications', selfUserId: MEMBER.test(w.selfUserId || '') ? w.selfUserId : null });
      }
      workspaces = next;
      reading = Boolean(config && config.reading !== false);
      // What was held for a workspace that has since been switched off is forgotten at once.
      for (const [key, entry] of recent) if (!workspaces.has(entry.item.teamId)) recent.delete(key);
    }

    function setPreview(on) {
      previewOn = Boolean(on);
      if (!previewOn) previews.length = 0;
    }

    function remember(key, entry) {
      recent.set(key, entry);
      if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
    }

    function expire(at) {
      for (const [key, entry] of recent) {
        if (at - entry.at < RECENT_MS) break;
        recent.delete(key);
      }
    }

    function preview(team, frame, text) {
      if (!previewOn) return;
      previews.push({ at: clock(), team, channel: frame.channel || '', user: frame.user || '', type: frame.type, text: scrub(text || '').slice(0, 80) });
      if (previews.length > 20) previews.shift();
    }

    /** Returns the items to send to Patcher for one frame from the page: usually none or one. */
    function onFrame(frame, tabTeam) {
      if (!frame || typeof frame !== 'object') return [];
      const at = clock();
      expire(at);
      if (!tabTeam || !TEAM.test(tabTeam)) {
        totals.unattributed += 1;
        return [];
      }
      const team = tabTeam;
      const named = TEAM.test(frame.team || '') ? frame.team : 'none';
      if (frame.type === 'message') frameTeams[named] = (frameTeams[named] || 0) + 1;
      const c = countsFor(team);
      const ws = reading ? workspaces.get(team) : undefined;
      const channelId = frame.channel;
      if (!CHANNEL.test(channelId || '')) {
        totals.unusable += 1;
        return [];
      }

      if (frame.type === 'desktop_notification') {
        preview(team, frame, frame.content);
        if (!ws || !TS.test(frame.ts || '')) return [];
        if (frame.live > 1) {
          totals.ambiguous += 1;
          return [];
        }
        const key = `${team}:${channelId}:${frame.ts}`;
        const held = recent.get(key);
        const channelName = /^#/.test(frame.subtitle || '') ? frame.subtitle.slice(1) : undefined;
        const spoken = /^([^:\n]{1,80}): ([\s\S]*)$/.exec(frame.content || '');
        if (held) {
          if (held.sent) return [];
          held.sent = true;
          c.sent += 1;
          const item = { ...held.item, notified: true };
          if (channelName && !item.channelName) item.channelName = channelName;
          if (spoken && !item.senderName) item.senderName = spoken[1].trim();
          return [item];
        }
        // The message itself was not heard, so the notification's own words are all there is.
        if (!frame.content) return [];
        totals.notificationOnly += 1;
        const item = {
          kind: 'message',
          teamId: team,
          channelId,
          channelType: channelTypeOf(channelId, undefined),
          ts: frame.ts,
          text: scrub(spoken ? spoken[2] : frame.content).slice(0, MAX_TEXT),
          notified: true,
          via: 'notification',
        };
        if (TS.test(frame.thread_ts || '')) item.threadTs = frame.thread_ts;
        if (channelName) item.channelName = channelName;
        if (spoken) item.senderName = spoken[1].trim();
        remember(key, { at, item, sent: true });
        c.sent += 1;
        return [item];
      }

      if (frame.type !== 'message') return [];
      const subtype = frame.subtype || '';

      if (subtype === 'message_changed' || subtype === 'message_deleted') {
        if (!ws || frame.live > 1) return [];
        const inner = frame.message || {};
        const target = subtype === 'message_deleted' ? frame.deleted_ts || (frame.previous_message || {}).ts : inner.ts;
        if (!TS.test(target || '')) return [];
        const key = `${team}:${channelId}:${target}`;
        const held = recent.get(key);
        // At the narrower level only what was sent is ever corrected; Patcher has nothing else to correct.
        if (ws.level !== 'page' && !(held && held.sent)) {
          if (held && subtype === 'message_deleted') recent.delete(key);
          return [];
        }
        if (subtype === 'message_deleted' || inner.subtype === 'tombstone') return [{ kind: 'delete', teamId: team, channelId, ts: target }];
        if (typeof inner.text !== 'string' || inner.text === (frame.previous_message || {}).text) return [];
        const own = ws.selfUserId && inner.user === ws.selfUserId;
        if (held) held.item.text = own ? '' : scrub(inner.text).slice(0, MAX_TEXT);
        return own ? [] : [{ kind: 'edit', teamId: team, channelId, ts: target, text: scrub(inner.text).slice(0, MAX_TEXT) }];
      }

      if (frame.hidden || subtype === 'message_replied' || !TS.test(frame.ts || '')) return [];
      c.seen += 1;
      c.lastFrameAt = at;
      preview(team, frame, frame.text);
      if (!ws) return [];
      if (frame.live > 1) {
        totals.ambiguous += 1;
        return [];
      }

      const key = `${team}:${channelId}:${frame.ts}`;
      if (recent.has(key)) return [];
      const channelType = channelTypeOf(channelId, frame.channel_type);
      const direct = isDirect(channelId, frame.channel_type);
      const own = Boolean(ws.selfUserId && frame.user === ws.selfUserId && !subtype && !frame.bot);
      const item = {
        kind: 'message',
        teamId: team,
        channelId,
        channelType,
        ts: frame.ts,
        // The owner's own words are never sent: Patcher needs only to know that he answered.
        text: own ? '' : scrub(frame.text || '').slice(0, MAX_TEXT),
      };
      if (TS.test(frame.thread_ts || '')) item.threadTs = frame.thread_ts;
      if (MEMBER.test(frame.user || '')) item.userId = frame.user;
      if (frame.name && !own) item.senderName = scrub(frame.name).slice(0, 80);
      if (subtype) item.subtype = subtype.slice(0, 40);
      if (frame.bot) item.bot = true;

      const mentions = Boolean(ws.selfUserId) && typeof frame.text === 'string' && frame.text.includes(`<@${ws.selfUserId}>`);
      const send = ws.level === 'page' || (own ? direct : direct || mentions);
      remember(key, { at, item, sent: send });
      if (!send) return [];
      c.sent += 1;
      return [item];
    }

    /** Adds what the page shows to an item about to be sent: the channel's name and the sender's. */
    function withNames(item, names) {
      if (item.kind !== 'message' || !names) return item;
      const out = { ...item };
      const channel = names.channels && names.channels[item.channelId];
      if (!out.channelName && channel && item.channelType !== 'im' && item.channelType !== 'mpim') out.channelName = String(channel).slice(0, 80);
      const user = item.userId && names.users && names.users[item.userId];
      if (!out.senderName && user && out.text !== '') out.senderName = String(user).slice(0, 80);
      return out;
    }

    return {
      setConfig,
      setPreview,
      onFrame,
      withNames,
      counts: () => JSON.parse(JSON.stringify(counts)),
      totals: () => ({ ...totals }),
      frameTeams: () => ({ ...frameTeams }),
      previews: () => previews.slice(),
      held: () => recent.size,
    };
  }

  const STATE_RANK = { open: 3, asleep: 2, signed_out: 1, closed: 0 };

  /**
   * One entry per workspace from what each tab said. `tabs` are this minute's tabs on
   * app.slack.com; `before` is what the tabs showed last time, by tab id; `stillThere`
   * says, for a tab that no longer shows app.slack.com, whether the tab itself still exists.
   */
  function workspaceStates(tabs, before, stillThere, wanted) {
    const out = new Map();
    const put = (team, state, detail, tab) => {
      const current = out.get(team);
      if (current && STATE_RANK[current.state] >= STATE_RANK[state]) return;
      out.set(team, { teamId: team, state, detail, tab });
    };
    const seenTabs = new Set();
    for (const tab of tabs) {
      seenTabs.add(tab.tabId);
      const was = before[tab.tabId];
      if (tab.team) {
        if (tab.discarded) put(tab.team, 'asleep', 'Chrome discarded the tab', tab);
        else if (!tab.answered) put(tab.team, 'asleep', 'no answer: reload the tab', tab);
        else put(tab.team, 'open', tab.frozen ? 'Chrome reports the tab as frozen' : undefined, tab);
      } else if (was && tab.kind !== 'client') {
        // A tab that showed a workspace and now shows another Slack page: the usual sign of a sign-out.
        put(was, 'signed_out', tab.kind === 'signin' ? 'the tab shows a sign-in page' : 'the tab left the workspace', tab);
      }
    }
    for (const [tabId, team] of Object.entries(before)) {
      if (seenTabs.has(Number(tabId)) || out.has(team)) continue;
      if (stillThere[tabId]) put(team, 'signed_out', 'the tab left app.slack.com', null);
    }
    for (const team of wanted) if (!out.has(team)) put(team, 'closed', undefined, null);
    return [...out.values()];
  }

  /** The spike's readout from the minute log: how long the reader ran, where it was silent, and what each workspace did. */
  function summariseTicks(ticks, gapMs) {
    const gap = gapMs || 150000;
    const summary = { from: null, to: null, ticks: ticks.length, gaps: [], teams: {} };
    let previous = null;
    const last = {};
    for (const tick of ticks) {
      if (summary.from === null) summary.from = tick.t;
      summary.to = tick.t;
      const silent = previous !== null && tick.t - previous > gap;
      if (silent) summary.gaps.push({ from: previous, to: tick.t, minutes: Math.round((tick.t - previous) / 60000) });
      // A report stands for the time since the one before it, so "Check now" does not count as a minute; the first report, and the first after a silence, stand for one minute.
      const covers = previous === null || silent ? 60000 : Math.max(0, tick.t - previous);
      previous = tick.t;
      for (const [team, entry] of Object.entries(tick.w || {})) {
        const state = entry[0];
        if (!summary.teams[team]) summary.teams[team] = { ms: {}, minutes: { open: 0, asleep: 0, signed_out: 0, closed: 0 }, seen: 0, sent: 0, changes: [], signOuts: 0 };
        const t = summary.teams[team];
        t.ms[state] = (t.ms[state] || 0) + covers;
        t.seen += entry[1] || 0;
        t.sent += entry[2] || 0;
        if (last[team] !== undefined && last[team] !== state) {
          t.changes.push({ at: tick.t, from: last[team], to: state });
          if (state === 'signed_out') t.signOuts += 1;
        }
        last[team] = state;
      }
    }
    for (const t of Object.values(summary.teams)) {
      for (const [state, ms] of Object.entries(t.ms)) t.minutes[state] = Math.round(ms / 60000);
      delete t.ms;
    }
    return summary;
  }

  /** The address the extension posts to: https, or plain http on this computer only. */
  function cleanBaseUrl(value) {
    let url;
    try {
      url = new URL(String(value || '').trim());
    } catch {
      return null;
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (/(^|\.)slack\.com$/i.test(url.hostname) || url.username || url.password) return null;
    return url.origin;
  }

  const isDeviceKey = (value) => /^pdk_[A-Za-z0-9_-]{32}$/.test(String(value || ''));

  globalThis.PatcherCompanion = { scrub, teamFromPath, pageKind, isDirect, channelTypeOf, createCapture, workspaceStates, summariseTicks, cleanBaseUrl, isDeviceKey };
})();
