-- Phase 3a (Sales). Tables follow sections 6 and 11 of the design: what a sales call became
-- (a deal, a proposal in versions), and what was offered to the Penguin deal room.

-- One prospect. Several sales calls can belong to it.
CREATE TABLE deals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company           text NOT NULL,
  -- The prospect's e-mail domain, lower case. How a later call finds the same deal.
  domain            text,
  -- [{ name, role, email }], the prospect's people as the calls named them.
  contacts          jsonb NOT NULL DEFAULT '[]',
  -- true or false once the rule or a person has said. NULL: the rule could not be tested
  -- (the transcript carried no addresses) and nobody has answered yet.
  is_penguin        boolean,
  -- host, attendee: what the e-mail rule matched. flagged: a person said so, either way.
  penguin_reason    text CHECK (penguin_reason IN ('host', 'attendee', 'flagged')),
  penguin_set_by    text,
  -- The deal's slug in the deal room app, typed by a person. The app is the only place a room is created.
  deal_room_slug    text,
  -- Reserved for the deal room's own reference once its service API exists (phase 3b). Not written here.
  deal_room_ref     text,
  -- A person chose "Skip": this deal gets no deal room content, and its proposal is finished like any other.
  deal_room_skipped boolean NOT NULL DEFAULT false,
  stage             text NOT NULL DEFAULT 'open' CHECK (stage IN ('open', 'proposal_final', 'closed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deals_domain_idx ON deals (domain) WHERE domain IS NOT NULL;

-- One row per version of a deal's proposal. A regenerate, an edit and a later call each add a version.
CREATE TABLE proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  -- The call this version was drafted from.
  call_id       uuid REFERENCES calls (id) ON DELETE SET NULL,
  version       integer NOT NULL,
  -- draft: the current version. superseded: a newer version exists. final: approved.
  -- dismissed: a person said the call is not a deal.
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'superseded', 'final', 'dismissed')),
  title         text NOT NULL,
  -- One line for the Slack message.
  summary       text NOT NULL DEFAULT '',
  -- The deal brief, each field with the words of the call behind it.
  brief         jsonb NOT NULL DEFAULT '{}',
  content_md    text NOT NULL,
  content_hash  text NOT NULL,
  -- What a proposal needs and the call did not cover.
  gaps          jsonb NOT NULL DEFAULT '[]',
  -- What the checks removed or could not trace, for the person reviewing.
  flags         jsonb NOT NULL DEFAULT '[]',
  -- The rate card lines behind the Investment section.
  line_items    jsonb NOT NULL DEFAULT '[]',
  -- The rendered PDF. There is no bucket in this deployment, so it lives here.
  pdf           bytea,
  -- 'system' for a drafted version, a Slack user id for an edited one.
  created_by    text NOT NULL DEFAULT 'system',
  -- What the person asked for when they regenerated.
  note          text,
  finalized_by  text,
  finalized_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, version)
);

CREATE INDEX proposals_call_idx ON proposals (call_id);

-- A sales call's place in the pipeline, and its one Slack message in the sales channel.
CREATE TABLE sales_calls (
  call_id       uuid PRIMARY KEY REFERENCES calls (id) ON DELETE CASCADE,
  -- asked: "Sales call?" is waiting for an answer. drafting: the proposal is being written.
  -- drafted: it has a proposal. held: waiting for something a person controls.
  -- failed: the draft gave up. declined: a person said it is not a sales call or not a deal.
  state         text NOT NULL CHECK (state IN ('asked', 'drafting', 'drafted', 'held', 'failed', 'declined')),
  detail        text,
  hold_reason   text,
  -- What to run again when a hold ends.
  held_step     text CHECK (held_step IN ('classify', 'draft')),
  deal_id       uuid REFERENCES deals (id) ON DELETE SET NULL,
  -- Raised whenever what the message offers changes, so a button on an older drawing is refused.
  version       integer NOT NULL DEFAULT 1,
  -- Who answered the question or set the type by hand.
  decided_by    text,
  -- What the person asked for on Regenerate, until the draft has used it.
  note          text,
  requested_by  text,
  slack_team    text,
  slack_channel text,
  slack_ts      text,
  posted_at     timestamptz,
  post_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sales_calls_state_idx ON sales_calls (state);
CREATE INDEX sales_calls_deal_idx ON sales_calls (deal_id);

-- The service catalog and rate card. The only source of a price in a proposal.
CREATE TABLE sales_catalog (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short reference the model uses to name a service.
  key              text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- What one unit is: "session", "month", "integration", "fixed".
  unit             text NOT NULL DEFAULT 'fixed',
  -- NULL: listed without a price, so a proposal says TBD for it.
  unit_price_cents bigint CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  active           boolean NOT NULL DEFAULT true,
  updated_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One attempt to put a proposal's content in the deal room.
CREATE TABLE deal_room_updates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  proposal_id       uuid NOT NULL REFERENCES proposals (id) ON DELETE CASCADE,
  -- pull_request: content files in the app's repository (this phase). api: the app's service API (phase 3b).
  route             text NOT NULL CHECK (route IN ('pull_request', 'api')),
  repo              text,
  slug              text NOT NULL,
  -- [{ path, hash }]: each file and the sha256 of its content.
  files             jsonb NOT NULL DEFAULT '[]',
  -- What a person must still do by hand, as listed in the pull request.
  manual_steps      jsonb NOT NULL DEFAULT '[]',
  branch            text,
  pr_url            text,
  pr_number         integer,
  head_sha          text,
  status            text NOT NULL DEFAULT 'prepared'
                    CHECK (status IN ('prepared', 'pr_open', 'draft_written', 'published', 'merged', 'closed', 'failed')),
  error             text,
  -- The approved recommendation that asked for it. One update per approval.
  recommendation_id uuid UNIQUE REFERENCES recommendations (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deal_room_updates_deal_idx ON deal_room_updates (deal_id, created_at DESC);
CREATE INDEX deal_room_updates_open_idx ON deal_room_updates (status) WHERE status = 'pr_open';

-- Looks at the open deal room pull requests, so the Slack message says when one was merged or closed.
INSERT INTO schedules (key, cron_expr, tz) VALUES ('dealroom.sync', '*/30 * * * *', 'America/Chicago');
