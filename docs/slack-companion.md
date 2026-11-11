# The Slack companion

A Chrome extension that reads Slack workspaces where the Patcher app cannot be installed,
from the owner's own browser, and passes what it reads to Patcher. Design sections 8.3 to
8.5. The code is in [`extension/`](../extension) and
[`src/inbox/companion.ts`](../src/inbox/companion.ts).

## What is proven and what is not

**Nothing here has been run against Slack.** The build was not allowed to sign in to a
workspace, so every statement about Slack's web client below is an assumption taken from
public descriptions of it. The extension was tested against a made-up page that imitates
those assumptions. The spike (design 8.5) is how the assumptions are checked, in PatchOps
first, and no client workspace should be switched on before it passes.

Verified, in tests that run with `npm test`, against stand-ins for the browser and for
Slack:

- Pairing, revocation, the three routes and what they refuse.
- A workspace the reader reports starts switched off; nothing is kept for it.
- Both capture levels, edits and deletions, the owner's own messages without their words.
- One message seen by the app and by the companion, or by the companion and by mail, is
  one item.
- A captured message goes through triage and is posted to the hub like any other.
- The page script never reads a socket's address, a cookie or a page store, never sends on
  a socket, and passes on only the listed fields of two kinds of frame.
- Sign-out, a tab that does not answer and a closed tab are told apart and reported.

Verified in a real Chrome (version 156), with the extension loaded unpacked exactly as
shipped and a made-up site standing where `app.slack.com` would be
(`EXTENSION_E2E=1 npx vitest run test/extension-e2e.test.ts`; not part of `npm test`):

- Chrome accepts the manifest and runs the page script before the page opens its socket.
- A frame travels from the socket to Patcher's database through the real routes.
- The minute report arrives by itself after Chrome has stopped the idle background worker.
- A cookie and a token planted in the made-up page, its store and its socket address never
  reach Patcher, and the extension sends nothing to the made-up site.

Assumed about Slack, and unverified:

| Assumption | If it is wrong | Where the spike shows it |
| --- | --- | --- |
| The web client receives new messages over a WebSocket opened by the page itself, as JSON text frames with `type: "message"`, a channel, a sender, the text and Slack's timestamp | Nothing is captured | Extension page: "Sockets" and "Frames" stay at 0, or "Messages" stays at 0 while frames arrive |
| The socket is opened on the page's main thread, not inside a worker | Nothing is captured; the page script cannot follow a socket into a worker | "Workers started by the page" is above 0 and "Sockets" is 0 |
| Slack sends a `desktop_notification` frame for a message it would notify about, naming the channel and the message's timestamp, also when browser notifications are blocked | At the narrower level, messages that reach the owner only through `@here`, a keyword or a followed thread are not sent. Direct messages and mentions by name do not depend on it | "notifications" count stays at 0 after someone mentions `@here` |
| A tab's address shows its workspace as `/client/T…`, and a tab receives messages only for that workspace | Messages could be filed under the wrong workspace | "Workspace named inside message frames" lists another workspace than the tab's; see below |
| Names: the sidebar, the message list and the account button carry the attributes the content script looks for | Channels and senders show as IDs; the member ID has to be typed in | "Page: 0 channels" on the control page |
| A workspace that ends the session sends the tab to a sign-in page on `app.slack.com`, or away from it | A sign-out shows as "Tab not answering" or "No tab" instead, and the note goes to the errors channel, not the inbox | Spike test 3 |
| Chrome keeps a pinned tab on its keep-active list connected while minimised, asleep and on battery | Gaps | Spike test 2 |

## How it works

```
app.slack.com tab (reader profile)                  extension                         Patcher web
┌────────────────────────────────┐
│ Slack's page ── WebSocket      │
│   tap.js (page world)          │  two kinds of frame,
│   listens only; never reads    │  listed fields only
│   the address, a cookie or a   │ ───────────────▶ content.js + lib.js
│   store; never sends           │                  which workspace, which level,
└────────────────────────────────┘                  is it switched on
                                                    ───────────────▶ background.js ──▶ POST /ingest/slack
                                                                     queue, minute     POST /ingest/slack/heartbeat
                                                                     report            GET  /ingest/slack/config
                                                                                       Authorization: Bearer pdk_…
```

- **`tap.js`** runs in the page's own world at `document_start`. It replaces
  `window.WebSocket` with a pass-through that adds a `message` listener to each socket the
  page opens. The constructor's arguments are handed on without being looked at, because
  the address carries the session's credential. Of what arrives, a `message` frame and a
  `desktop_notification` frame are reduced to a fixed list of fields and handed to the
  content script; every other frame is counted by its type name and dropped.
- **`content.js`** and **`lib.js`** decide what leaves the tab. Nothing does until the
  extension is paired, the reader is switched on in Patcher, and the workspace the tab
  shows is switched on. Messages of a workspace that is off are not held, even in memory.
