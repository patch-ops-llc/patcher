-- Phase 4b: the browser companion (design 8.5). A Chrome extension in a reader profile on
-- the owner's own machine sees the messages Slack's web client receives and posts them to
-- Patcher under a device key. Patcher holds no Slack credential for those workspaces.

-- Whether the companion may capture a workspace. Separate from `enabled`, which switches
-- all reading of the workspace on or off, forwarded mail included.
ALTER TABLE slack_workspaces ADD COLUMN companion_enabled boolean NOT NULL DEFAULT false;

-- One paired reader. The key is shown once when it is issued; only its hash is kept.
CREATE TABLE companion_devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label              text NOT NULL,
  key_hash           text NOT NULL UNIQUE,
  -- The extension's own version, as it reports it.
  version            text,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- The first request that carried the key.
  paired_at          timestamptz,
  last_seen_at       timestamptz,
  last_heartbeat_at  timestamptz,
  -- Message frames the extension saw, messages it sent, and messages Patcher kept.
  seen_count         bigint NOT NULL DEFAULT 0,
  sent_count         bigint NOT NULL DEFAULT 0,
  stored_count       bigint NOT NULL DEFAULT 0,
  -- What the last heartbeat said about the capture points: counts and flags, no message text.
  diagnostics        jsonb,
  -- Set when the note about a silent reader was posted, cleared when it reports again.
  silent_notified_at timestamptz,
  revoked_at         timestamptz,
  revoked_by         text
);

-- What a device last said about one workspace.
CREATE TABLE companion_workspace_status (
  device_id         uuid NOT NULL REFERENCES companion_devices (id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  -- open: a tab shows the workspace's client. asleep: the tab is there but does not answer
  -- (discarded, frozen, or opened before the extension was loaded). signed_out: the tab left
  -- the client for a sign-in page. closed: no tab.
  state             text NOT NULL CHECK (state IN ('open', 'asleep', 'signed_out', 'closed')),
  state_since       timestamptz NOT NULL DEFAULT now(),
  state_detail      text,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_open_at      timestamptz,
  -- The last time the extension saw any message frame for the workspace, sent or not.
  last_message_at   timestamptz,
  -- The member id the extension read from the page, offered to the owner; never used unasked.
  suggested_user_id text,
  -- The state the hub was last told about, so each change is told once.
  notified_state    text,
  notified_at       timestamptz,
  capture_notified_at timestamptz,
  PRIMARY KEY (device_id, workspace_id)
);

-- Coverage by hour: how many of the minute heartbeats arrived, in how many the workspace was
-- open, and how many messages were seen, sent and kept. Counts only.
CREATE TABLE companion_coverage (
  device_id    uuid NOT NULL REFERENCES companion_devices (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  hour         timestamptz NOT NULL,
  beats        integer NOT NULL DEFAULT 0,
  open_beats   integer NOT NULL DEFAULT 0,
  seen         integer NOT NULL DEFAULT 0,
  sent         integer NOT NULL DEFAULT 0,
  stored       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, workspace_id, hour)
);

CREATE INDEX companion_coverage_hour_idx ON companion_coverage (hour);

-- What happened to a reader: a silence between heartbeats, a workspace changing state.
-- This is where "how often is the session signed out" is answered from.
CREATE TABLE companion_events (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES companion_devices (id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('gap', 'state')),
  -- For a state change: the state left and the state entered.
  from_state   text,
  to_state     text,
  from_at      timestamptz,
  to_at        timestamptz NOT NULL DEFAULT now(),
  detail       text
);

CREATE INDEX companion_events_device_idx ON companion_events (device_id, to_at DESC);
CREATE INDEX companion_events_workspace_idx ON companion_events (workspace_id, to_at DESC);

-- Tells the hub about a reader that was signed out, went silent, or stopped capturing.
INSERT INTO schedules (key, cron_expr, tz) VALUES ('companion.watch', '*/5 * * * *', 'America/Chicago');
