# Patcher

The PatchOps operations bot. It watches PatchOps' work, posts short recommendations in the
PatchOps Slack workspace, and acts only after a person on the approver list approves the
exact action shown.

This repository holds four phases:

- **Phase 0, the foundation**: the two services, the database, the job queue and scheduler,
  the Slack hub app, the control UI, settings, the audit log, the pause switch, and the
  recommendation and approval loop end to end.
- **Phase 1, the weekly audit**: a read-only inventory of the Railway workspace, collectors
  and probes, findings that keep their identity from week to week, a model that assesses
  them, ranks them and words one short report in Slack, a registry that links Railway
  projects to repositories, and "Fix via agent", which starts a Cursor agent on a linked
  repository, with a brief the model drafted, after a person approves.
- **Phase 2, call transcripts**: transcripts from Calendly Notetaker and Fathom by webhook
  and by a catch-up poll, a call recorded by both analysed once, each call matched to a
  project in the registry, and the changes it asked for posted as one short Slack message.
  An approved code change starts a Cursor agent that opens a pull request.
- **Phase 3a, sales calls and proposals**: each analysed call is read for what kind of call
  it was; a sales call gets a proposal draft, offered in Slack to approve, edit or dismiss;
  a Penguin deal that already has a room gets, on approval, a pull request with the
  proposal as the room's content files. Nothing here merges it.

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
audit.weekly (Mon 08:00 CT) ─▶ audit.run ─▶ collect ─▶ check ─▶ save findings      (rules: the evidence)
probe.health (every 5 min) ──▶ probe_results ──────────┘              │
                                                                      ▼
                         audit.analyze ◀─ one batch, a request per troubled service  (model: assess)
                               │
                               ▼
                         rank and word the report ─▶ draft fix briefs                (model: rollup, brief)
                               │
             audit.report.post ▼
                    one Slack message, top three findings
       "Fix N via agent" ─▶ approval ─▶ Cursor agent ─▶ PR
```

Without `ANTHROPIC_API_KEY` the three model steps are skipped: the rules rank and word the
report, and its second line says "ranked by rules (AI not configured)".

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
  redacted before it is stored, sent to a model or sent to an agent
  (`src/security/redact.ts`).
- **The model steps** (`src/weekly/analyze.ts`) sit on top of the checks and change nothing
  the checks established: severity, evidence, counts and fingerprints are the rules'.
  1. *Per service* (`assess.ts`): one request for each service with a finding above
     informational, holding that service's facts, findings and redacted log patterns up to
     a token cap. The model drafts a headline, the likely cause, the next step and whether
     a code fix is the answer. The requests go as one batch, at half price.
  2. *Rollup* (`rollup.ts`): one call with a short entry per finding and last week's report.
     The model returns the order to read them in and the wording of the Slack lines.
  3. *Fix brief* (`src/fix/brief.ts`): for each fix that is proposed, the model drafts the
     task for the agent. Code puts it in a fixed frame with the evidence and the limits.
- **What a model can and cannot do.** It is sent text and returns one tool call, checked
  against a schema; a reply that fails is asked for once more and then dropped. It holds no
  credential and nothing it returns starts anything: the only path to an action is still a
  recommendation that a person approves, and the approval covers the exact brief. Each
  drafted line is used only if it rests on a line of the finding's own evidence, states no
  number the finding does not state and names no other project. A model may say a code fix
  is not the answer; it cannot offer one where the rule does not allow it. When a step
  cannot run (no key, switched off, over budget, provider down, unusable reply), the
  rules' wording stands and the report says who ranked it.
- **Cost.** Healthy services are never sent. Logs are capped per service
  (`ai.audit.log_token_cap`), the per-service requests are batched, the prompt is a cached
  block, and a daily and a monthly budget can be set in **Settings → AI**. Every call is a
  row in `llm_calls` with its task, model, prompt version, tokens and cost; neither the
  prompt nor the reply is stored.
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

## Call transcripts

```
Fathom / Calendly ──webhook──▶ web   check the address, store the delivery, acknowledge
                                 │
transcripts.poll (every 15 min)  ▼
        │              calls.webhook ─▶ verify the signature ─▶ fetch the transcript
        └─▶ calls.poll ─────────────────────────┐                     │
                                                ▼                     ▼
                              ingest: normalise, drop duplicates, group two recordings of one call
                                                │  (waits the settle time for a second recording)
                                  calls.analyze ▼
                    registry hints ─▶ model: which project, how sure, which words say so
                         │                      │
        below 0.50: Unmatched list     0.50 to 0.80: ask in Slack      0.80 and above: matched
                                                                              │
                                                                calls.suggest ▼
                                            model: at most five suggestions, each with a quote
                                                                              │
                                                                   calls.post ▼
                                             one Slack message ─▶ approval ─▶ agent ─▶ PR
