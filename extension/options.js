/*
 * The extension's own page: pairing, the state of the Slack tabs, and the readout the spike
 * is judged from. It talks only to the background worker. Everything it shows is written as
 * text, never as markup.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ask = (message) => chrome.runtime.sendMessage(message);

  const STATE = { open: 'Open', asleep: 'Not answering', signed_out: 'Signed out', closed: 'No tab', client: 'Open', signin: 'Sign-in page', other: 'Not a workspace' };
  let current = null;

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const row = (cells) => {
    const tr = document.createElement('tr');
    for (const cell of cells) tr.append(cell instanceof Node ? cell : el('td', cell));
    return tr;
  };
  const fill = (node, children) => node.replaceChildren(...children);
  const time = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');
  const span = (minutes) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`);

  function teamLabel(status, team) {
    if (!team) return 'not a workspace';
    const known = status.known[team] || {};
    const configured = ((status.config && status.config.workspaces) || []).find((w) => w.teamId === team);
    return `${(configured && configured.name) || known.name || team}`;
  }

  function notesFor(tab) {
    const notes = [];
    if (tab.discarded) notes.push('Chrome discarded this tab to save memory. Click it once, then put app.slack.com on the "Always keep these sites active" list.');
    else if (tab.team && !tab.tap) notes.push('The extension is not in this tab: it was open before the extension was loaded. Reload the tab.');
    if (tab.frozen) notes.push('Chrome reports this tab as frozen.');
    if (tab.tap && tab.sockets === 0) notes.push('No socket has been opened in this page yet.');
    if (tab.tap && tab.sockets > 0 && tab.frames === 0) notes.push('A socket is open and nothing has arrived on it yet.');
    if (tab.liveSockets > 1) notes.push('More than one socket is carrying messages. The extension cannot tell which workspace each belongs to, so it sends nothing from this tab while that lasts.');
    if (tab.binary > 0 && tab.frames === tab.binary) notes.push('Every frame is binary: the extension cannot read this socket.');
    if (tab.workers > 0 && tab.sockets === 0) notes.push('The page started a worker and opened no socket itself: Slack may have moved its socket where this extension cannot listen.');
    if (tab.team && tab.notification && tab.notification !== 'denied') notes.push('Slack may raise notifications in this profile. Block them for app.slack.com so you are not alerted twice.');
    if (tab.team && tab.pinned === false) notes.push('Not pinned.');
    if (tab.ambiguous > 0) notes.push(`${tab.ambiguous} messages were held back because two sockets were live.`);
    if (tab.notificationOnly > 0) notes.push(`${tab.notificationOnly} came from a notification alone, without the message itself.`);
    return notes;
  }

  function render(status) {
    current = status;
    $('version').textContent = status.version;

    const pairing = status.pairing;
    $('paired').hidden = !pairing;
    $('pair').hidden = Boolean(pairing);
    if (pairing) {
      $('paired-url').textContent = pairing.baseUrl;
      $('paired-state').textContent = pairing.revoked ? 'Patcher has revoked this key. Nothing is sent.' : `Last answer from Patcher: ${time(pairing.lastOkAt)}. ${status.queue} waiting to be sent.`;
      $('paired-state').className = pairing.revoked ? 'bad' : '';
      $('paired-error').hidden = !pairing.lastError || pairing.revoked;
      $('paired-error').textContent = pairing.lastError || '';
    }

    const last = status.last || { tabs: [], states: [] };
    $('checked').textContent = status.lastTickAt ? `Last checked ${time(status.lastTickAt)}. The extension checks every minute by itself.` : 'Not checked yet.';
    $('no-tabs').hidden = last.tabs.length > 0;
    fill(
      $('tabs'),
      last.tabs.map((tab) => {
        const notes = el('td');
        for (const note of notesFor(tab)) notes.append(el('div', note, 'bad'));
        return row([
          teamLabel(status, tab.team),
          STATE[tab.state] || tab.state,
          `${tab.socketsOpen} open, ${tab.sockets} opened`,
          `${tab.frames}${tab.lastFrameAgoS === undefined ? '' : `, last ${tab.lastFrameAgoS} s ago`}`,
          `${tab.messageFrames} messages, ${tab.notificationFrames} notifications`,
          tab.team ? sentBy(status, tab.team) : '',
          notes,
        ]);
      }),
    );

    const configured = new Map(((status.config && status.config.workspaces) || []).map((w) => [w.teamId, w]));
    const teams = new Set([...last.states.map((s) => s.teamId), ...configured.keys()]);
    fill(
      $('workspaces'),
      [...teams].map((team) => {
        const state = last.states.find((s) => s.teamId === team);
        const on = configured.get(team);
        const where = !pairing
          ? 'Not paired: nothing is sent'
          : on
            ? on.level === 'page'
              ? 'Switched on: every message is sent'
              : `Switched on: direct messages and mentions only${on.selfUserId ? '' : ' (your member ID is not saved in Patcher, so a mention is recognised only when Slack asks for a notification)'}`
            : 'Switched off in Patcher: ignored';
        return row([teamLabel(status, team), state ? `${STATE[state.state]}${state.detail ? ` (${state.detail})` : ''}` : 'Not seen', where]);
      }),
    );

    const s = status.summary;
    $('ran').textContent = s.from ? `Log from ${time(s.from)} to ${time(s.to)}: ${s.ticks} reports, ${s.gaps.length} ${s.gaps.length === 1 ? 'silence' : 'silences'}.` : 'Nothing logged yet.';
    fill($('gaps'), s.gaps.length ? s.gaps.slice(-40).map((g) => el('li', `${time(g.from)} to ${time(g.to)}: ${span(g.minutes)} (Chrome closed, or the computer asleep)`)) : [el('li', 'None.', 'muted')]);
    fill(
      $('teams'),
      Object.entries(s.teams).map(([team, t]) => row([teamLabel(status, team), span(t.minutes.open), span(t.minutes.asleep), span(t.minutes.signed_out), span(t.minutes.closed), t.seen, t.sent, t.signOuts])),
    );
    const events = status.events.filter((e) => e.kind === 'state');
    fill(
      $('events'),
      events.length
        ? events.slice(-40).map((e) => el('li', `${time(e.at)}: ${teamLabel(status, e.team)} went from ${STATE[e.from] || e.from} to ${STATE[e.to] || e.to}${e.detail ? ` (${e.detail})` : ''}`))
        : [el('li', 'None.', 'muted')],
    );

    fill(
      $('types'),
      last.tabs
        .filter((tab) => tab.tap)
        .map((tab) => {
          const box = el('div');
          box.append(el('h4', teamLabel(status, tab.team)));
          const types = Object.entries(tab.types || {});
          box.append(el('p', types.length ? types.map(([name, n]) => `${name}: ${n}`).join(' · ') : 'No frame has arrived.'));
          const named = Object.entries(tab.teams || {});
          box.append(
            el(
              'p',
              `Workspace named inside message frames: ${named.length ? named.map(([team, n]) => `${team === 'none' ? 'none' : teamLabel(status, team)}: ${n}`).join(' · ') : 'no message yet'}. ` +
                `Sockets: ${(tab.perSocket || []).map((p) => `#${p.n} ${p.open ? 'open' : 'closed'}, ${p.frames} frames, ${p.messages} messages`).join('; ') || 'none'}. ` +
                `Workers started by the page: ${tab.workers}, shared: ${tab.sharedWorkers}. Binary frames: ${tab.binary}; unreadable: ${tab.unparsed}; too large: ${tab.large}.`,
              'muted',
            ),
          );
          return box;
        }),
    );
    $('worker').textContent = `Chrome has started the extension's background worker ${status.starts} times. Dropped unsent: ${status.totals.dropped || 0}.`;
    $('preview').checked = status.preview;
    $('preview-table').hidden = !status.preview;
  }

  function sentBy(status, team) {
    const t = status.summary.teams[team];
    return t ? `${t.sent} of ${t.seen} heard, in the log` : '';
  }

  async function refresh() {
    render(await ask({ kind: 'status' }));
    if (current && current.preview) {
      const tabs = (await ask({ kind: 'previews' })) || [];
      const lines = tabs.flatMap((t) => t.previews || []).sort((a, b) => b.at - a.at);
      fill(
        $('previews'),
        lines.map((p) => row([new Date(p.at).toLocaleTimeString(), teamLabel(current, p.team), p.channel, p.user, p.type === 'desktop_notification' ? 'notification' : 'message', p.text])),
      );
    }
  }

  /** The readout as text for pasting: counts, states and times. No message text, no key. */
  function readout(status) {
    const last = status.last || { tabs: [], states: [] };
    return JSON.stringify(
      {
        extension: status.version,
        at: new Date().toISOString(),
        paired: Boolean(status.pairing),
        workerStarts: status.starts,
        log: status.summary,
        changes: status.events,
        tabs: last.tabs,
      },
      null,
      2,
    );
  }

  $('pair').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('pair-error').hidden = true;
    const result = await ask({ kind: 'pair', baseUrl: $('base-url').value, key: $('key').value });
    $('key').value = '';
    if (!result || !result.ok) {
      $('pair-error').textContent = (result && result.error) || 'Pairing failed.';
      $('pair-error').hidden = false;
    }
    await refresh();
  });
  $('unpair').addEventListener('click', async () => {
    await ask({ kind: 'unpair' });
    await refresh();
  });
  $('tick').addEventListener('click', async () => {
    $('tick').disabled = true;
    try {
      render(await ask({ kind: 'tick' }));
      await refresh();
    } finally {
      $('tick').disabled = false;
    }
  });
  $('preview').addEventListener('change', async () => {
    await ask({ kind: 'preview', on: $('preview').checked });
    await refresh();
  });
  $('copy').addEventListener('click', async () => {
    if (!current) return;
    await navigator.clipboard.writeText(readout(current));
    $('copied').textContent = 'Copied.';
  });
  $('clear').addEventListener('click', async () => {
    await ask({ kind: 'clearLog' });
    await refresh();
  });

  refresh();
  setInterval(refresh, 5000);
})();
