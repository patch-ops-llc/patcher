# Setup checklist

What has to exist outside this repository before Patcher works, in the order to do it.
Steps marked **Owner** need someone with admin rights in the PatchOps Slack workspace or the
Railway workspace. Nothing here asks for a secret to be pasted into chat, a commit or a pull
request: every value goes straight from the place that issues it into a Railway variable.

Until the Slack variables are set, both services start and stay healthy, and the parts that
need Slack say "not configured" (`/health`, the sign-in page, and the service logs, which
list the missing variable names).

## Where things stand

Sections 1 and 2 ("Generated") are done. The Railway project exists and is running:

- Project: <https://railway.com/project/7399369c-82fa-424d-b063-5feebf3460fd>
- Web address: <https://web-production-944a4680.up.railway.app>
  (health: <https://web-production-944a4680.up.railway.app/health>)
- `Postgres`, `web` and `worker` are deployed from the branch
  `cursor/phase-0-foundation-60d9`; migrations have run.
- Set: `DATABASE_URL`, `NODE_ENV`, `SESSION_SECRET`, `TOKEN_PUBLIC_KEY` on web;
  `DATABASE_URL`, `NODE_ENV`, `APP_BASE_URL`, `TOKEN_PRIVATE_KEY` on worker. The secrets
  were generated at setup and exist only in Railway.

Railway holds a deployment for approval when the commit's author is not someone the
workspace recognises (`NEEDS_APPROVAL`, reason `EXTERNAL_CONTRIBUTOR`). Commits pushed by
the Cursor agent are held this way. The first deployment was started by `railway config
apply` and went through; later pushes to the branch wait in **web → Deployments** and
**worker → Deployments** until someone with access to the project clicks **Approve**. The
deployment that is already running keeps serving in the meantime.

What is left is for the owner: section 3 (the Slack app and its six variables), section 4
(first run), section 5 (the weekly audit and its variables), section 6 (call transcripts),
section 7 (sales calls, proposals and the deal room, with three more variables), section 8
(the Slack reader: an update to the Slack app, one authorisation, and one more variable if
forwarded email is wanted), and the last item of section 9 after the pull request is merged. Sections 1 and 2 are kept as the record of how the project
is built, should it ever be rebuilt.

## 1. Railway project

One project named **Patcher**, one environment (`production`), three things in it:

| Resource | Kind | Public address | Start command |
| --- | --- | --- | --- |
| `Postgres` | Railway Postgres | none | (managed) |
| `web` | Service from this repository | yes, a Railway domain or a custom one | `node dist/web.js` |
| `worker` | Service from this repository | **none** | `node dist/worker.js` |

Both services use the same settings apart from the start command:

| Setting | Value |
| --- | --- |
| Builder | Railway default (Railpack) |
| Build command | `npm run build` |
| Pre-deploy command | `npm run migrate` |
| Health check path | `/health` |
| Health check timeout | 120 seconds |
| Restart policy | On failure, 10 retries (Railway's default) |
| Source | `patch-ops-llc/patcher`, branch `main` once the first pull request is merged |

These settings are written down in [`.railway/railway.ts`](../.railway/railway.ts). To apply
them from a checkout:

```bash
npm ci
railway login
railway link            # choose the Patcher project and the production environment
export PATCHER_DEPLOY_BRANCH=cursor/phase-0-foundation-60d9   # only until the PR is merged
railway config plan     # shows what would change; changes nothing
railway config apply    # applies after you confirm
```

`railway.json` is not used. Railway has deprecated it: new services cannot use it and
existing files stop being read on 2026-12-01. `.railway/railway.ts` is its replacement. It
describes the whole project, so a service or variable removed from that file is deleted on
the next apply; a variable set in the dashboard must also be listed in the file (as
`preserve()`) to survive an apply.

The web service's public domain is generated in the dashboard (**web → Settings →
Networking → Generate Domain**) or with `railway domain --service web`. The worker must not
have one.

## 2. Variables

Set on the service named in the "Service" column (**service → Variables**). `web` must never
hold `TOKEN_PRIVATE_KEY`.

### Generated, no owner input needed

| Variable | Service | Value |
| --- | --- | --- |
| `DATABASE_URL` | web, worker | Reference: `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | web, worker | `production` |
| `SESSION_SECRET` | web | 32 or more random characters, for example `openssl rand -hex 32` |
| `APP_BASE_URL` | worker | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`, or the custom domain if there is one |
| `TOKEN_PUBLIC_KEY` | web | Public half of the token key pair (below) |
| `TOKEN_PRIVATE_KEY` | worker | Private half of the token key pair (below) |

`web` works out its own address from `RAILWAY_PUBLIC_DOMAIN`, which Railway sets. Set
`APP_BASE_URL` on `web` as well only when it is served from a custom domain.

The token key pair protects the Calendly and Fathom keys typed into **Settings → Calls**
(section 6) and the tokens later phases store (design section 12.3): the public service can
encrypt with the public key and cannot decrypt. Without the pair a call source cannot be
connected. Replacing the pair makes the stored keys unreadable; each source then has to be
removed and connected again. To make a new pair, run this where the output is not logged and paste each
line into its variable:

```bash
node -e "import('./dist/security/sealed.js').then(m => { const k = m.generateTokenKeyPair(); console.log('TOKEN_PUBLIC_KEY=' + k.publicKey); console.log('TOKEN_PRIVATE_KEY=' + k.privateKey); })"
```

### Owner: from the Slack app (step 3)

| Variable | Service | Where the value comes from |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | web | Slack app → **Basic Information** → App Credentials → Signing Secret |
| `SLACK_CLIENT_ID` | web | Slack app → **Basic Information** → App Credentials → Client ID |
| `SLACK_CLIENT_SECRET` | web | Slack app → **Basic Information** → App Credentials → Client Secret |
| `SLACK_BOT_TOKEN` | web, worker | Slack app → **OAuth & Permissions** → Bot User OAuth Token (starts `xoxb-`), shown after the app is installed |
| `SLACK_TEAM_ID` | web, worker | The PatchOps workspace ID (starts `T`). In Slack on the web the address is `https://app.slack.com/client/T…/…`; the `T…` part is the ID |
| `BOOTSTRAP_OWNER_SLACK_USER_ID` | web | Your own Slack member ID (starts `U`): your profile → **⋮** → Copy member ID |

`SLACK_TEAM_ID` is what restricts everything to PatchOps: requests, clicks and sign-ins from
any other workspace are refused. `BOOTSTRAP_OWNER_SLACK_USER_ID` makes that one person an
owner the first time they sign in; every other person is added in **Settings → People**.

### Owner: for the weekly audit (step 5)

All on **worker only**. `web` must never hold any of them.

| Variable | Needed for | Where the value comes from |
| --- | --- | --- |
| `RAILWAY_API_TOKEN` | The audit itself, the inventory and the probes | Railway → **Account Settings → Tokens** (<https://railway.com/account/tokens>) → choose the PatchOps workspace in the dropdown → **Create** |
| `CURSOR_API_KEY` | "Fix via agent", and approved code changes from calls | Cursor Dashboard → **API Keys**, or a service account API key |
| `CURSOR_AGENT_MODEL` | Optional: the model the agent uses | A model ID from Cursor's `GET /v1/models`. Unset: the account's default |
| `GITHUB_APP_ID` | "Production behind the default branch" and "critical dependency alerts" | The GitHub App's settings page → **About** → App ID |
| `GITHUB_APP_PRIVATE_KEY` | Same | The GitHub App's settings page → **Private keys** → **Generate a private key**; paste the whole `.pem` file's contents |
| `GITHUB_APP_INSTALLATION_ID` | Same | After installing the app: the number at the end of the installation's address, `https://github.com/organizations/<org>/settings/installations/<number>` |
| `ANTHROPIC_API_KEY` | The model that assesses findings, ranks the report and drafts fix briefs; the one that matches calls and drafts their suggestions; and the one that finds sales calls and drafts proposals | Claude Console (<https://platform.claude.com>) → **API keys** → **Create key** |

Each of the four is independent. Without Railway nothing is audited; without Cursor the
report has no "Fix via agent" buttons; without GitHub two checks are listed as not run;
without Anthropic the rules rank and word the report, and its second line says
"ranked by rules (AI not configured)".

### Owner: for the Penguin deal room (step 7)

All on **worker only**. `web` must never hold any of them. They belong to a second GitHub
App, made for the deal room alone; do not reuse the read-only app's values.

| Variable | Where the value comes from |
| --- | --- |
| `DEALROOM_GITHUB_APP_ID` | The deal room GitHub App's settings page → **About** → App ID |
| `DEALROOM_GITHUB_APP_PRIVATE_KEY` | The same page → **Private keys** → **Generate a private key**; paste the whole `.pem` file's contents |
| `DEALROOM_GITHUB_APP_INSTALLATION_ID` | After installing the app on the deal room repository: the number at the end of the installation's address |

Without them sales calls are still found and proposals drafted, approved and rendered as
PDF. Approving a Penguin deal's proposal then fails with "the deal room GitHub App is not
configured" and a Retry button; nothing is lost.

### Owner: for the Slack reader (step 8)

| Variable | Service | Where the value comes from |
| --- | --- | --- |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | web | A password you make up, 24 characters or more, for example `openssl rand -hex 32`. The inbound-mail service sends it with every delivery (section 8, part D). Needed only for forwarded email |

Reading PatchOps needs no new variable. It uses `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
`SLACK_TEAM_ID` and the token key pair, which are already set. The authorisation it stores
is granted from the **Slack inbox** screen and kept encrypted in the database.

### Optional

| Variable | Service | Purpose |
| --- | --- | --- |
| `DRY_RUN` | worker | `1` logs approved actions instead of executing them, whatever the UI switch says |
| `LOG_LEVEL` | web, worker | `debug`, `info` (default), `warn`, `error` |

`SLACK_API_URL`, `SLACK_OIDC_URL`, `RAILWAY_API_URL`, `CURSOR_API_URL`, `GITHUB_API_URL`,
`ANTHROPIC_API_URL`, `CALENDLY_API_URL`, `FATHOM_API_URL` and `DEALROOM_GITHUB_API_URL` are for local development only
and are refused when `NODE_ENV=production`.

Calendly and Fathom have no variables. Their keys are typed into **Settings → Calls**
(section 6) and stored encrypted in the database.

## 3. Owner: the Slack app

1. Open [`slack/manifest.yaml`](../slack/manifest.yaml). Its five URLs already point at
   `https://web-production-944a4680.up.railway.app`; change them only if the web address
   has changed.
2. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest** → choose the
   **PatchOps** workspace → paste the manifest → **Create**.
3. Copy the Signing Secret, Client ID and Client Secret from **Basic Information** into the
   Railway variables in the table above.
4. **Install App** → **Install to PatchOps** → allow. Copy the Bot User OAuth Token from
   **OAuth & Permissions** into `SLACK_BOT_TOKEN` on both services.
5. Set `SLACK_TEAM_ID` on both services and `BOOTSTRAP_OWNER_SLACK_USER_ID` on web.
6. Let Railway redeploy both services (it does so when variables change). Check
   `https://<web address>/health`: `features.slackRequests`, `slackModals` and `signIn`
   should all be `true`.
7. Back in the Slack app, open **Event Subscriptions**. If the Request URL shows as
   unverified, click **Retry**; it verifies once the signing secret is set on web.

The URLs the Slack app must contain (the manifest sets all five):

| Where in the Slack app | URL |
| --- | --- |
| OAuth & Permissions → Redirect URLs | `https://web-production-944a4680.up.railway.app/auth/slack/callback` |
| OAuth & Permissions → Redirect URLs | `https://web-production-944a4680.up.railway.app/auth/slack/reader/callback` (the Slack reader, section 8) |
| Event Subscriptions → Request URL | `https://web-production-944a4680.up.railway.app/slack/events` |
| Interactivity & Shortcuts → Request URL | `https://web-production-944a4680.up.railway.app/slack/interactions` |
| Slash Commands → `/ops` → Request URL | `https://web-production-944a4680.up.railway.app/slack/commands` |

If the web address changes later (a custom domain, for example), change all five and
`APP_BASE_URL`.

If the app was created from the manifest before the Slack reader was added, it lacks the
second redirect URL, the user scopes and the message events. Section 8, part A, adds them.

## 4. Owner: first run

1. In Slack, create or choose the channels the bot should post to (the design suggests
   `#ops-calls`, `#ops-sales`, `#ops-audit`, `#ops-inbox`, `#ops-log`) and invite the bot to
   each: `/invite @Patcher`. The bot can post only where it has been invited.
2. Open the web address and **Sign in with Slack** as the bootstrap owner.
3. **Settings → Slack routing → Refresh channel list**, then choose a channel for each
   report type. "Bot errors" is where the bot reports its own failures.
4. **Settings → People**: add each approver by Slack member ID.
5. Milestone check: next to a routed report type, click **Send test**. A two-line message
   with Approve, Edit, Dismiss and Details appears in that channel within a few seconds.
   Approve it in Slack, or on the **Approvals** page. The message becomes one line and the
   decision appears under **Activity**.

## 5. Owner: the weekly audit

The audit is built to read Railway and nothing else: every request it can send is one of the
fixed queries in [`src/railway/queries.ts`](../src/railway/queries.ts), none of which changes
anything or returns a variable's value. Railway's own tokens have no read-only kind, though:
a workspace token can do anything in the workspace. So the token goes only into the worker's
`RAILWAY_API_TOKEN` variable, and nowhere else.

1. **Railway token.** Create a workspace token for the PatchOps workspace and set it as
   `RAILWAY_API_TOKEN` on `worker`. Use a token made for Patcher alone, so it can be revoked
   without affecting anything else.
2. **Channel.** In **Settings → Slack routing**, choose the channel for **Audit** and invite
   the bot to it. Without a channel the report waits and the **Audits** screen says so.
3. **First audit.** Open **Audits → Run audit now**, or type `/ops audit now` in Slack. It
   takes a minute or two. The first run also fills the Railway inventory, which the probes
   and the registry import need. After that it runs every Monday at 08:00 Central
   (**Settings → Schedules** changes or disables it), and services are probed every five
   minutes.
4. **Registry.** Open **Projects**. Under "Railway projects not in the registry", import the
   projects Patcher should be allowed to propose fixes for. Importing links each project to
   the repositories its services deploy from. This list is the permission: an agent is never
   started on a repository that is not linked to an active project here.
5. **Cursor key** (for "Fix via agent"). Create the key and set `CURSOR_API_KEY` on `worker`.
   A service account key limited to the repositories in the registry is the narrowest
   choice. Cursor's GitHub integration must have access to those repositories, or the agent
   cannot open a pull request. Agents work on their own branch and open a pull request;
   Patcher never merges one.
6. **GitHub App** (for the two GitHub checks). In the GitHub organisation: **Settings →
   Developer settings → GitHub Apps → New GitHub App**. No webhook, no user authorisation.
   Repository permissions, all **Read-only**: **Metadata**, **Contents**, **Dependabot
   alerts**. No other permission. Create it, generate a private key, install it on the
   repositories in the registry, and set the three `GITHUB_APP_*` variables on `worker`.
   Repositories outside that organisation need the app installed there too, or their two
   checks stay "not run".
7. **Anthropic key** (for the model steps). Create an API key and set `ANTHROPIC_API_KEY` on
   `worker`. A key in a Console workspace made for Patcher, with a spend limit, is the
   narrowest choice. With the key set, each audit sends Anthropic, per service that has a
   finding above informational: the service's facts as the collectors read them (names,
   deployment states, counts), its findings, and its error-log patterns after redaction and
   up to a token cap. Variable names and values are never sent. Without the key nothing is
   sent and the rules rank the report.
   **Settings → AI** has the switch, the model per step, the daily and monthly budget (both
   start unset), the log cap and how long to wait for the model. It also shows what has
   been spent and every call by task, model and prompt version.
8. Check `https://<web address>/health`: `integrations.railway`, `cursor`, `github` and
   `anthropic` show `configured: true` once the worker has restarted with the variables. The
   **Audits** screen shows the same, with the time each one last answered.

Things to know:

- With a model, an audit has two stages. The checks run and their findings appear under
  **Audits** within a minute or two. The per-service requests go to Anthropic as one batch
  (half price), which usually comes back within the hour; the report is posted to Slack
  when it does. If it has not come back after the time set in **Settings → AI** (two hours
  to start with), the report goes out with the rules' wording.
- Muting or accepting a finding (on its page) keeps it out of the report until it is
  reopened. Both record who and why.
- **Settings → Switches → Dry run** applies here too: an approved fix is logged and no agent
  is started.
- Project-specific checks (a URL, an expected status and optionally expected JSON) are added
  on a project's page and probed with the rest.

## 6. Owner: call transcripts

No new Railway variable is needed. Calls use what sections 2 and 5 already set: the token
key pair, `APP_BASE_URL` on the worker, `ANTHROPIC_API_KEY`, and for code changes
`CURSOR_API_KEY` and the GitHub App. The Calendly token and the Fathom keys are typed into
Patcher itself, never into a variable, a chat or a commit.

Before you start, check:

- `TOKEN_PUBLIC_KEY` is set on `web` and `TOKEN_PRIVATE_KEY` on `worker` (both were
  generated at setup). `/health` shows `features.tokenEncryption: true`; if the pair is
  missing, **Settings → Calls** says so instead of offering the connect form.
- `APP_BASE_URL` on `worker` is the public `https` address of `web`. It is where the
  webhooks are registered. If it is not a public `https` address, the sources still work,
  by poll only, up to 15 minutes late.
- `ANTHROPIC_API_KEY` is set on `worker`. Without it calls are collected and wait
  unanalysed; they are picked up by themselves once the key is there.

Then:

1. **Channel.** Create or choose the calls channel (the design suggests `#ops-calls`),
   invite the bot (`/invite @Patcher`), and choose it for **Calls** in **Settings → Slack
   routing**. Choose a channel for **Bot errors** too if there is none yet: a key that stops
   working is reported there. Without a calls channel the suggestions wait, and the call's
   page says so.
2. **Your own domains.** In **Settings → Calls**, fill in "Your own email domains" (for
   example the PatchOps domain). Attendees from these never count as a client.
3. **Registry.** On each project in **Projects**, fill in what matching reads: the client,
   the client's e-mail domains, the names the project goes by (aliases), a one-line
   description, contacts, and the linked repositories. A call is matched only to an active
   project, and a code change is offered only on a repository linked to the matched
   project. Correcting a match on a call's page offers to save the attendee's domain or a
   name on the project.
4. **Calendly.** In Calendly: **Integrations & apps → API and webhooks**
   (<https://calendly.com/integrations/api_webhooks>) → generate a personal access token
   with the scopes `meeting_recaps:read`, `users:read` and
   `webhooks:write`. The Calendly plan must include Notetaker. In Patcher: **Settings →
   Calls → Sources**, choose "Calendly (personal access token)", type whose it is, paste
   the token, **Connect**. There is one Calendly connection.
5. **Fathom.** In Fathom: your user **Settings → API Access → Generate API Key**. A Fathom key is one
   person's and sees what that person can see. Choose one or both:
   - *One key for the team.* A Fathom admin who can view all calls shared with the team
     makes the key; connect it as "Fathom, one key for the team". It covers every call a
     teammate shares with the team and none they keep private. Receiving teammates' calls
     by webhook needs the Fathom Team plan; on another plan Patcher registers a webhook for
     the key owner's own recordings, says so under **Webhook**, and finds the rest by poll.
   - *A key per teammate.* Each teammate makes their own key; an owner connects each as
     "Fathom, a teammate's own key". This also covers that person's private calls.
6. **Webhooks need no step of yours.** When a key is connected the worker checks it and
   registers the webhook at the vendor, with a signing secret, at
   `https://<web address>/webhooks/<source>/<a random token per connection>`. Nothing has
   to be created in Calendly's or Fathom's settings. Reload **Settings → Calls** after a
   few seconds: the source shows **Connected**, and **Registered** or **Poll only** with
   the reason. "Earlier calls, days" at connect time (up to 14) also collects calls from
   before the connection.
7. **GitHub App permission.** The suggestions read each linked repository's README and the
   titles of its open pull requests. Add **Pull requests: Read-only** to the GitHub App
   from section 5 (the app's settings → **Permissions & events**), then accept the new
   permission on the installation. Without it suggestions are still drafted, without the
   pull request titles.
8. **Check.** `https://<web address>/health` lists `callSources` with how many connections
   each source has and when it last answered. Hold a short test call, or use **Calls → Add
   a transcript** with a few made-up lines. The call appears under **Calls** at once and is
   analysed after the settle time (ten minutes to start with; **Settings → Calls** changes
   it). A matched call that asked for something appears in the calls channel as one
   message with **Approve all**, **Pick**, **Wrong project** and **Details**.

What is sent where, once this is on:

- **To Anthropic**, per call: the transcript after redaction, up to a token cap; attendee
  names and e-mail domains, not addresses; the registry's project cards (name, client,
  aliases, description, repository names); for a matched project, the start of each linked
  repository's README, its open pull request titles and the titles of earlier suggestions
  for that project. Never a key.
- **To Cursor**, only after an approval: the brief shown on the approval page, which
  includes the words quoted from the call.
- **To Slack**: suggestion titles and, under **Details**, the quoted words. Never the
  transcript, and no e-mail address.

Things to know:

- **Settings → Calls** has the switch for calls, the switch for the model, the confidence
  thresholds (0.80 to match without asking, 0.50 to ask), the most suggestions per call,
  the retention time for transcript text (180 days to start with), and a daily and monthly
  budget for the model (both start unset).
- A call the model is unsure about is asked in the calls channel with the closest projects
  as buttons. A call it cannot place is under **Calls → Unmatched** and is not posted.
- When a recording is deleted in Calendly or Fathom, Patcher deletes its copy. Fathom sends
  no notice of a deletion, so a recording deleted there stays in Patcher until its
  retention time; Calendly's deletion webhook is acted on at once.
- Removing a source deletes its webhook at the vendor and erases its key. Calls already
  collected stay.
- Pause and **Dry run** apply here as everywhere. While paused the poll does not run, the
  model is not asked and nothing is posted or run; a webhook that arrives is still stored,
  and its call waits until Patcher is resumed. In a dry run an approved change is logged
  and no agent is started.

## 7. Owner: sales calls, proposals and the Penguin deal room

Sales calls are found among the calls section 6 collects, so that section comes first.
Steps 1 to 4 need no new variable. Steps 5 to 7 are for the deal room only.

1. **Channel.** Create or choose the sales channel (the design suggests `#ops-sales`),
   invite the bot, and choose it for **Sales** in **Settings → Slack routing**. Without a
   channel a drafted proposal waits, and the **Sales** screen says so with "Post to Slack
   now".
2. **Penguin addresses.** In **Settings → Sales**, fill in "Your Penguin email addresses":
   every address you take Penguin calls with, comma separated. A sales call with one of
   them as its host or among its invitees is a Penguin deal. The addresses stay in
   Patcher's database; they are not sent to a model or shown in Slack. A person can mark a
   deal Penguin or not Penguin, in Slack or on the deal's page, and that mark wins over the
   rule.
3. **Rate card.** Open **Sales → Template and rate card**. Add each service you sell: a key,
   a name, what it is, the unit and the price. The currency is in **Settings → Sales** (USD
   to start with). The model never writes a price: the Investment section of a proposal is
   built from this list, and a service without a price is shown as "TBD" and listed as a
   gap. With an empty list every proposal says "Pricing: TBD" and lists "rate card" as a gap.
4. **Template.** On the same screen, read the proposal template and change it to your own
   sections. It starts with a general one (summary, your situation, proposed approach, scope,
   timeline, assumptions, next steps). Leave out pricing: the Investment section is added
   by Patcher from the rate card.
5. **Deal room GitHub App.** In the organisation that owns the deal room repository:
   **Settings → Developer settings → GitHub Apps → New GitHub App**. No webhook, no user
   authorisation. Repository permissions: **Contents: Read and write**, **Pull requests:
   Read and write**, **Metadata: Read-only**. No other permission. Create it, generate a
   private key, and install it on **only** the deal room repository
   (`patch-ops-llc/penguin-dealroom`). Set the three `DEALROOM_GITHUB_APP_*` variables on
   `worker`. This is a different app from the read-only one in section 5: that one stays
   read-only, and this one can reach one repository.
6. **Protect `main` on the deal room repository.** In the repository: **Settings → Branches**
   (or **Rules → Rulesets**) → require a pull request before merging on `main`, and do not
   add the app to any bypass list. Patcher's client can only create a `patcher/…` branch and
   open a pull request, and has no merge request in its code; this rule makes GitHub refuse
   a push to `main` as well, whatever the code does. Merging the pull request redeploys the
   app, and the content is then live to everyone who can open the room.
7. **Check.** `https://<web address>/health` shows `integrations.dealroom` with
   `configured: true` once the worker has restarted. **Settings → Sales** shows the same and
   the repository name ("Repository of the Penguin deal room"; change it only if the
   repository is renamed).

What happens then:

- A call the model is sure was a sales call (0.80 and above) gets a proposal draft by
  itself. One it is unsure about (0.50 to 0.80) is asked in the sales channel, "Sales
  call?", with **Yes, draft proposal** and **No**. Any call can be marked a sales call, or
  not one, on its page under **Calls**.
- The drafted proposal arrives as one message: **Review** (read and edit the text),
  **Approve**, **Regenerate** (with a note for the model), **Not a deal**. The same is on
  **Sales** and on the proposal's page. Approving makes that version final and links its
  PDF from the message, for a person to send. Patcher sends nothing to a prospect.
- For a Penguin deal the message first asks for the room: create the deal in the deal
  room's `/admin`, with no client domains yet, then click **Enter slug** and type its slug.
  **Skip** treats the proposal like any other. With the slug set, **Approve** opens a pull
  request on the deal room repository with the proposal as `content/<slug>/proposal/…`
  files, and the message becomes **Review PR**. The pull request lists what is left to do
  by hand: the deal facts in Deal Admin, any edit made in the app that hides a file, and
  the visuals, which Patcher does not write.
- Every 30 minutes Patcher reads whether its open deal room pull requests were merged or
  closed, and the message says so. **Settings → Schedules** has it as `dealroom.sync`.
- A pasted transcript (**Calls → Add a transcript**) carries no addresses, so the Penguin
  rule cannot be tested; the message asks **Yes, Penguin** or **Not Penguin**.

What is sent where, once this is on:

- **To Anthropic**, per sales call: the transcript after redaction, attendee names and
  e-mail domains (not addresses), the call's title; then the brief drawn from it, your
  template, and the catalog's names, descriptions and units. Never a price, an address or
  a key.
- **To GitHub**, only after an approval of a Penguin deal with a slug: the approved
  proposal's text, as files in a pull request on the deal room repository.
- **To Slack**: the prospect's company, the first contact's first name, the proposal's
  one-line summary and its gaps. Never the transcript, the proposal's text or a price.

Things to know:

- **Settings → Sales** has the switch for sales calls, the switch for its model, the two
  confidence thresholds, the model per step, the title words that hint at a sales call, and
  a daily and monthly budget (both start unset).
- Pause and **Dry run** apply here too. In a dry run an approved proposal is logged and
  neither made final nor sent to the deal room.
- A second call with the same prospect joins the same deal and its draft is the next
  version of the proposal. The versions are on the deal's page.
- A proposal that expires without a decision is not lost: **Regenerate** or **Review**
  on the message, or the deal's page, offers it again.

## 8. Owner: the Slack reader

Patcher reads new messages in PatchOps that you can see, sorts them, and posts what needs
you in the Slack inbox channel: something urgent as its own short message, the rest as a
digest. For other workspaces it reads the notification mail Slack sends you, once you
forward it. It posts nothing as you and holds no permission that could.

Parts A to C are for PatchOps. Part D, forwarded email, is separate and optional. Sections
3 and 4 come first, and `ANTHROPIC_API_KEY` on `worker` (section 5): without it messages
are collected, only the ones addressed to you are listed, and they are marked "not
analysed".

### A. Update the Slack app

The reader added to [`slack/manifest.yaml`](../slack/manifest.yaml): a second redirect URL,
ten read-only user scopes, four message events delivered for the person who grants them,
and the `tokens_revoked` event. The bot's own scopes did not change.

1. <https://api.slack.com/apps> → **Patcher** → **App Manifest**. Replace the manifest with
   the file's contents and **Save Changes**. If you would rather not replace it, make the
   same changes by hand:

   | Where in the Slack app | Add |
   | --- | --- |
   | OAuth & Permissions → Redirect URLs | `https://web-production-944a4680.up.railway.app/auth/slack/reader/callback` |
   | OAuth & Permissions → User Token Scopes | `channels:history`, `groups:history`, `mpim:history`, `im:history`, `channels:read`, `groups:read`, `mpim:read`, `im:read`, `users:read`, `team:read` |
   | Event Subscriptions → Subscribe to events on behalf of users | `message.channels`, `message.groups`, `message.mpim`, `message.im` |
   | Event Subscriptions → Subscribe to bot events | `tokens_revoked` |

2. If Slack then shows a banner asking you to reinstall the app, reinstall it to PatchOps.
   Afterwards compare **OAuth & Permissions → Bot User OAuth Token** with what you set
   before; if it changed, update `SLACK_BOT_TOKEN` on both services.
3. **Event Subscriptions** should still show the Request URL as verified.

None of the user scopes can post, edit, delete, join a channel or change a setting.
`chat:write` for a user is deliberately not there: "Send reply" is a later phase.

### B. Channel

Create or choose the channel (the design suggests `#ops-inbox`), `/invite @Patcher`, and
choose it for **Slack inbox** in **Settings → Slack routing**. Patcher never reads the
channels it posts to, whatever else is switched on.

### C. Switch on and connect

1. **Settings → Slack inbox**: tick **Read Slack messages** and save. It is off until you
   do; while it is off every message event is acknowledged and dropped, and nothing is
   stored. The same card has the quiet hours and their time zone, the settle time, the
   retention, the two models and the budgets (5 US dollars a day and 60 a month to begin
   with).
2. **Slack inbox → Connect PatchOps**. You must be signed in to Patcher as an owner, and
   it is your own messages that will be read: Slack shows its consent screen with the read
   permissions; allow it. Patcher refuses, and hands back, an authorisation that is for
   another workspace, for a different person than the one signed in, or without
   permission to read messages.
3. The workspace shows as **Connected**. Messages from that moment on are read. Nothing
   from before is read unless you ask: **Catch up** reads up to the last 72 hours.
4. Milestone check: have a teammate send you a direct message with a question. After the
   settle time (3 minutes) it appears in the Slack inbox channel, or on **Slack inbox →
   Post a digest now**. The digest also posts by itself at 9:00, 13:00 and 17:00 on
   weekdays, Chicago time (**Settings → Schedules**, `slack.digest`).

On the **Slack inbox** screen, per workspace: on or off, whether direct messages are read,
whether channels without a rule are read or left out, and a project. Channel rules are
**Read**, **Leave out**, **Digest only** and **Always urgent**, by channel ID or name.
Switching a workspace off deletes the messages stored for it, closes its open items and
hands the authorisation back to Slack; reading it again means **Connect** again.

### D. Forwarded email, for other workspaces

Slack mails you about direct messages and mentions you have not seen. A rule in your
mailbox forwards those mails to a private address at an inbound-mail service, and the
service posts them to Patcher. Nothing is installed in the other workspace. Patcher is
written for Postmark's inbound webhook; another service needs a small adapter.

1. **Mail service.** In Postmark, create a server and open its **Inbound** stream. Note
   the stream's inbound address (`…@inbound.postmarkapp.com`).
2. **Password.** Make one up (`openssl rand -hex 32`) and set it as
   `INBOUND_EMAIL_WEBHOOK_SECRET` on `web`. In the inbound stream's settings, set the
   webhook URL to
   `https://patcher:<that password>@web-production-944a4680.up.railway.app/ingest/email`.
   The user name can be anything. `/health` then shows `features.inboundEmail: true`.
3. **Settings → Slack inbox**: paste the stream's inbound address into **Inbound address
   of the mail service** and save.
4. **Slack inbox → Forwarded email → Issue a forwarding address.** The address is shown
   once: it is the inbound address with a secret part after a `+`. Copy it. Patcher keeps
   only a hash of the secret part; issuing another withdraws this one.
5. **Mail rule.** In the mailbox that receives Slack's notification mail, forward mail
   from `@slack.com` to that address, automatically. It has to be a rule: a mail you
   forward by hand names you as the sender and is not read. If your mail provider first
   sends a confirmation to the new address (Gmail does), its subject is listed under
   **Forwarded email** on the Slack inbox screen for a week, marked "Not from Slack, not
   read"; the body is not kept, so use a code from the subject, not a link.
6. **In each other workspace**: **Preferences → Notifications**, and turn on email
   notifications for when you are not active.
7. The first mail about a workspace adds it to the **Slack inbox** screen, switched off.
   Switch it on there; mail about it is read from then on. You can also add it ahead of
   time by its address (`acme.slack.com`).

What email can and cannot do: it carries direct messages and mentions only, in batches,
some minutes late, without the thread around them, and it cannot show that you have
replied since. Mail about a workspace that is read through the app is ignored, so
PatchOps is not read twice.

### What is sent where

- **To Anthropic**, per conversation that passed the filter: its messages after redaction,
  with the thread before them where the app can read it; display names, the channel name
  and the workspace name; the names of the projects that workspace may be matched to; and
  Patcher's own one-line summaries of recent items from the same workspace with how each
  was decided. Content from one workspace is never in a prompt about another. Never a
  token.
- **To Slack (PatchOps)**: Patcher's one-line summary, the suggestion, and who wrote where.
  The draft reply is shown in a dialog to the person who opens it, to copy; Patcher sends
  nothing. The words quoted as
  evidence are posted only when someone asks for **Details**.
- **Kept**: message text for 14 days (**Settings → Slack inbox**), then removed along with
  the draft and the quoted words; the link, the IDs and Patcher's summary stay. An edit or
  a deletion in PatchOps is applied to the stored copy. No search index is built.

Things to know:

- Joins and other system messages, bots and channels left out by a rule are dropped by
  code before anything is stored. The **Slack inbox** screen counts what was dropped and
  why, per day; it does not keep the messages. Of your own messages only the time and
  place are kept, without the text, so that Patcher knows you have replied.
- Each item offers **Task** (a task in Patcher, on the matched project or on none),
  **Agent** when the message asks for a code change in a project with exactly one linked
  repository (the same Cursor flow as a call suggestion, behind the same approval), **Copy
  draft** with **Open in Slack**, and **Dismiss**, which asks why in one tap.
- An item is closed by itself when you reply in that conversation before deciding.
- During quiet hours only an escalation, or a channel marked **Always urgent**, is posted
  at once. Everything else waits for the digest.
- Pause and **Dry run** apply here too.
- If Slack stops accepting the authorisation, reading stops, the errors channel says so
  once, and the screen offers **Connect** again. A reconnect catches up from the last
  event Slack delivered, up to 72 hours back.

## 9. Later, not needed for the foundation

- An external uptime monitor on `https://<web address>/health` (design section 13.1).
- Railway: restrict who can view the project's variables; turn on two-factor
  authentication for everyone with access.
- After the first pull request is merged, point both services at `main`: in each of `web`
  and `worker`, **Settings → Source → Branch** → `main`. Or, from a checkout of `main`,
  `railway config apply` with `PATCHER_DEPLOY_BRANCH` unset. Until then both services
  deploy every push to `cursor/phase-0-foundation-60d9`. If that branch is deleted on
  merge before the switch, the running services keep running; they just stop getting new
  deploys until the branch is changed.
- Railway default: restart on failure, 10 retries. It is in effect and is not written in
  `.railway/railway.ts`, because stating a default there makes every plan report a change.