```

- **Sources** (`src/calls/sources/`). One adapter per vendor behind `TranscriptSource`:
  check a key, register and delete a webhook, verify a delivery, list what is new, fetch one
  transcript. Calendly is one connection with a personal access token. Fathom keys are per
  person, so there can be several: one key for the team, a key per teammate, or both. Each
  connection has its own webhook address and its own poll watermark.
- **Keys** are typed into **Settings → Calls**, encrypted by the public service with
  `TOKEN_PUBLIC_KEY` before they are stored, and opened only by the worker with
  `TOKEN_PRIVATE_KEY`. They are never shown again, logged or sent to a model. The same goes
  for each webhook's signing secret.
- **Webhooks** arrive at `/webhooks/<source>/<token>`. The token is random, per connection,
  and stored only as a hash. The public service cannot check the signature, because it
  cannot open the signing secret; it stores the delivery and answers, and the worker
  verifies the signature before anything in the delivery is used. A delivery that fails is
  dropped and its body erased. Fathom's retries carry the same delivery id and are stored
  once.
- **The poll** runs every 15 minutes from each connection's watermark, with a day's overlap,
  so a missed webhook costs at most that long. A key the vendor refuses disconnects that
  connection only, with one notice in the errors channel.
- **One call, recorded twice** (`src/calls/ingest.ts`). Transcripts whose times overlap and
  whose guests largely match are one call. The call is analysed once, on the copy chosen by
  the "which transcript" setting (by default the one with speaker labels, then the longer
  one); the other is kept and shown as a duplicate. Analysis waits the settle time (ten
  minutes to start with) so the second recording can arrive first.
- **Matching** (`src/calls/hints.ts`, `match.ts`). The registry gives hints: an attendee's
  e-mail domain is a client domain, an attendee is a listed contact, a project's name or
  alias is in the title or said in the call. The model gets the hints, a card per project
  and the transcript, and returns projects with a confidence and the words that justify it.
  A match is kept only if the project is on the list and either the quote is in the
  transcript or the registry has a hint for it; without a quote found in the transcript the
  match can never be automatic, whatever confidence the model states. A call can match more
  than one project. Correcting a match in the UI offers to save the attendee's domain or a
  name on the project, so the next call matches by itself.
- **Suggestions** (`src/calls/suggest.ts`). For each matched project the model gets the
  transcript, the project's card, the start of each linked repository's README, its open
  pull request titles, and what was approved or dismissed before for that project only. It
  returns at most five. One is kept only if its quote is in the transcript, it is not a
  repeat, it carries no link that was not said on the call, and it names no other client
  or project. A code change needs a repository linked to the project and a configured
  Cursor key; otherwise it is offered as a task, and says why.
- **What approval does** (`src/calls/catalog.ts`). A code change starts one Cursor agent on
  the project's linked repository with the brief shown before approval; the agent opens a
  pull request and nothing merges it. A task is recorded on the project. A follow-up is a
  drafted message kept on the project for a person to send; Patcher sends nothing. A note
  is shown for awareness and has nothing to approve.
- **The message** (`src/calls/delivery.ts`) is one per call: a headline, the numbered
  suggestions (four at most; a call with five shows three and "+2 more under Pick"), and
  Approve all, Pick, Wrong project, Details. Pick opens a form to tick, edit and approve in one step. After the decisions
  the message is one line, and each outcome is one numbered reply in its thread.
- **What a model sees.** The transcript after redaction, attendee names with e-mail domains
  (not addresses), the project cards, README starts, pull request titles and earlier
  decisions' titles. It returns one tool call that only records its answer. When the model
  is not available (Patcher paused, no key, switched off, over budget, provider down) the
  call waits as "held" and is picked up again by itself; a reply that fails validation twice marks the
  call failed, with "Analyse again" on its page. Calls have their own budgets in
  **Settings → Calls**.
- **Deleting and keeping.** When a recording is deleted at its source Patcher deletes its
  copy, and if it was the call's only copy, also what was drawn from it and not yet
  approved. Transcript text is removed after the retention time (180 days to start with);
  the call's record stays.
- **By hand.** **Calls → Add a transcript** takes pasted text for a call recorded some
  other way.

## Sales calls and proposals

```
calls.analyze ─▶ seam (src/calls/seam.ts) ─▶ sales.classify
                                                  │ model: what kind of call, how sure, which words
        below 0.50: nothing      0.50 to 0.80: "Sales call?" in Slack      0.80 and above
                                                  │ Yes                          │
                                                  └──────────────┬───────────────┘
                                                     sales.draft ▼
                    model: deal brief (every point with the words behind it)
                    model: proposal from the brief, the template and the catalog without prices
                    code:  the Investment section, from the rate card
                    model: check of every claim against the brief; what fails is removed or flagged
                                                                 │
                                                      sales.post ▼
              one Slack message ─▶ Approve ─▶ final proposal (Markdown and PDF)
                                      └─ Penguin deal with a room ─▶ pull request under content/<slug>/
