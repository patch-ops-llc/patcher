-- Phase 4a: reading Slack (design section 8). Messages from the PatchOps workspace arrive
-- through the hub app's events; messages from other workspaces arrive as forwarded
-- notification mail. Both enter one pipeline: filter, bundle, triage, recommend, post.

-- One row per Slack workspace Patcher knows of. A workspace seen only in forwarded mail has
-- no team id; it is added switched off and reads nothing until an owner switches it on.
CREATE TABLE slack_workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         text UNIQUE,
  -- "acme" in acme.slack.com.
  domain          text UNIQUE,
  name            text NOT NULL,
  enabled         boolean NOT NULL DEFAULT false,
  read_mode       text NOT NULL CHECK (read_mode IN ('api', 'companion', 'email_only', 'connect')),
  capture_level   text NOT NULL DEFAULT 'notifications' CHECK (capture_level IN ('notifications', 'page')),
  read_dms        boolean NOT NULL DEFAULT true,
  -- What happens to a channel that has no rule: read it, or leave it out.
  channel_default text NOT NULL DEFAULT 'include' CHECK (channel_default IN ('include', 'exclude')),
  -- The client project a whole workspace belongs to, when it belongs to one.
  project_id      uuid REFERENCES projects (id) ON DELETE SET NULL,
  -- The person whose messages are read, and their token, sealed so only the worker can open it.
  reader_user_id  text,
  user_token_ct   text,
  token_scopes    text,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'connected', 'disconnected')),
  status_detail   text,
  last_message_at timestamptz,
  -- The last time Slack delivered any message event, kept to find a gap after an outage.
  last_event_at   timestamptz,
  updated_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slack_channel_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  -- The id where it is known. Forwarded mail gives only a name, so a rule can be by name.
  channel_id   text,
  channel_name text,
  rule         text NOT NULL CHECK (rule IN ('include', 'exclude', 'digest_only', 'urgent')),
  project_id   uuid REFERENCES projects (id) ON DELETE SET NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (channel_id IS NOT NULL OR channel_name IS NOT NULL)
);

CREATE UNIQUE INDEX slack_channel_rules_id_idx ON slack_channel_rules (workspace_id, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX slack_channel_rules_name_idx ON slack_channel_rules (workspace_id, lower(channel_name)) WHERE channel_id IS NULL;

-- One post of the digest: the numbered list of what needs the reader.
CREATE TABLE slack_digests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger       text NOT NULL DEFAULT 'schedule',
  -- Counts only: workspaces, new messages, items.
  stats         jsonb NOT NULL DEFAULT '{}',
  slack_team    text,
  slack_channel text,
  slack_ts      text,
  posted_at     timestamptz,
  post_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Messages that belong together: one thread, or one channel within the settle window.
-- A bundle is what the model reads and what becomes one recommendation.
CREATE TABLE slack_bundles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  -- The channel id, or "name:<channel>" or "from:<sender>" when the source gives no id.
  channel_key       text NOT NULL,
  channel_id        text,
  channel_name      text,
  channel_type      text NOT NULL DEFAULT 'unknown' CHECK (channel_type IN ('channel', 'group', 'im', 'mpim', 'unknown')),
  thread_ts         text,
  source            text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'reading', 'held', 'dropped', 'fyi', 'recommended', 'unanalysed', 'handled', 'failed')),
  status_detail     text,
  hold_reason       text,
  held_step         text CHECK (held_step IN ('triage', 'recommend')),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  -- Not read before this: more messages may still arrive.
  settle_at         timestamptz NOT NULL,
  first_at          timestamptz,
  last_at           timestamptz,
  message_count     integer NOT NULL DEFAULT 0,
  -- By rule, not by the model: a direct message, or a message that mentions the reader.
  addressed         boolean NOT NULL DEFAULT false,
  -- What the triage step returned, after the checks: label, urgency, reason.
  triage            jsonb,
  sender_name       text,
  summary           text,
  suggestion        text,
  draft             text,
  quote             text,
  link              text,
  project_id        uuid REFERENCES projects (id) ON DELETE SET NULL,
  urgent            boolean NOT NULL DEFAULT false,
  delivery          text CHECK (delivery IN ('now', 'digest')),
  recommendation_id uuid UNIQUE REFERENCES recommendations (id) ON DELETE SET NULL,
  digest_id         uuid REFERENCES slack_digests (id) ON DELETE SET NULL,
  digest_position   integer,
  -- The item's own message, when it was posted at once and not in a digest.
  slack_team        text,
  slack_channel     text,
  slack_ts          text,
  posted_at         timestamptz,
  post_error        text,
  analysed_at       timestamptz,
  purged_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX slack_bundles_open_idx ON slack_bundles (workspace_id, channel_key, coalesce(thread_ts, '')) WHERE status = 'open';