- **`background.js`** is the only part that makes a request, and only to the paired Patcher
  address, without cookies. It keeps unsent messages in the browser's session storage
  (memory, emptied when Chrome closes; at most 500), sends them, and reports every minute.
- **The options page** pairs the extension, shows each Slack tab and what it hears, and
  holds the readout the spike uses. It works unpaired: counts only, nothing sent.

The permissions are `storage`, `alarms` and the one site `https://app.slack.com/*`. There
is no `cookies`, `webRequest`, `scripting`, `tabs` or `debugger` permission.

### What is sent to Patcher

Per message: the workspace ID, the channel ID and kind, Slack's timestamp and thread
timestamp, the sender's member ID, the text, and where the page shows them the channel's
and the sender's names. Per minute: for each workspace whether its tab is open, how many
messages were heard and sent, and counts about the tab (sockets, frames by type name,
whether it is pinned, the notification permission). Never a cookie, a token, a socket
address, or anything the page sent.

Anything shaped like a Slack token (`xox?-…`) inside a message's text is replaced with
`[removed]` three times: in the page script, in the content script and again on the
server.

### Which workspace a message belongs to

A message is filed under the workspace the tab's address shows. The workspace named inside
a frame is not used, because a message from a shared channel names the other
organisation. One case cannot be told from inside the page without reading socket
addresses: a tab that receives messages for more than one workspace. The extension
therefore sends nothing from a tab while more than one of its sockets carries messages,
and counts it as "ambiguous". Whether one socket ever carries several workspaces is spike
test 4; until that is answered, use one tab per workspace.

### The two levels

- **Direct messages and mentions only** (the default): a direct message, a message that
  names the owner's member ID, and a message Slack itself raises a notification for. This
  last part is wider than the design's wording and is what makes `@here` and followed
  threads count; it depends on an unverified frame. Edits and deletions are applied only
  to what was sent. The server refuses anything else at this level, whatever the extension
  sends.
- **Every message the reader receives**: every message in every channel the tab receives,
  with edits and deletions.

At both levels the owner's own messages are sent without their text, so Patcher knows he
replied; at the narrower level only those in direct messages.

## On the server

- **Device keys.** `pdk_` and 32 characters, shown once on the Slack inbox screen; only a
  SHA-256 hash is stored. Revoking stops the reader at its next request, which is answered
  401; the extension then forgets its queue and its pairing.
- **Routes** on `web`, under `/ingest/slack`, all behind the key: `GET /config` (which
  workspaces to read and at what level), `POST /` (up to 100 items), `POST /heartbeat`.
  Other origins than an extension get no CORS headers. A request that fails names no
  reason beyond its status.
- **Discovery.** A workspace is created only from a minute report, never from a message,
  and switched off. A workspace already known from forwarded mail with the same address
  is joined to it and keeps the companion off until a person ticks it.
- **Capture** goes through `receiveCaptured`, the same function as the hub app's events
  and forwarded mail, so the filter, channel rules, bundles, triage, the digest and the
  approval loop are unchanged. The sources are `companion_notification` and
  `companion_page`.
- **Duplicates.** The app and the companion both give Slack's timestamp, so the same
  message is one row. Mail has no timestamp: a mail that arrives within two hours of a
  companion message in the same workspace with the same words is dropped.
- **Health.** Coverage per workspace and hour, state changes and silences are kept
  (30 and 90 days). `companion.watch` runs every five minutes:

  | What | Where it is said | When |
  | --- | --- | --- |
  | A workspace signed the reader out | Slack inbox channel, once | After two minutes |
  | A tab is closed or does not answer | Errors channel, once | After ten minutes, in working hours |
  | The reader has not reported | Errors channel, once | After the time in Settings (15 minutes), in working hours |
  | The tab is open and hears nothing while messages arrive by the app or by mail, or hears messages and sends none at the wider level | Errors channel, at most daily | Two hours of open time |

## What it cannot do

- Nothing is captured while Chrome is closed or the computer sleeps, and nothing is read
  afterwards. Forwarded mail is the only cover for those hours.
- At the narrower level there is no thread around a message. Mail cannot show a reply.
- The extension cannot see Chrome's keep-active list or whether the profile opens at
  login; the checklist says "Check yourself" for both.
- It is loaded unpacked. Chrome shows a developer-mode notice for such extensions and may
  ask about them at start; it does not update itself. A new version means replacing the
  folder and pressing reload on `chrome://extensions`.
- When Slack changes its web client, capture can stop without an error. The fourth row of
  the table above is the only alarm for that.

## Tests

```bash
npm test                                                   # server and extension, with stand-ins
EXTENSION_E2E=1 npx vitest run test/extension-e2e.test.ts  # the same in a real Chrome; needs Chrome, two minutes
```

The Chrome run starts the browser with every `slack.com` name pointed at a made-up site on
this machine and every other name unresolvable, so it cannot reach Slack.
