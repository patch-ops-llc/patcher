/*
 * The extension's own script on app.slack.com, in a world separate from the page's. It
 * takes the records tap.js hands over, decides with lib.js what may leave the tab, and
 * gives that to the background worker. It answers the worker's minute question about the
 * state of this tab.
 *
 * It reads from the page only what is displayed, and only to label a message: the names in
 * the sidebar and next to messages, and the workspace's name. It never reads a cookie,
 * localStorage or any other store of the page, and it never writes to the page, clicks or
 * types anything, or makes a request.
 */
(() => {
  'use strict';

  const { createCapture, teamFromPath, pageKind } = globalThis.PatcherCompanion;
  const FRAME_EVENT = 'patcher-companion:frame';
  const ASK_EVENT = 'patcher-companion:ask';
  const STATS_EVENT = 'patcher-companion:stats';

  const bootId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const capture = createCapture();
  let alive = true;

  const tabTeam = () => teamFromPath(location.pathname);

  // What the page shows, for names only. These selectors are from memory of Slack's web
  // client and unverified; when one finds nothing, a message goes without that name.
  const names = { channels: {}, users: {} };
  const MAX_NAMES = 400;
  const put = (map, key, value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!key || !text) return;
    if (!(key in map) && Object.keys(map).length >= MAX_NAMES) return;
    map[key] = text;
  };

  function readNames() {
    let channels = 0;
    let messages = 0;
    try {
      for (const el of document.querySelectorAll('[data-qa-channel-sidebar-channel-id]')) {
        const channelId = el.getAttribute('data-qa-channel-sidebar-channel-id');
        const label = el.querySelector('[data-qa^="channel_sidebar_name_"]') || el;
        if (/^[CG][A-Z0-9]{2,}$/.test(channelId || '')) put(names.channels, channelId, label.textContent);
        channels += 1;
        if (channels >= MAX_NAMES) break;
      }
      for (const el of document.querySelectorAll('[data-qa="message_sender_name"]')) {
        const userId = el.getAttribute('data-message-sender');
        if (/^[UW][A-Z0-9]{2,}$/.test(userId || '')) put(names.users, userId, el.textContent);
        messages += 1;
        if (messages >= 200) break;
      }
    } catch {
      // A page that does not look as expected gives no names. Capture does not depend on them.
    }
    return { channels, messages };
  }

  /** The workspace's name, from the tab's title: "… - Workspace - Slack". */
  function workspaceName() {
    const parts = String(document.title || '').split(' - ').map((p) => p.trim()).filter(Boolean);
    return parts.length >= 2 && /^Slack$/i.test(parts[parts.length - 1]) ? parts[parts.length - 2].slice(0, 80) : undefined;
  }

  /** The workspace's address, from the link on a message's time, which Slack writes as https://name.slack.com/archives/…. */
  function workspaceDomain() {
    try {
      for (const a of document.querySelectorAll('a.c-timestamp[href*="/archives/"]')) {
        const m = /^https:\/\/([a-z0-9][a-z0-9-]{0,62})\.slack\.com\/archives\/[A-Z0-9]+\/p\d+/.exec(a.href || '');
        if (m && m[1] !== 'app') return m[1];
      }
    } catch {
      // No address is learned; Patcher links to the message another way.
    }
    return undefined;
  }

  /** The owner's member id, as a suggestion only, from the picture on his own menu button. */
  function selfUserId(team) {
    try {
      const img = document.querySelector('[data-qa="user-button"] img');
      const m = /\/(T[A-Z0-9]+)-(U[A-Z0-9]+)-/.exec((img && img.src) || '');
      return m && m[1] === team ? m[2] : undefined;
    } catch {
      return undefined;
    }
  }

  function notificationPermission() {
    try {
      return typeof Notification === 'function' ? Notification.permission : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function tapStats() {
    let stats = null;
    const onStats = (event) => {
      try {
        stats = JSON.parse(event.detail);
      } catch {
        stats = null;
      }
    };
    document.addEventListener(STATS_EVENT, onStats);
    document.dispatchEvent(new CustomEvent(ASK_EVENT));
    document.removeEventListener(STATS_EVENT, onStats);
    return stats;
  }

  function stop() {
    alive = false;
    document.removeEventListener(FRAME_EVENT, onFrame);
  }

  function send(message) {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // The extension was reloaded or removed: this copy of the script has nobody to talk to.
      stop();
    }
  }

  function onFrame(event) {
    let frame;
    try {
      frame = JSON.parse(event.detail);
    } catch {
      return;
    }
    const items = capture.onFrame(frame, tabTeam());
    if (!items.length) return;
    readNames();
    send({ kind: 'items', items: items.map((item) => capture.withNames(item, names)) });
  }
  document.addEventListener(FRAME_EVENT, onFrame);

  function apply(settings) {
    if (!settings) return;
    capture.setConfig(settings.config || null);
    capture.setPreview(settings.preview === true);
  }

  function report() {
    const team = tabTeam();
    const stats = tapStats();
    const dom = readNames();
    return {
      bootId,
      team,
      kind: pageKind(location.pathname),
      name: team ? workspaceName() : undefined,
      domain: team ? workspaceDomain() : undefined,
      selfUserId: team ? selfUserId(team) : undefined,
      hidden: document.hidden,
      notification: notificationPermission(),
      // Null when tap.js is not there: the tab was open before the extension was loaded.
      tap: stats,
      counts: capture.counts(),
      totals: capture.totals(),
      frameTeams: capture.frameTeams(),
      held: capture.held(),
      dom,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!alive || !message) return undefined;
    if (message.kind === 'report') {
      apply(message.settings);
      respond(report());
    } else if (message.kind === 'settings') {
      apply(message.settings);
      respond({ ok: true });
    } else if (message.kind === 'previews') {
      respond({ team: tabTeam(), previews: capture.previews() });
    }
    return undefined;
  });

  // Until the worker has said which workspaces are switched on, nothing leaves the tab.
  try {
    chrome.runtime.sendMessage({ kind: 'hello' }).then(apply, () => {});
  } catch {
    stop();
  }
})();
