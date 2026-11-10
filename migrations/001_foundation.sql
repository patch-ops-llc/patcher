-- Phase 0 (Foundation). Tables follow section 11 of the design; later phases add their own
-- tables and columns in later migrations. The queue's tables are managed by pg-boss.

-- Config ---------------------------------------------------------------------------------

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_routes (
  report_type text PRIMARY KEY,
  team_id     text NOT NULL,
  channel_id  text NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Hub channels as last listed by the worker, so the routing screen can offer a picker
-- without the public service calling Slack.
CREATE TABLE slack_channels (
  team_id     text NOT NULL,
  channel_id  text NOT NULL,
  name        text NOT NULL,
  is_private  boolean NOT NULL DEFAULT false,
  is_member   boolean NOT NULL DEFAULT false,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, channel_id)
);

CREATE TABLE schedules (
  key         text PRIMARY KEY,
  cron_expr   text NOT NULL,
  tz          text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_ok     boolean,
  updated_by  text,
  -- Set on insert and on edits by a person only. The scheduler never fires for a time
  -- before this, so changing a schedule does not trigger a catch-up run.
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schedules (key, cron_expr, tz) VALUES ('approvals.expire', '0 9 * * *', 'America/Chicago');

CREATE TABLE users (
  slack_user_id  text PRIMARY KEY,
  role           text NOT NULL CHECK (role IN ('owner', 'approver', 'viewer')),
  -- Recommendation kinds this person may decide. NULL means every kind.
  approval_kinds text[],
  display_name   text,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  -- SHA-256 of the cookie token; the token itself is never stored.
  id_hash       text PRIMARY KEY,
  slack_user_id text NOT NULL REFERENCES users (slack_user_id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  -- One-time message shown after a form post.
  flash         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Loop -----------------------------------------------------------------------------------

CREATE TABLE recommendations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  report_type     text NOT NULL,
  source_type     text NOT NULL,
  source_id       text,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  evidence        jsonb NOT NULL,
  proposed_action jsonb NOT NULL,
  action_hash     text NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  risk            text NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  status          text NOT NULL DEFAULT 'drafted' CHECK (status IN
                    ('drafted', 'posted', 'approved', 'executing', 'done', 'failed', 'dismissed', 'expired')),
  slack_team      text,
  slack_channel   text,
  slack_ts        text,
  posted_at       timestamptz,
  expires_at      timestamptz,
  reminded_at     timestamptz,
  decided_at      timestamptz,
  decided_by      text,
  details_ts      text,
  last_error      text,
  dedupe_key      text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recommendations_status_idx ON recommendations (status, created_at);
CREATE INDEX recommendations_channel_posted_idx ON recommendations (slack_channel, posted_at);

CREATE TABLE approvals (
  id                bigserial PRIMARY KEY,
  recommendation_id uuid NOT NULL REFERENCES recommendations (id) ON DELETE CASCADE,
  decision          text NOT NULL CHECK (decision IN ('approved', 'dismissed', 'edited', 'retried')),
  actor             text NOT NULL,
  via               text NOT NULL CHECK (via IN ('slack', 'ui')),
  version           integer NOT NULL,
  action_hash       text NOT NULL,
  edited_payload    jsonb,
  at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approvals_recommendation_idx ON approvals (recommendation_id, at);

CREATE TABLE actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES recommendations (id) ON DELETE CASCADE,
  type              text NOT NULL,
  request           jsonb NOT NULL,
  idempotency_key   text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  dry_run           boolean NOT NULL DEFAULT false,
  external_ref      text,
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  -- Set once the outcome has been written back to Slack, so a retried job reports only once.
  reported_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX actions_recommendation_idx ON actions (recommendation_id);

-- Operations -----------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id                bigserial PRIMARY KEY,
  source            text NOT NULL,
  external_event_id text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (source, external_event_id)
);

CREATE TABLE runs (
  id          bigserial PRIMARY KEY,
  pipeline    text NOT NULL,
  trigger     text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  summary     text
);

CREATE INDEX runs_pipeline_idx ON runs (pipeline, started_at DESC);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text,
  before  jsonb,
  after   jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
