/*
 * Runs in the page's own world on app.slack.com, before Slack's scripts, and listens to the
 * sockets the page opens. It only listens: it sends nothing on a socket, makes no request,
 * and changes nothing the page does.
 *
 * What it must never touch, and does not:
 *   - the address a socket is opened with (it carries the session's credential),
 *   - cookies, localStorage, sessionStorage, IndexedDB,
 *   - anything the page sends.
 *
 * From everything Slack's server pushes, two kinds of frame are passed on, and of those
 * only the listed fields: a message, and Slack's own "raise a notification" frame. Every
 * other frame is counted by its type name and dropped here.
 *
 * It cannot use the extension's interfaces from this world, so it hands each record to the
 * extension's content script as a DOM event carrying a JSON string.
 */
(() => {
  'use strict';

  const FRAME_EVENT = 'patcher-companion:frame';
  const ASK_EVENT = 'patcher-companion:ask';
  const STATS_EVENT = 'patcher-companion:stats';

  const MAX_FRAME_CHARS = 512 * 1024;
  const MAX_TEXT = 40000;
  const MAX_TYPES = 60;
  const TYPE_NAME = /^[a-z0-9_.:-]{1,40}$/;
  const TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{8,}/g;
  /** A socket counts as carrying messages for this long after its last one. */
  const LIVE_MS = 10 * 60 * 1000;

  const NativeSocket = window.WebSocket;
  if (typeof NativeSocket !== 'function') return;
  const listen = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent.bind(document);
  const Custom = window.CustomEvent;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const now = Date.now;

  const stats = {
    installedAt: now(),
    sockets: 0,
    socketsOpen: 0,
    frames: 0,
    messageFrames: 0,
    notificationFrames: 0,
    binary: 0,
    unparsed: 0,
    large: 0,
    workers: 0,
    sharedWorkers: 0,
    lastFrameAt: 0,
    types: {},
  };
  /** Per socket, by the order it was opened: whether it is open and when it last carried a message. */
  const sockets = [];

  const str = (value, max) => (typeof value === 'string' && value ? value.slice(0, max).replace(TOKEN, '[removed]') : undefined);
  const id = (value) => (typeof value === 'string' && /^[A-Z0-9]{2,40}$/.test(value) ? value : undefined);
  const ts = (value) => (typeof value === 'string' && /^\d{9,11}\.\d{1,6}$/.test(value) ? value : undefined);

  const inner = (m) =>
    m && typeof m === 'object'
      ? { ts: ts(m.ts), text: typeof m.text === 'string' ? m.text.slice(0, MAX_TEXT).replace(TOKEN, '[removed]') : undefined, user: id(m.user), subtype: str(m.subtype, 40) }
      : undefined;

  function pickMessage(f) {
    const profile = f.user_profile && typeof f.user_profile === 'object' ? f.user_profile : null;
    return {
      type: 'message',
      subtype: str(f.subtype, 40),
      channel: id(f.channel),
      channel_type: str(f.channel_type, 12),
      user: id(f.user),
      bot: Boolean(f.bot_id) || undefined,
      text: typeof f.text === 'string' ? f.text.slice(0, MAX_TEXT).replace(TOKEN, '[removed]') : '',
      ts: ts(f.ts),
      thread_ts: ts(f.thread_ts),
      team: id(f.team),
      user_team: id(f.user_team),
      source_team: id(f.source_team),
      hidden: f.hidden === true || undefined,
      deleted_ts: ts(f.deleted_ts),
      message: inner(f.message),
      previous_message: inner(f.previous_message),
      name: profile ? str(profile.display_name, 80) || str(profile.real_name, 80) : undefined,
    };
  }

  function pickNotification(f) {
    return {
      type: 'desktop_notification',
      channel: id(f.channel),
      ts: ts(f.msg) || ts(f.event_ts),
      thread_ts: ts(f.thread_ts),
      title: str(f.title, 120),
      subtitle: str(f.subtitle, 120),
      content: str(f.content, 4000),
    };
  }

  function liveSockets(at) {
    let n = 0;
    for (const s of sockets) if (s.open && at - s.lastMessageAt < LIVE_MS) n += 1;
    return n;
  }

  function emit(record, socket) {
    const at = now();
    socket.lastMessageAt = at;
    record.socket = socket.n;
    record.live = liveSockets(at);
    record.at = at;
    dispatch(new Custom(FRAME_EVENT, { detail: stringify(record) }));
  }

  function onFrame(data, socket) {
    stats.frames += 1;
    stats.lastFrameAt = now();
    socket.frames += 1;
    if (typeof data !== 'string') {
      stats.binary += 1;
      return;
    }
    if (data.length > MAX_FRAME_CHARS) {
      stats.large += 1;
      return;
    }
    let frame;
    try {
      frame = parse(data);
    } catch {
      stats.unparsed += 1;
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      stats.unparsed += 1;
      return;
    }
    const type = typeof frame.type === 'string' && TYPE_NAME.test(frame.type) ? frame.type : 'other';
    if (type in stats.types || Object.keys(stats.types).length < MAX_TYPES) stats.types[type] = (stats.types[type] || 0) + 1;
    if (type === 'message') {
      stats.messageFrames += 1;
      socket.messages += 1;
      emit(pickMessage(frame), socket);
    } else if (type === 'desktop_notification') {
      stats.notificationFrames += 1;
      emit(pickNotification(frame), socket);
    }
  }

  function watch(instance) {
    const socket = { n: sockets.length + 1, open: false, frames: 0, messages: 0, lastMessageAt: 0 };
    if (sockets.length < 200) sockets.push(socket);
    stats.sockets += 1;
    listen.call(instance, 'open', () => {
      socket.open = true;
      stats.socketsOpen += 1;
    });
    listen.call(instance, 'close', () => {
      if (socket.open) stats.socketsOpen -= 1;
      socket.open = false;
    });
    listen.call(instance, 'message', (event) => {
      try {
        onFrame(event.data, socket);
      } catch {
        // Whatever goes wrong here must never reach the page.
      }
    });
  }

  const counted = (Native, key) => {
    if (typeof Native !== 'function') return Native;
    const proxy = new Proxy(Native, {
      construct(target, args, newTarget) {
        stats[key] += 1;
        return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
      },
    });
    return proxy;
  };

  const Socket = new Proxy(NativeSocket, {
    construct(target, args, newTarget) {
      // The arguments are passed through untouched and never looked at: the address holds the session's credential.
      const instance = Reflect.construct(target, args, newTarget === Socket ? target : newTarget);
      try {
        watch(instance);
      } catch {
        // The page gets its socket whatever happens here.
      }
      return instance;
    },
  });
  window.WebSocket = Socket;
  // Counted only, to learn whether Slack moves its socket into a worker, where this script cannot follow.
  window.Worker = counted(window.Worker, 'workers');
  if ('SharedWorker' in window) window.SharedWorker = counted(window.SharedWorker, 'sharedWorkers');

  listen.call(document, ASK_EVENT, () => {
    const at = now();
    const report = {
      ...stats,
      liveSockets: liveSockets(at),
      perSocket: sockets.slice(-12).map((s) => ({ n: s.n, open: s.open, frames: s.frames, messages: s.messages })),
    };
    dispatch(new Custom(STATS_EVENT, { detail: stringify(report) }));
  });
})();