CREATE INDEX slack_bundles_status_idx ON slack_bundles (status, settle_at);
CREATE INDEX slack_bundles_channel_idx ON slack_bundles (workspace_id, channel_key, last_at DESC);
CREATE INDEX slack_bundles_digest_idx ON slack_bundles (digest_id, digest_position) WHERE digest_id IS NOT NULL;
CREATE INDEX slack_bundles_created_idx ON slack_bundles (created_at DESC);

-- A message as captured, whatever captured it. The text is removed when `purge_after`
-- passes; the ids and the link stay. The reader's own messages are kept without their text:
-- only when and where they were sent is needed, to see that something was answered.
CREATE TABLE slack_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  bundle_id       uuid REFERENCES slack_bundles (id) ON DELETE SET NULL,
  channel_id      text,
  channel_name    text,
  channel_type    text NOT NULL DEFAULT 'unknown',
  ts              text,
  thread_ts       text,
  sender_id       text,
  sender_name     text,
  text            text,
  link            text,
  source          text NOT NULL CHECK (source IN ('api', 'companion_page', 'companion_notification', 'email')),
  own             boolean NOT NULL DEFAULT false,
  mentions_reader boolean NOT NULL DEFAULT false,
  -- Slack's own timestamp when known, else a hash of workspace, channel, sender, text and a time bucket.
  dedupe_key      text NOT NULL UNIQUE,
  sent_at         timestamptz NOT NULL,
  purge_after     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slack_messages_bundle_idx ON slack_messages (bundle_id);
CREATE INDEX slack_messages_channel_idx ON slack_messages (workspace_id, channel_id, sent_at DESC);
CREATE INDEX slack_messages_purge_idx ON slack_messages (purge_after) WHERE text IS NOT NULL;
CREATE INDEX slack_messages_created_idx ON slack_messages (created_at);

-- How an item ended, and why it was dismissed. Read back into the triage prompt as examples.
CREATE TABLE triage_feedback (
  bundle_id uuid PRIMARY KEY REFERENCES slack_bundles (id) ON DELETE CASCADE,
  decision  text NOT NULL CHECK (decision IN ('approved', 'dismissed', 'handled', 'expired')),
  reason    text CHECK (reason IN ('not_relevant', 'already_handled', 'wrong_channel')),
  actor     text,
  at        timestamptz NOT NULL DEFAULT now()
);

-- What the code filter left out, as counts. No text and no names of people.
CREATE TABLE slack_drop_counts (
  workspace_id uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  day          date NOT NULL,
  reason       text NOT NULL,
  n            integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, reason)
);

-- Display names of people and channels, looked up once with the reader's token.
CREATE TABLE slack_names (
  workspace_id uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('user', 'channel')),
  external_id  text NOT NULL,
  name         text NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, external_id)
);

-- A catch-up read of channel history after a gap in the events, or asked for by a person.
CREATE TABLE slack_backfills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES slack_workspaces (id) ON DELETE CASCADE,
  since        timestamptz NOT NULL,
  reason       text NOT NULL,
  -- Where the list of conversations was left, between jobs.
  cursor       text,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  channels     integer NOT NULL DEFAULT 0,
  messages     integer NOT NULL DEFAULT 0,
  error        text,
  requested_by text NOT NULL DEFAULT 'system',
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX slack_backfills_workspace_idx ON slack_backfills (workspace_id, created_at DESC);

-- The secret part of the forwarding address. Only its hash is kept.
CREATE TABLE inbound_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- One row per mail delivered to the ingest address, so a second delivery is a no-op. The
-- body is never stored here. A refused mail keeps its sender and subject for a few days,
-- which is how the confirmation code of a mail forwarding rule reaches the owner.
CREATE TABLE inbound_emails (
  id           bigserial PRIMARY KEY,
  message_id   text NOT NULL UNIQUE,
  alias        uuid REFERENCES inbound_aliases (id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES slack_workspaces (id) ON DELETE SET NULL,
  parsed_ok    boolean NOT NULL DEFAULT false,
  outcome      text NOT NULL,
  sender       text,
  subject      text,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_emails_received_idx ON inbound_emails (received_at DESC);

-- A task from a Slack message may belong to no registered project.
ALTER TABLE project_tasks ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE project_tasks ADD COLUMN bundle_id uuid REFERENCES slack_bundles (id) ON DELETE SET NULL;

INSERT INTO schedules (key, cron_expr, tz) VALUES
  ('slack.digest', '0 9,13,17 * * 1-5', 'America/Chicago'),
  -- Picks up bundles that waited: the model was unavailable, or a job was lost.
  ('slack.catchup', '*/5 * * * *', 'America/Chicago');
