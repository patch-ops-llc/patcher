# Patcher

The PatchOps operations bot. It watches PatchOps' work, posts short recommendations in the
PatchOps Slack workspace, and acts only after a person on the approver list approves the
exact action shown.

This repository holds two phases:

- **Phase 0, the foundation**: the two services, the database, the job queue and scheduler,
  the Slack hub app, the control UI, settings, the audit log, the pause switch, and the
  recommendation and approval loop end to end.
- **Phase 1, the weekly audit**: a read-only inventory of the Railway workspace, collectors
  and probes, findings that keep their identity from week to week, one ranked report in
  Slack, a registry that links Railway projects to repositories, and "Fix via agent", which
  starts a Cursor agent on a linked repository after a person approves.

- Setting it up: [`docs/setup-checklist.md`](docs/setup-checklist.md)
- Slack app: [`slack/manifest.yaml`](slack/manifest.yaml)
- Railway project: [`.railway/railway.ts`](.railway/railway.ts)
- Variables, names only: [`.env.example`](.env.example)

## How it fits together

```
Slack (PatchOps) ──HTTPS──▶ web  (public)   verify ▸ record or decide ▸ enqueue ▸ acknowledge
browser ─────────HTTPS──▶                   control UI, Sign in with Slack, /health
                              │
                              ▼
                           Postgres         data, job queue (pg-boss), schedules, audit log
                              ▲
                              │
                           worker (private) job consumers, scheduler, every call to Slack
```

- **web** does no slow work. A Slack request is verified by signature, checked against the
  PatchOps workspace ID, written down or decided in one short transaction, and answered. A
  job is enqueued in the same transaction, so a decision and the work it causes exist
  together or not at all.
- **worker** has no public address. It posts and edits Slack messages, runs approved
  actions, and runs the scheduler, which reads the `schedules` table once a minute.
- A **recommendation** is drafted, posted, then approved, dismissed, edited or expired.
  Buttons carry the recommendation ID and a hash of its content; a decision is taken under a
  row lock and is refused if the hash is not the stored one, so nobody approves something
  that changed after they read it. Editing makes a new version with a new hash.
- An **action** is something the catalog knows how to do. Approval creates one action row
  with a unique idempotency key; the worker runs it at most once per approval. A failure is
  never retried automatically: the message gets a Retry button.
- Every change of state, by a person or by the bot, is a row in the **audit log**.
- **Pause** stops posting, approving, executing and scheduling. An approver can pause; only
  an owner can resume.

## The weekly audit

```
audit.weekly (Mon 08:00 CT) ─▶ audit.run ─▶ collect ─▶ check ─▶ save findings ─▶ rank ─▶ report
probe.health (every 5 min) ──▶ probe_results ──────────┘                                  │
                                                                         audit.report.post ▼
                                                              one Slack message, top three findings
                                                 "Fix N via agent" ─▶ approval ─▶ Cursor agent ─▶ PR
```

- **Read-only.** `src/railway/queries.ts` is the complete list of what Patcher asks Railway:
  fixed queries, no mutation, and no query that returns a variable's value (names only). The
  client refuses anything that is not on the list.
- **Collectors** (`src/railway/collect.ts`) read projects, environments, services,
  deployments, events, metrics, HTTP statistics, error logs and usage for the last seven
  days. Each fact is either a value or "not checked, because…", so a collector that failed is
  never read as a healthy service.
- **Probes** (`src/probes/`) send one GET every five minutes to each public web service and
  to each project-specific check. Only public `https` addresses are probed; databases and
  services that sleep when idle are not.
- **Checks** (`src/weekly/checks.ts`) are plain rules in five categories: outages, bugs,
  capacity, deploy hygiene and security, plus cost. Each finding has a fingerprint made of
  the check, the project, the environment, the service and a signature, which is what lets
  the report say "still open, week 3" and resolve a finding only when its check ran and
  found nothing.
- **Log lines never leave as they came.** A line is reduced to its shape for grouping and
  redacted before it is stored or sent to an agent (`src/weekly/redact.ts`).
- **The report** is one Slack message of five lines and four buttons: totals, then the top
  three findings. Each finding has either "Fix N via agent" or "Details N"; "Full report"
  opens the whole audit in the control UI. Muted and accepted findings stay out of it.
- **Fix via agent** is an ordinary recommendation carried by the report message. It exists
  only for a finding whose repository is linked to an active project in the registry, and
  only while Cursor is configured. Approval starts one agent (`src/fix/agentFix.ts`), which
  works on its own branch and opens a pull request. Patcher never merges it. The agent ID is
  derived from the approval, so a retry cannot start a second agent.
- **The registry** (`/projects`) is the list of repositories an agent may be started on. An
  owner fills it, by hand or by importing from the Railway inventory.

A dry run reads the live workspace and writes the ranked findings to a file, without the
database, Slack or any fix. The output holds real project names, so the script refuses a path
inside the repository:

```bash
RAILWAY_API_TOKEN=... npx tsx scripts/audit-dry-run.ts --out /somewhere/outside/the/repo.md
```

## Layout

