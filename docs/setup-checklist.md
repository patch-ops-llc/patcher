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
(first run), and the last item of section 5 after the pull request is merged. Sections 1
and 2 are kept as the record of how the project is built, should it ever be rebuilt.

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

The token key pair is not used by anything in the foundation. It is for the tokens later
phases store (design section 12.3): the public service can encrypt with the public key and
cannot decrypt. To make a new pair, run this where the output is not logged and paste each
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

### Optional

| Variable | Service | Purpose |
| --- | --- | --- |
| `DRY_RUN` | worker | `1` logs approved actions instead of executing them, whatever the UI switch says |
| `LOG_LEVEL` | web, worker | `debug`, `info` (default), `warn`, `error` |

`SLACK_API_URL` and `SLACK_OIDC_URL` are for local development only and are refused when
`NODE_ENV=production`.

## 3. Owner: the Slack app

1. Open [`slack/manifest.yaml`](../slack/manifest.yaml). Its four URLs already point at
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

The URLs the Slack app must contain (the manifest sets all four):

| Where in the Slack app | URL |
| --- | --- |
| OAuth & Permissions → Redirect URLs | `https://web-production-944a4680.up.railway.app/auth/slack/callback` |
| Event Subscriptions → Request URL | `https://web-production-944a4680.up.railway.app/slack/events` |
| Interactivity & Shortcuts → Request URL | `https://web-production-944a4680.up.railway.app/slack/interactions` |
| Slash Commands → `/ops` → Request URL | `https://web-production-944a4680.up.railway.app/slack/commands` |

If the web address changes later (a custom domain, for example), change all four and
`APP_BASE_URL`.

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

## 5. Later, not needed for the foundation

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
