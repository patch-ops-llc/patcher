-- Phase 1 (Weekly audit). Tables follow section 11 of the design: the project registry, the
-- Railway inventory, probe results, audit runs and findings, and the Cursor agents that
-- approved fixes start.

-- Registry -------------------------------------------------------------------------------

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  client      text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  description text NOT NULL DEFAULT '',
  aliases     text[] NOT NULL DEFAULT '{}',
  domains     text[] NOT NULL DEFAULT '{}',
  -- Name and link of the Cursor Project, once phase 2 needs it.
  cursor_ref  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX projects_name_idx ON projects (lower(name));

CREATE TABLE project_links (
  id          bigserial PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('repo', 'railway_project', 'slack_channel', 'contact')),
  -- repo: `owner/name` in lower case. railway_project: the Railway project id.
  external_id text NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, external_id)
);

-- A repository or a Railway project belongs to exactly one registry project, so "which
-- project is this, and may an agent work on it" always has one answer.
CREATE UNIQUE INDEX project_links_owned_idx ON project_links (kind, external_id)
  WHERE kind IN ('repo', 'railway_project');

-- Project-specific checks: a URL and what it should return.
CREATE TABLE project_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name          text NOT NULL,
  url           text NOT NULL,
  expect_status integer NOT NULL DEFAULT 200,
  -- Every key here must be present with an equal value in the JSON the URL returns.
  expect_json   jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Railway --------------------------------------------------------------------------------

-- One row per project, environment, service and service instance (a service in one
-- environment) ever seen in the workspace. Names and ids only; never variable values.
CREATE TABLE railway_inventory (
  id                 bigserial PRIMARY KEY,
  workspace_id       text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('project', 'environment', 'service', 'instance')),
  external_id        text NOT NULL,
  railway_project_id text NOT NULL,
  environment_id     text,
  service_id         text,
  name               text NOT NULL,
  previous_name      text,
  renamed_at         timestamptz,
  -- For an instance: public domains, health check path and source repository, which is what
  -- the probes and the registry screen read between audits.
  details            jsonb NOT NULL DEFAULT '{}',
  first_seen         timestamptz NOT NULL DEFAULT now(),
  last_seen          timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  UNIQUE (kind, external_id)
);

CREATE INDEX railway_inventory_project_idx ON railway_inventory (railway_project_id, kind);

CREATE TABLE probe_results (
  id              bigserial PRIMARY KEY,
  -- A Railway service in an environment, or a project-specific check.
  service_id      text,
  environment_id  text,
  check_id        uuid REFERENCES project_checks (id) ON DELETE CASCADE,
  host            text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  ok              boolean NOT NULL,
  status          integer,
  latency_ms      integer,
  error           text,
  cert_expires_at timestamptz,
  CHECK ((check_id IS NOT NULL) <> (service_id IS NOT NULL))
);

CREATE INDEX probe_results_service_idx ON probe_results (service_id, environment_id, at DESC);
CREATE INDEX probe_results_check_idx ON probe_results (check_id, at DESC);
CREATE INDEX probe_results_at_idx ON probe_results (at);

-- Audit ----------------------------------------------------------------------------------

CREATE TABLE audit_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger       text NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  -- Projects, services, findings by severity, healthy services.
  counts        jsonb,
  -- The full report shown in the UI: ranked findings, inventory changes, and which checks
  -- ran. Kept in Postgres; the design's `report_key` pointed at a bucket this phase does
  -- not need.
  report        jsonb,
  error         text,
  -- The one Slack message for this run, which also carries the run's fix recommendations.
  slack_team    text,
  slack_channel text,
  slack_ts      text,
  posted_at     timestamptz,
  post_error    text
);

CREATE INDEX audit_runs_started_idx ON audit_runs (started_at DESC);

CREATE TABLE audit_findings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 of (service or project scope, category, signature). Stable from week to week.
  fingerprint        text NOT NULL UNIQUE,
  railway_project_id text NOT NULL,
  environment_id     text,
  service_id         text,
  project_name       text NOT NULL,
  environment_name   text,
  service_name       text,
  category           text NOT NULL,
  check_key          text NOT NULL,
  severity           text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title              text NOT NULL,
  cause              text NOT NULL DEFAULT '',
  recommendation     text NOT NULL DEFAULT '',
  action_type        text NOT NULL DEFAULT 'none' CHECK (action_type IN ('fix_via_agent', 'investigate', 'none')),
  evidence           jsonb NOT NULL DEFAULT '[]',
  -- The repository and branch the service deploys from, which is where a fix would go.
  repo               text,
  branch             text,
  -- The number the finding is about (crashes, error lines, percent), for "growing".
  metric             double precision,
  previous_metric    double precision,
  first_run          uuid REFERENCES audit_runs (id) ON DELETE SET NULL,
  last_run           uuid REFERENCES audit_runs (id) ON DELETE SET NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  state              text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'muted', 'accepted')),
  state_by           text,
  state_at           timestamptz,
  state_note         text,
  resolved_at        timestamptz,
  -- The latest fix recommendation made for this finding, and the pull request it led to.
  recommendation_id  uuid REFERENCES recommendations (id) ON DELETE SET NULL,
  pr_url             text
);

CREATE INDEX audit_findings_state_idx ON audit_findings (state, severity);
CREATE INDEX audit_findings_last_run_idx ON audit_findings (last_run);

-- Cursor agents started by an approved "Fix via agent".
CREATE TABLE agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES recommendations (id) ON DELETE CASCADE,
  finding_id        uuid REFERENCES audit_findings (id) ON DELETE SET NULL,
  agent_id          text NOT NULL UNIQUE,
  run_id            text NOT NULL,
  agent_url         text NOT NULL,
  repo              text NOT NULL,
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed', 'timed_out')),
  pr_url            text,
  result            text,
  last_error        text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  last_polled_at    timestamptz,
  -- Set once the outcome has been posted to the Slack thread.
  reported_at       timestamptz
);

CREATE INDEX agent_runs_recommendation_idx ON agent_runs (recommendation_id);

-- Which outside systems the worker has credentials for, and when each last worked. The
-- worker writes this; the public service only reads it, since it holds none of the keys.
CREATE TABLE integrations (
  name          text PRIMARY KEY,
  configured    boolean NOT NULL,
  -- Names of the variables that are not set. Never values.
  missing       text[] NOT NULL DEFAULT '{}',
  last_ok_at    timestamptz,
  last_error    text,
  last_error_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Loop: a recommendation can be carried by a shared Slack message (the audit report) rather
-- than posted as its own. `carrier_type` names who renders that message; `carrier_id` is the
-- carrier's own id (for the audit, the run).
ALTER TABLE recommendations ADD COLUMN carrier_type text;
ALTER TABLE recommendations ADD COLUMN carrier_id text;
CREATE INDEX recommendations_carrier_idx ON recommendations (carrier_type, carrier_id) WHERE carrier_type IS NOT NULL;

INSERT INTO schedules (key, cron_expr, tz) VALUES
  ('audit.weekly', '0 8 * * 1', 'America/Chicago'),
  ('probe.health', '*/5 * * * *', 'America/Chicago');