```

- **The seam.** `afterCallAnalysed` runs once a call's project question is settled, whether
  or not a project was found: a first sales call usually has none. The sales phase is one
  hook there (`registerSalesSeam`), and it only enqueues `sales.classify`.
- **What kind of call** (`src/sales/classify.ts`). The model gets the redacted transcript,
  the title, attendee names with e-mail domains, and the hints the rules found (a title
  word from **Settings → Sales**, whether an attendee is from a registered client, whether
  the call matched a project). It returns a type,
  a confidence and a quote. A sales type is kept only when the quote is in the transcript;
  without one the call can be asked about but never drafted by itself. The type is stored
  on the call (`calls.call_type`).
- **Deal brief** (`src/sales/brief.ts`). Company, people, problem, desired outcome, scope
  items, constraints, timeline, budget signals, objections, next steps. A point whose quote
  is not in the transcript is dropped, and what is missing is listed as a gap ("start
  date", "budget"). A brief with no problem and no scope is not drafted from. A later call
  with the same prospect adds to the same deal and makes the next proposal version.
- **The draft** (`src/sales/draft.ts`). The model writes the template's sections from the
  brief. It is never shown a price: the catalog it sees has names, descriptions and units.
  The Investment section is built in code from the rate card, an amount the model wrote
  into its prose is replaced with "TBD", and a service with no price is listed as "TBD"
  and as a gap.
- **The check** (`src/sales/grounding.ts`). A second model call lists claims in the draft
  that the brief does not support. Each is matched to the draft's own text: a sentence that
  can be removed cleanly is removed, anything else is flagged for the approver. If the
  check cannot run, the draft is held; an unchecked draft is never offered.
- **The message** (`src/sales/delivery.ts`) is one per sales call: who, what the draft
  covers, the gaps, and Review, Approve, Regenerate, Not a deal. Review opens the proposal
  as text to edit; an edit makes a new version and voids buttons that showed the old one.
  Regenerate takes a note for the model. The control UI has the same on **Sales**.
- **The PDF** (`src/sales/pdf.ts`) is rendered for each version when it is drafted or
  edited, stored in Postgres and served at `/sales/proposals/<id>/pdf` behind sign-in.
  **Approval** makes that version final and gives back the link. Patcher sends nothing to
  the prospect.
- **The Penguin rule** (`src/sales/penguin.ts`). A sales call is a Penguin deal when an
  address saved in **Settings → Sales** is the call's host or among its invitees: Calendly's
  host `user_email`, Fathom's `recorded_by.email` or `calendar_invitees[].email`. A pasted
  transcript carries no addresses, so the rule cannot be tested and the message asks. A
  person's mark on the deal (Penguin or not) overrides the rule in both directions and is
  not changed by later calls.
- **The deal room** (`src/dealroom/`). For a Penguin deal a person says which room it is
  (its slug). On approval, the proposal is cut at its headings into the room's layout,
  `content/<slug>/proposal/NN-name.md` each with a `title:` line and an `overview.md` when
  the room has none, checked against the renderer's rules (no images, no raw HTML, safe
  links, tables turned into lists), and opened as one pull request on a new `patcher/…`
  branch. The pull request lists what a person still has to do by hand. `dealroom.sync`
  reads its state every 30 minutes, so the Slack message says when it was merged or closed.
- **What the deal room client can do** (`src/dealroom/github.ts`). It has its own GitHub
  App, separate from the read-only one. Its token is asked for one repository with
  contents and pull request write. It refuses any path outside `content/<slug>/`, creates
  a branch and never updates an existing ref, and has no merge, close or delete request.
  Protect `main` on the deal room repository as well: the client holds to this in code,
  and branch protection makes GitHub hold to it too.
- **What a model sees.** The redacted transcript and attendee names with e-mail domains for
  the type and the brief; the brief, the template and the catalog without prices for the
  draft; the brief and the draft for the check. Never an address, a key or a price.
- **Not available.** With Patcher paused, the sales model switched off, a budget reached or
  the provider down, a sales call waits as "held" and continues by itself. A reply that
  fails validation twice marks it failed, with Retry.
- **Deleted at the source.** When a call's only recording is deleted, its open offer is
  closed, the brief's quotes are blanked and a draft nobody approved is emptied.

The deal room's service API (creating a deal, writing content without a redeploy) is the
next phase. It is a second `DealRoomAdapter` (`src/dealroom/adapter.ts`), chosen where
`src/worker.ts` builds `integrations.dealRoom`; `deal_room_updates.route` and
`deals.deal_room_ref` are already there for it.

## The audit dry run

A dry run reads the live workspace and writes the findings, ranked by the rules, to a file,
without the database, Slack, a model or any fix. The output holds real project names, so the script refuses a path
inside the repository:

```bash
RAILWAY_API_TOKEN=... npx tsx scripts/audit-dry-run.ts --out /somewhere/outside/the/repo.md
```

## Layout

```
migrations/            versioned SQL, applied by `npm run migrate`
prompts/               the model prompts, one folder per task, one file per version
public/                the control UI's stylesheet
scripts/fake-slack.ts  a stand-in for Slack, for local runs
scripts/audit-dry-run.ts  the audit against the live workspace, to a file, read-only
slack/manifest.yaml    the hub app
src/
  web.ts  worker.ts  migrate.ts     the three entry points
  config.ts                         every environment variable, validated in one place
  ai/                               the shared model client: provider adapter, prompts, validation,
                                    call records and cost
  audit/                            the audit log
  calls/                            call transcripts: sources, connections, ingestion, matching,
                                    suggestions, the Slack message, and the seam for the sales phase
  cursor/                           Cursor Cloud Agents client
  dealroom/                         the deal room: the proposal as its content files, the client that
                                    can only open a pull request under content/<slug>/, the adapter
  db/                               pool, transactions, migration runner
  fix/                              "Fix via agent": the action, its brief, the agent poll
  github/                           read-only GitHub App client
  integrations/                     which outside systems are configured, and when they last answered
  probes/                           the HTTP prober and the five-minute probe run
  queue/                            job names and payloads, the pg-boss wrapper
  railway/                          read queries, client, collectors, inventory
  recommendations/                  catalog, loop, delivery, executor, expiry, carriers
  registry/                         projects, their links and project-specific checks
  sales/                            sales calls: the call type, the Penguin rule, the deal brief, the
                                    proposal draft and its check, the PDF, the Slack message
  scheduler/                        schedules and the minute tick
  security/                         sealed secrets (public-key encryption for stored tokens), redaction
  settings/                         settings, channel routes, people, pause
  slack/                            signature check, Web API client, messages, sign-in
  web/                              Slack endpoints, control UI, sessions
  weekly/                           checks, findings, the model steps and their guardrails, ranking,
                                    the report and its delivery
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
| A webhook from another system | As `/webhooks/:source/:token` in `src/web/app.ts` does: check, store in `webhook_events`, enqueue, acknowledge |
| A transcript source | A `TranscriptSource` in `src/calls/sources/`, added to `integrations.transcripts` in `src/worker.ts` |
| Something that reads every analysed call | `onCallAnalysed` in `src/calls/seam.ts`. It can run twice for one call, so make it safe to repeat |
| Another way to reach the deal room | A `DealRoomAdapter` in `src/dealroom/adapter.ts`, chosen in `src/worker.ts` |
| A message that carries several recommendations | A carrier in `src/recommendations/carriers.ts`, as the audit report does in `src/weekly/delivery.ts` |
| An audit check | A `Check` in `src/weekly/checks.ts`, added to `CHECKS` |
| Something else to read from Railway | A query in `src/railway/queries.ts` (read-only) and a collector in `src/railway/collect.ts` |
| A model step | A prompt file under `prompts/<task>/` and its version in `src/ai/prompts.ts`; a `TaskSpec` (tool name, zod schema, token limit); `callModel` from `src/ai/run.ts` for one call, or `buildRequest` and `client.createBatch` for many. `callModel` redacts the data, validates the reply, repairs once and records the call |
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

