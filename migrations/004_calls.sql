-- Phase 2 (Calls). Tables follow sections 5 and 11 of the design: the connected Calendly and
-- Fathom accounts, the transcripts they deliver, the calls those transcripts belong to, which
-- project each call was matched to, and what was suggested from it.

-- One connected account: a Calendly personal access token, or one person's Fathom API key.
-- Both secrets are sealed with the public key, so only the worker can open them.
CREATE TABLE transcript_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text NOT NULL CHECK (source IN ('calendly', 'fathom')),
  -- Whose key this is, as typed when it was connected. Shown in the UI and in notices.
  owner             text NOT NULL,
  -- Fathom only. 'team': a key that can see calls shared with the team. 'personal': one
  -- teammate's own calls, private ones included.
  scope             text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'team')),
  secret_ciphertext text,
  webhook_secret_ct text,
  -- The vendor's id for the webhook this connection registered, so it can be removed.
  webhook_ref       text,
  -- sha256 of the token in this connection's webhook address. Fathom's payload does not say
  -- whose key it belongs to, so every connection has its own address.
  hook_token_hash   text UNIQUE,
  -- Why there is no webhook, when there is none. The poll covers the connection either way.
  webhook_note      text,
  -- The vendor's reference for the account (Calendly: the user and organization URIs).
  account           jsonb NOT NULL DEFAULT '{}',
  -- How many days of earlier calls to collect on the first poll.
  import_days       integer NOT NULL DEFAULT 0,
  -- The poll asks for everything newer than this.
  watermark         timestamptz,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  last_ok_at        timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transcript_connections_status_idx ON transcript_connections (status, source);

-- One conversation, however many times it was recorded. This is what is analysed, matched
-- and shown; its transcripts are the copies.
CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  started_at       timestamptz,
  duration_seconds integer,
  -- Calendly's host attendee, or the person whose Fathom recorded the call.
  host_email       text,
  -- [{ name, email, external }], merged from every copy.
  attendees        jsonb NOT NULL DEFAULT '[]',
  -- received: waiting for a second copy to arrive. analyzing: with the model.
  -- needs_project: asked in Slack. unmatched: no project. matched: has a project.
  -- held: waiting for something a person controls. failed: the analysis gave up.
  -- deleted: the recording was deleted at its source.
  status           text NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'analyzing', 'needs_project', 'unmatched', 'matched', 'held', 'failed', 'deleted')),
  status_detail    text,
  -- Why a call is held, so it can be picked up again when the cause is gone.
  hold_reason      text,
  analyze_after    timestamptz,
  -- Raised each time the project is set again. Suggestions belong to one version.
  version          integer NOT NULL DEFAULT 1,
  -- The version suggestions were last drafted for, so a retried job does not ask the model twice.
  suggested_version integer,
  summary          text,
  -- Reserved for the sales phase, which classifies the call. Not written in this phase.
  call_type        text,
  call_type_conf   numeric(4, 3),
  -- The one Slack message for this call: the question, then the suggestions, then the outcome.
  slack_team       text,
  slack_channel    text,
  slack_ts         text,
  posted_at        timestamptz,
  post_error       text,
  details_ts       text,
  -- Who answered "which project?" or moved the call, for the message's last line.
  project_set_by   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX calls_started_idx ON calls (started_at DESC NULLS LAST);
CREATE INDEX calls_status_idx ON calls (status);

CREATE TABLE transcripts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL CHECK (source IN ('calendly', 'fathom', 'upload')),
  connection_id    uuid REFERENCES transcript_connections (id) ON DELETE SET NULL,
  -- The vendor's id: Calendly's recap uuid, Fathom's recording id.
  external_id      text NOT NULL,
  call_id          uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  -- The copy that is analysed when a call was recorded more than once.
  is_preferred     boolean NOT NULL DEFAULT false,
  title            text NOT NULL,
  started_at       timestamptz,
  duration_seconds integer,
  host_email       text,
  attendees        jsonb NOT NULL DEFAULT '[]',
  -- Lines of "[HH:MM:SS] Speaker: words" where the source gives both. Null once purged.
  text             text,
  has_speakers     boolean NOT NULL DEFAULT false,
  has_timestamps   boolean NOT NULL DEFAULT false,
  content_hash     text NOT NULL,
  -- Link to the recording at its source, for people who can open it there.
  url              text,
  purge_after      timestamptz NOT NULL,
  purged_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX transcripts_call_idx ON transcripts (call_id);
CREATE INDEX transcripts_hash_idx ON transcripts (content_hash);
CREATE INDEX transcripts_purge_idx ON transcripts (purge_after) WHERE text IS NOT NULL;

-- One row per project a call was matched to or offered for. The design's `call_analyses`,
-- with the call's type and summary kept on `calls`.
CREATE TABLE call_analyses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  transcript_id uuid REFERENCES transcripts (id) ON DELETE SET NULL,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  match_conf    numeric(4, 3) NOT NULL,
  -- { quote, at, hints: [..] }: the line of the call and the registry facts behind the match.
  evidence      jsonb NOT NULL DEFAULT '{}',
  -- matched: suggestions are made for this project. candidate: offered in the question.
  state         text NOT NULL CHECK (state IN ('matched', 'candidate')),
  -- model: the model's reading, checked by code. rules: registry facts alone. person: chosen by someone.
  source        text NOT NULL CHECK (source IN ('model', 'rules', 'person')),
  decided_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, project_id)
);

CREATE INDEX call_analyses_project_idx ON call_analyses (project_id);

CREATE TABLE call_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- The call's version this was made for; an older version's suggestions are history.
  version           integer NOT NULL,
  position          integer NOT NULL,
  type              text NOT NULL CHECK (type IN ('code_change', 'task', 'client_followup', 'note')),
  -- Set when code changed the model's type, with the reason: a code change with no linked
  -- repository becomes a task.
  drafted_type      text,
  type_note         text,
  title             text NOT NULL,
  detail            text NOT NULL DEFAULT '',
  -- For a follow-up: the message a person would send.
  draft             text,
  -- The words from the call, verbatim, and where in the call they were said.
  quote             text NOT NULL,
  quote_at          text,
  repo              text,
  -- For a code change: the brief the agent would get, kept until the recommendation holds it.
  brief             text,
  recommendation_id uuid REFERENCES recommendations (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, version, position)
);

CREATE INDEX call_suggestions_project_idx ON call_suggestions (project_id, created_at DESC);
CREATE INDEX call_suggestions_rec_idx ON call_suggestions (recommendation_id) WHERE recommendation_id IS NOT NULL;

-- What an approved `task` or `client_followup` suggestion leaves behind: a task on the
-- project, or a drafted message for a person to send. Nothing is pushed anywhere else.
CREATE TABLE project_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('task', 'followup')),
  title             text NOT NULL,
  body              text NOT NULL DEFAULT '',
  call_id           uuid REFERENCES calls (id) ON DELETE SET NULL,
  -- One row per approved recommendation, however often its action is delivered.
  recommendation_id uuid UNIQUE REFERENCES recommendations (id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_by           text,
  done_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_tasks_project_idx ON project_tasks (project_id, status, created_at DESC);

-- Design section 3.3. The poll catches webhooks that were missed; the purge removes
-- transcript text past its retention.
INSERT INTO schedules (key, cron_expr, tz) VALUES
  ('transcripts.poll', '*/15 * * * *', 'America/Chicago'),
  ('retention.purge', '30 3 * * *', 'America/Chicago')
ON CONFLICT (key) DO NOTHING;