```
migrations/            versioned SQL, applied by `npm run migrate`
public/                the control UI's stylesheet
scripts/fake-slack.ts  a stand-in for Slack, for local runs
scripts/audit-dry-run.ts  the audit against the live workspace, to a file, read-only
slack/manifest.yaml    the hub app
src/
  web.ts  worker.ts  migrate.ts     the three entry points
  config.ts                         every environment variable, validated in one place
  audit/                            the audit log
  cursor/                           Cursor Cloud Agents client
  db/                               pool, transactions, migration runner
  fix/                              "Fix via agent": the action, its brief, the agent poll
  github/                           read-only GitHub App client
  integrations/                     which outside systems are configured, and when they last answered
  probes/                           the HTTP prober and the five-minute probe run
  queue/                            job names and payloads, the pg-boss wrapper
  railway/                          read queries, client, collectors, inventory
  recommendations/                  catalog, loop, delivery, executor, expiry, carriers
  registry/                         projects, their links and project-specific checks
  scheduler/                        schedules and the minute tick
  security/                         sealed secrets (public-key encryption for stored tokens)
  settings/                         settings, channel routes, people, pause
  slack/                            signature check, Web API client, messages, sign-in
  web/                              Slack endpoints, control UI, sessions
  weekly/                           checks, findings, ranking, the report and its delivery
  worker/                           job handlers
test/                               vitest, against a real Postgres
```

## Where later phases plug in

| To add | Where |
| --- | --- |
| A kind of recommendation | `catalog.registerKind` in `src/recommendations/catalog.ts` |
| Something approval can do | `catalog.registerAction`: a parameter schema, a one-line description, an `execute` that honours the idempotency key |
| A pipeline run on a schedule | A row in `schedules` (new migration) and an entry in `scheduleHandlers` in `src/worker/handlers.ts` |
| A background job | A name and schema in `src/queue/jobs.ts`, a `queue.work` call in `registerHandlers` |
| A Slack event | An entry in `slackEventHandlers`, and the event in the manifest |
| A report type with its own channel | `REPORT_TYPES` in `src/settings/routes.ts` |
| A setting | `settingDefs` in `src/settings/settings.ts` |
| A webhook from another system | A router beside `src/web/slackRoutes.ts` that verifies, stores in `webhook_events` and enqueues |
| A message that carries several recommendations | A carrier in `src/recommendations/carriers.ts`, as the audit report does in `src/weekly/delivery.ts` |
| An audit check | A `Check` in `src/weekly/checks.ts`, added to `CHECKS` |
| Something else to read from Railway | A query in `src/railway/queries.ts` (read-only) and a collector in `src/railway/collect.ts` |
| An outside system that can be unset | Variables in `src/config.ts` with `feature()`, a client built in `src/worker.ts`, a row in `src/integrations/status.ts` |

Producers call `createRecommendation`; it refuses a recommendation with no evidence or with
an action the catalog does not have.

## Running it locally

Needs Node 22 and Postgres.

```bash
npm ci
createdb patcher_dev && createdb patcher_test
cp .env.example .env        # then fill in the values below
npm run dev:migrate
npm run dev:fake-slack      # terminal 1: stands in for Slack on :4010
npm run dev:web             # terminal 2: http://localhost:3000
PORT=3001 npm run dev:worker   # terminal 3
```

A `.env` for running against the fake (none of these are real credentials):

```
DATABASE_URL=postgres://localhost:5432/patcher_dev
SESSION_SECRET=dev-only-session-secret-0123456789abcdef
SLACK_TEAM_ID=T0PATCHOPS
SLACK_BOT_TOKEN=xoxb-fake-local-token
SLACK_CLIENT_ID=fake-client-id
SLACK_CLIENT_SECRET=fake-client-secret
SLACK_SIGNING_SECRET=fake-signing-secret-for-local-use
BOOTSTRAP_OWNER_SLACK_USER_ID=U0OWNER
SLACK_API_URL=http://localhost:4010/api/
SLACK_OIDC_URL=http://localhost:4010
```

Without `RAILWAY_API_TOKEN`, `CURSOR_API_KEY` and the `GITHUB_APP_*` variables the worker
starts, logs each as not configured, and the **Audits** screen says which variables are
missing.

Open <http://localhost:3000>, sign in (the fake signs you in as `U0OWNER`), go to
**Settings**, refresh the channel list, choose a channel and click **Send test**. The fake
shows what the bot posted at <http://localhost:4010/_state>, and can click a button the way
Slack would, with a correctly signed request:

```bash
curl -X POST localhost:4010/_click -H 'content-type: application/json' \
  -d '{"ts":"<message ts from /_state>","button":"Approve"}'
```

## Checks

```bash
npm test            # needs Postgres; TEST_DATABASE_URL overrides the default patcher_test
npm run typecheck
npm run lint
npm run build
```

The test run rebuilds the test database from `migrations/` each time.

## Rules the code holds to

- No secret in the repository, in a log line or in an error message. Configuration errors
  name the variable and never repeat its value.
- Slack messages stay short: at most five lines and one row of four buttons at the top
  level, one line after a decision, detail in a thread or behind a link.
- Text that came from outside is escaped before it goes into a Slack message or a page.
- The public service never holds a key that decrypts stored tokens, nor the Railway, Cursor
  or GitHub credentials.
- Railway is only read. Variable values are never requested.
- Tests and fixtures use made-up projects. Nothing read from a real workspace is committed.
- An agent is started only on a repository linked in the registry, only after approval, and
  nothing merges its pull request.
