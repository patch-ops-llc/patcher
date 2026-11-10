# Patcher

The PatchOps operations bot. It watches PatchOps' work, posts short recommendations in the
PatchOps Slack workspace, and acts only after a person on the approver list approves the
exact action shown.

This repository currently holds **phase 0, the foundation**: the two services, the database,
the job queue and scheduler, the Slack hub app, the control UI, settings, the audit log, the
pause switch, and the recommendation and approval loop end to end. No pipeline that produces
real recommendations exists yet; a test recommendation exercises the loop.

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

## Layout

```
migrations/            versioned SQL, applied by `npm run migrate`
public/                the control UI's stylesheet
scripts/fake-slack.ts  a stand-in for Slack, for local runs
slack/manifest.yaml    the hub app
src/
  web.ts  worker.ts  migrate.ts     the three entry points
  config.ts                         every environment variable, validated in one place
  audit/                            the audit log
  db/                               pool, transactions, migration runner
  queue/                            job names and payloads, the pg-boss wrapper
  scheduler/                        schedules and the minute tick
  recommendations/                  catalog, loop, delivery, executor, expiry
  security/                         sealed secrets (public-key encryption for stored tokens)
  settings/                         settings, channel routes, people, pause
  slack/                            signature check, Web API client, messages, sign-in
  web/                              Slack endpoints, control UI, sessions
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
- The public service never holds a key that decrypts stored tokens.
