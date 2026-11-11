-- Phase 3b: the Penguin deal room through its service API (design 6.6).
--
-- A deal room update on the `api` route names the room it wrote to by the app's own id,
-- which never changes; the slug is kept for reading only. Nothing here holds a credential:
-- the bot token is a worker variable.

ALTER TABLE deal_room_updates
  -- The deal room address the update was made against. An update is only ever continued
  -- against the same address.
  ADD COLUMN origin    text,
  ADD COLUMN room_id   text,
  ADD COLUMN room_url  text,
  -- What the app said about the room when Patcher last read it:
  -- { status, slug, members, invites, domains }. No names and no addresses.
  ADD COLUMN room      jsonb,
  -- Set while the update is `held`: why nothing was written and what a person is asked to
  -- confirm. { reasons: ['live' | 'edited'], planHash, replaces: [path], removes: [path] }.
  ADD COLUMN hold      jsonb,
  -- What the write did, or would do, to each file in the room:
  -- [{ path, change: add | replace | same | remove | keep, by: service | person | repository | null }].
  ADD COLUMN changes   jsonb NOT NULL DEFAULT '[]';

-- held: the proposal was approved, and the room is live or holds a person's edits, so the
-- files wait in Patcher for a person's explicit confirmation.
ALTER TABLE deal_room_updates DROP CONSTRAINT deal_room_updates_status_check;
ALTER TABLE deal_room_updates
  ADD CONSTRAINT deal_room_updates_status_check
  CHECK (status IN ('prepared', 'pr_open', 'draft_written', 'held', 'published', 'merged', 'closed', 'failed'));

DROP INDEX deal_room_updates_open_idx;
CREATE INDEX deal_room_updates_open_idx ON deal_room_updates (status) WHERE status IN ('pr_open', 'draft_written', 'held');

COMMENT ON COLUMN deals.deal_room_ref IS 'The id of this deal''s room in the deal room app, set when the service API found or created it.';