Without `RAILWAY_API_TOKEN`, `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, the `GITHUB_APP_*` and the
`DEALROOM_GITHUB_APP_*` variables the worker starts, logs each as not configured, and the **Audits** screen says
which variables are missing. Connecting a call source also needs the token key pair
(`TOKEN_PUBLIC_KEY` on web, `TOKEN_PRIVATE_KEY` on worker); the setup checklist has the
command that makes one. A webhook is registered only when `APP_BASE_URL` is a public
`https` address, so a local run collects by poll.

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
- The public service never holds a key that decrypts stored tokens, nor the Railway, Cursor,
  GitHub, deal room, Anthropic, Calendly or Fathom credentials.
- A model drafts and classifies. It is given redacted text, returns data that is validated,
  and cannot start an action. Nothing is used from output that failed validation.
- Railway is only read. Variable values are never requested.
- Tests and fixtures use made-up projects, people and calls. Nothing read from a real
  workspace or a real call is committed.
- Nothing is used from a webhook before its signature has been verified.
- A suggestion from a call is kept only with words found in that call's transcript.
- A proposal carries no price a model wrote. Prices come from the rate card, in code.
- The deal room repository is written only as a pull request under `content/<slug>/`, only
  after approval. Nothing merges it and nothing pushes to its default branch.
- An agent is started only on a repository linked in the registry, only after approval, and
  nothing merges its pull request.
