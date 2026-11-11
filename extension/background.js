/*
 * The extension's background worker. Chrome starts it for an alarm or a message and stops
 * it when it is idle, so everything it knows is in storage, not in memory.
 *
 * It is the only part that talks to the network, and it talks to one place: the Patcher
 * address it was paired with, with the device key. Three requests exist: fetch the list of
 * workspaces to capture, post captured messages, post the minute report. It makes no
 * request to Slack and has no permission that would let it read Slack's cookies.
 */
'use strict';

importScripts('lib.js');

const { teamFromPath, pageKind, workspaceStates, summariseTicks, cleanBaseUrl, isDeviceKey } = globalThis.PatcherCompanion;

const SLACK_TABS = 'https://app.slack.com/*';
const ALARM = 'tick';
const MAX_QUEUE = 500;
const MAX_BATCH = 100;
const MAX_TICKS = 2880;
const MAX_EVENTS = 500;
const GAP_MS = 150000;
const ASK_TIMEOUT_MS = 2500;
const FETCH_TIMEOUT_MS = 15000;

// The key and the queue are for the worker and the extension's own page only, not for the scripts that run in Slack's pages.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});

const local = (keys) => chrome.storage.local.get(keys);
const session = (keys) => chrome.storage.session.get(keys);

/** One thing at a time: a tick and a batch of messages never interleave their reads and writes. */
let chain = Promise.resolve();
const inTurn = (work) => {
  const next = chain.then(work, work);
  chain = next.catch(() => {});
  return next;
};

const settingsOf = (stored) => ({
  config: stored.pairing && !stored.pairing.revoked && stored.config ? stored.config : null,
  preview: stored.preview === true,
});

async function call(pairing, method, path, body) {
  try {
    const response = await fetch(`${pairing.baseUrl}${path}`, {
      method,
      headers: body === undefined ? { authorization: `Bearer ${pairing.key}` } : { authorization: `Bearer ${pairing.key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

async function noteResult(pairing, status) {
  if (status === 401 || status === 403) {
    // The key was revoked in Patcher. Stop, and forget what was waiting to be sent.
    await chrome.storage.local.set({ pairing: { ...pairing, revoked: true, lastError: 'Patcher no longer accepts this key.' }, config: null });
    await chrome.storage.session.set({ queue: [], pending: {} });
    return false;
  }
  if (status >= 200 && status < 300) {
    await chrome.storage.local.set({ pairing: { ...pairing, lastOkAt: Date.now(), lastError: null } });
    return true;
  }
  await chrome.storage.local.set({ pairing: { ...pairing, lastError: status === 0 ? 'Patcher could not be reached.' : `Patcher answered ${status}.` } });
  return false;
}

async function flush() {
  for (;;) {
    const { pairing } = await local(['pairing']);
    if (!pairing || pairing.revoked) return;
    const { queue = [] } = await session(['queue']);
    if (!queue.length) return;
    const batch = queue.slice(0, MAX_BATCH);
    const result = await call(pairing, 'POST', '/ingest/slack', { items: batch });
    const ok = await noteResult(pairing, result.status);
    // A batch Patcher will never take is dropped, so one bad message cannot hold up the rest.
    if (!ok && result.status !== 400 && result.status !== 413) return;
    const current = (await session(['queue'])).queue || [];
    await chrome.storage.session.set({ queue: current.slice(batch.length) });
    if (!ok) await bump('dropped', batch.length);
  }
}

async function bump(key, by) {
  const { totals = {} } = await local(['totals']);
  totals[key] = (totals[key] || 0) + by;
  await chrome.storage.local.set({ totals });
}

async function enqueue(items) {
  const stored = await local(['pairing', 'config']);
  const config = settingsOf(stored).config;
  if (!config) return;
  const allowed = new Set((config.workspaces || []).map((w) => w.teamId));
  const fresh = items.filter((item) => item && allowed.has(item.teamId));
  if (!fresh.length) return;
  const { queue = [] } = await session(['queue']);
  const next = queue.concat(fresh);
  const over = Math.max(0, next.length - MAX_QUEUE);
  try {
    await chrome.storage.session.set({ queue: next.slice(over) });
  } catch {
    // Out of room: keep the newer half.
    await chrome.storage.session.set({ queue: next.slice(Math.ceil(next.length / 2)) });
  }
  if (over) await bump('dropped', over);
  await flush();
}

const slackTabs = () => chrome.tabs.query({ url: SLACK_TABS }).catch(() => []);

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function ask(tabId, message) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message).catch(() => null),
    new Promise((resolve) => {
      setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
    }),
  ]);
}

const tabExists = (tabId) => chrome.tabs.get(Number(tabId)).then(
  () => true,
  () => false,
);

function tabDiagnostics(tab) {
  const r = tab.report;
  const tap = (r && r.tap) || null;
  const types = Object.entries((tap && tap.types) || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  return {
    team: tab.team || undefined,
    state: tab.state,
    pinned: tab.pinned,
    discarded: tab.discarded,
    frozen: tab.frozen,
    autoDiscardable: tab.autoDiscardable,
    hidden: r ? r.hidden === true : undefined,
    notification: r ? r.notification : undefined,
    tap: Boolean(tap),
    sockets: tap ? tap.sockets : 0,
    socketsOpen: tap ? tap.socketsOpen : 0,
    liveSockets: tap ? tap.liveSockets : 0,
    frames: tap ? tap.frames : 0,
    messageFrames: tap ? tap.messageFrames : 0,
    notificationFrames: tap ? tap.notificationFrames : 0,
    binary: tap ? tap.binary : 0,
    unparsed: tap ? tap.unparsed : 0,
    large: tap ? tap.large : 0,
    workers: tap ? tap.workers : 0,
    sharedWorkers: tap ? tap.sharedWorkers : 0,
    lastFrameAgoS: tap && tap.lastFrameAt ? Math.max(0, Math.round((Date.now() - tap.lastFrameAt) / 1000)) : undefined,
    perSocket: tap ? tap.perSocket : undefined,
    types: Object.fromEntries(types),
    teams: r ? r.frameTeams : undefined,
    ambiguous: r ? r.totals.ambiguous : 0,
    notificationOnly: r ? r.totals.notificationOnly : 0,
    dom: r ? r.dom : undefined,
  };
}

async function tick() {
  const at = Date.now();
  const stored = await local(['pairing', 'config', 'preview', 'known', 'ticks', 'events', 'starts', 'totals', 'lastTickAt']);
  const mem = await session(['tabs', 'tabCounts', 'pending', 'queue']);
  const settings = settingsOf(stored);
  const before = mem.tabs || {};
  const tabCounts = mem.tabCounts || {};
  const pending = mem.pending || {};
  const known = stored.known || {};
  const events = stored.events || [];

  const found = await slackTabs();
  const tabs = [];
  for (const tab of found) {
    const path = pathOf(tab.url);
    const report = tab.discarded ? null : await ask(tab.id, { kind: 'report', settings });
    tabs.push({
      tabId: tab.id,
      team: report ? report.team : teamFromPath(path),
      kind: report ? report.kind : pageKind(path),
      answered: Boolean(report),
      discarded: tab.discarded === true,
      frozen: tab.frozen === true,
      pinned: tab.pinned === true,
      autoDiscardable: tab.autoDiscardable !== false,
      report,
    });
  }

  // What each tab counted since it was last asked. A reloaded page starts from nothing.
  const deltas = {};
  const nextCounts = {};
  for (const tab of tabs) {
    if (!tab.report) {
      if (tabCounts[tab.tabId]) nextCounts[tab.tabId] = tabCounts[tab.tabId];
      continue;
    }
    const previous = tabCounts[tab.tabId] && tabCounts[tab.tabId].bootId === tab.report.bootId ? tabCounts[tab.tabId].counts : {};
    for (const [team, c] of Object.entries(tab.report.counts || {})) {
      const was = previous[team] || { seen: 0, sent: 0 };
      const d = deltas[team] || (deltas[team] = { seen: 0, sent: 0, lastFrameAt: 0 });
      d.seen += Math.max(0, c.seen - was.seen);
      d.sent += Math.max(0, c.sent - was.sent);
      d.lastFrameAt = Math.max(d.lastFrameAt, c.lastFrameAt || 0);
    }
    nextCounts[tab.tabId] = { bootId: tab.report.bootId, counts: tab.report.counts || {} };
    if (tab.team) {
      const k = known[tab.team] || (known[tab.team] = {});
      if (tab.report.name) k.name = tab.report.name;
      if (tab.report.domain) k.domain = tab.report.domain;
      if (tab.report.selfUserId) k.selfUserId = tab.report.selfUserId;
    }
  }

  const stillThere = {};
  const seenIds = new Set(tabs.map((t) => String(t.tabId)));
  for (const tabId of Object.keys(before)) if (!seenIds.has(tabId)) stillThere[tabId] = await tabExists(tabId);

  const wanted = settings.config ? (settings.config.workspaces || []).map((w) => w.teamId) : [];
  const states = workspaceStates(tabs, before, stillThere, wanted).map((s) => ({ teamId: s.teamId, state: s.state, detail: s.detail }));
  for (const tab of tabs) tab.state = tab.team ? (tab.answered && !tab.discarded ? 'open' : 'asleep') : tab.kind;

  // Which workspace each tab shows, kept so that a tab that leaves it is read as a sign-out.
  const nextTabs = {};
  for (const tab of tabs) {
    if (tab.team) nextTabs[tab.tabId] = tab.team;
    else if (before[tab.tabId] && tab.kind !== 'client') nextTabs[tab.tabId] = before[tab.tabId];
  }
  for (const [tabId, there] of Object.entries(stillThere)) if (there) nextTabs[tabId] = before[tabId];

  for (const [team, d] of Object.entries(deltas)) {
    const p = pending[team] || (pending[team] = { seen: 0, sent: 0, lastFrameAt: 0 });
    p.seen += d.seen;
    p.sent += d.sent;
    p.lastFrameAt = Math.max(p.lastFrameAt, d.lastFrameAt);
  }

  // The local log, for the spike readout: one line a minute, counts and states only.
  const ticks = stored.ticks || [];
  const lastTick = ticks[ticks.length - 1];
  const line = { t: at, w: {} };
  for (const s of states) line.w[s.teamId] = [s.state, (deltas[s.teamId] || {}).seen || 0, (deltas[s.teamId] || {}).sent || 0];
  if (lastTick && at - lastTick.t > GAP_MS) events.push({ at, kind: 'gap', from: lastTick.t });
  for (const s of states) {
    const was = lastTick && lastTick.w[s.teamId] ? lastTick.w[s.teamId][0] : undefined;
    if (was !== undefined && was !== s.state) events.push({ at, kind: 'state', team: s.teamId, from: was, to: s.state, detail: s.detail });
  }
  ticks.push(line);

  const diagnostics = {
    tabs: tabs.map(tabDiagnostics),
    worker: { starts: stored.starts || 0, queue: (mem.queue || []).length, dropped: (stored.totals || {}).dropped || 0 },
  };
  await chrome.storage.session.set({ tabs: nextTabs, tabCounts: nextCounts, pending, lastReport: { at, tabs: diagnostics.tabs, states } });
  await chrome.storage.local.set({ known, ticks: ticks.slice(-MAX_TICKS), events: events.slice(-MAX_EVENTS), lastTickAt: at });

  const wantedDown = states.some((s) => wanted.includes(s.teamId) && s.state !== 'open');
  const revoked = Boolean(stored.pairing && stored.pairing.revoked);
  chrome.action.setBadgeText({ text: revoked || wantedDown ? '!' : '' }).catch(() => {});

  const pairing = stored.pairing;
  if (!pairing || pairing.revoked) {
    await chrome.storage.session.set({ pending: {} });
    return;
  }
  const body = {
    version: chrome.runtime.getManifest().version,
    workspaces: states.map((s) => {
      const k = known[s.teamId] || {};
      const p = pending[s.teamId] || { seen: 0, sent: 0, lastFrameAt: 0 };
      const entry = { teamId: s.teamId, state: s.state, seen: p.seen, sent: p.sent };
      if (s.detail) entry.detail = s.detail;
      if (k.name) entry.name = k.name;
      if (k.domain) entry.domain = k.domain;
      if (k.selfUserId) entry.selfUserId = k.selfUserId;
      if (p.lastFrameAt) entry.lastFrameAt = new Date(p.lastFrameAt).toISOString();
      return entry;
    }),
    diagnostics,
  };
  const result = await call(pairing, 'POST', '/ingest/slack/heartbeat', body);
  const ok = await noteResult(pairing, result.status);
  if (!ok) {
    if (result.status === 401 || result.status === 403) await broadcast();
    return;
  }
  // Patcher has these counts now; what tabs count from here on is new.
  const after = (await session(['pending'])).pending || {};
  for (const w of body.workspaces) {
    const p = after[w.teamId];
    if (!p) continue;
    p.seen = Math.max(0, p.seen - w.seen);
    p.sent = Math.max(0, p.sent - w.sent);
  }
  await chrome.storage.session.set({ pending: after });
  if (result.json && result.json.ok === true) {
    const config = { reading: result.json.reading !== false, workspaces: result.json.workspaces || [], device: result.json.device || null, fetchedAt: Date.now() };
    const changed = JSON.stringify((stored.config || {}).workspaces) !== JSON.stringify(config.workspaces) || (stored.config || {}).reading !== config.reading;
    await chrome.storage.local.set({ config });
    if (changed) await broadcast();
  }
  await flush();
}

/** Tells every Slack tab which workspaces are switched on now, without waiting for the next minute. */
async function broadcast() {
  const settings = settingsOf(await local(['pairing', 'config', 'preview']));
  const tabs = await slackTabs();
  await Promise.all(tabs.filter((t) => !t.discarded).map((t) => ask(t.id, { kind: 'settings', settings })));
}

async function pair(input) {
  const baseUrl = cleanBaseUrl(input.baseUrl);
  if (!baseUrl) return { ok: false, error: 'Write the address of your Patcher, starting with https://.' };
  const key = String(input.key || '').trim();
  if (!isDeviceKey(key)) return { ok: false, error: 'That is not a device key. Copy it from "Pair a reader" on Patcher\'s Slack inbox screen.' };
  const pairing = { baseUrl, key, pairedAt: Date.now(), revoked: false, lastOkAt: null, lastError: null };
  const result = await call(pairing, 'GET', '/ingest/slack/config');
  if (result.status === 401 || result.status === 403) return { ok: false, error: 'Patcher does not accept this key. It may have been revoked; issue a new one.' };
  if (result.status !== 200 || !result.json || result.json.ok !== true) {
    return { ok: false, error: result.status === 0 ? 'That address could not be reached.' : `That address answered ${result.status}; it may not be a Patcher with the companion.` };
  }
  await chrome.storage.local.set({
    pairing: { ...pairing, lastOkAt: Date.now() },
    config: { reading: result.json.reading !== false, workspaces: result.json.workspaces || [], device: result.json.device || null, fetchedAt: Date.now() },
  });
  await chrome.storage.session.set({ queue: [], pending: {} });
  await tick();
  await broadcast();
  return { ok: true };
}

async function unpair() {
  await chrome.storage.local.remove(['pairing', 'config']);
  await chrome.storage.session.set({ queue: [], pending: {} });
  await broadcast();
  return { ok: true };
}

async function status() {
  const stored = await local(['pairing', 'config', 'preview', 'ticks', 'events', 'starts', 'totals', 'known', 'lastTickAt']);
  const mem = await session(['queue', 'lastReport']);
  const pairing = stored.pairing
    ? // The key itself never leaves the worker, not even for the extension's own page.
      { baseUrl: stored.pairing.baseUrl, pairedAt: stored.pairing.pairedAt, revoked: stored.pairing.revoked === true, lastOkAt: stored.pairing.lastOkAt, lastError: stored.pairing.lastError }
    : null;
  return {
    version: chrome.runtime.getManifest().version,
    pairing,
    config: stored.config || null,
    preview: stored.preview === true,
    known: stored.known || {},
    last: mem.lastReport || null,
    lastTickAt: stored.lastTickAt || null,
    queue: (mem.queue || []).length,
    starts: stored.starts || 0,
    totals: stored.totals || {},
    summary: summariseTicks(stored.ticks || [], GAP_MS),
    events: (stored.events || []).slice(-60),
  };
}

async function previews() {
  const tabs = await slackTabs();
  const answers = await Promise.all(tabs.filter((t) => !t.discarded).map((t) => ask(t.id, { kind: 'previews' })));
  return answers.filter(Boolean);
}

const fromOwnPage = (sender) => Boolean(sender && sender.id === chrome.runtime.id && sender.url && sender.url.startsWith(chrome.runtime.getURL('')));

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !sender || sender.id !== chrome.runtime.id) return undefined;
  const answer = (work) => {
    inTurn(work).then(respond, () => respond(null));
    return true;
  };
  // From a Slack tab: two things only.
  if (message.kind === 'hello') return answer(async () => settingsOf(await local(['pairing', 'config', 'preview'])));
  if (message.kind === 'items') {
    if (Array.isArray(message.items) && message.items.length <= MAX_BATCH) inTurn(() => enqueue(message.items)).catch(() => {});
    return undefined;
  }
  // Everything else is for the extension's own page.
  if (!fromOwnPage(sender)) return undefined;
  if (message.kind === 'status') return answer(status);
  if (message.kind === 'pair') return answer(() => pair(message));
  if (message.kind === 'unpair') return answer(unpair);
  if (message.kind === 'tick') return answer(async () => (await tick(), status()));
  if (message.kind === 'previews') return answer(previews);
  if (message.kind === 'preview') {
    return answer(async () => {
      await chrome.storage.local.set({ preview: message.on === true });
      await broadcast();
      return { ok: true };
    });
  }
  if (message.kind === 'clearLog') {
    return answer(async () => {
      await chrome.storage.local.set({ ticks: [], events: [] });
      return { ok: true };
    });
  }
  return undefined;
});

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) inTurn(tick).catch(() => {});
});
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Counted to learn how often Chrome restarts the worker; part of the spike's fifth question.
inTurn(async () => {
  const { starts = 0 } = await local(['starts']);
  await chrome.storage.local.set({ starts: starts + 1 });
}).catch(() => {});
ensureAlarm();
