-- Model steps of the weekly audit (design sections 7.3 and 10): every model call is recorded,
-- an audit can wait for its analysis, and a finding keeps what the model said about it next
-- to what the rules found.

-- One row per call to a model provider, whatever the feature. Tokens and cost only; neither
-- the prompt nor the reply is stored.
CREATE TABLE llm_calls (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  -- What the budget is counted against: 'audit' today.
  feature        text NOT NULL,
  -- The prompt folder under prompts/, and the version of it that was sent.
  task           text NOT NULL,
  prompt_version text NOT NULL,
  model          text NOT NULL,
  -- All input tokens, including those read from the prompt cache.
  input_tokens   integer NOT NULL DEFAULT 0,
  cached_tokens  integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  -- US dollars at list price. Null when the model's price is not known to the code.
  cost           numeric(12, 6),
  -- Null for a request that ran in a batch.
  latency_ms     integer,
  batch          boolean NOT NULL DEFAULT false,
  -- False when the provider failed or the reply did not pass validation.
  ok             boolean NOT NULL,
  error          text,
  -- The run the call belongs to: for the audit, audit_runs.id.
  run_id         uuid
);

CREATE INDEX llm_calls_at_idx ON llm_calls (at DESC);
CREATE INDEX llm_calls_feature_idx ON llm_calls (feature, at DESC);
CREATE INDEX llm_calls_run_idx ON llm_calls (run_id) WHERE run_id IS NOT NULL;

-- 'analyzing': the checks are done and saved, and the run is waiting for the model's batch.
ALTER TABLE audit_runs DROP CONSTRAINT audit_runs_status_check;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_status_check
  CHECK (status IN ('running', 'analyzing', 'done', 'failed'));
-- While analyzing: the batch id and which request holds which findings. No prompt text.
ALTER TABLE audit_runs ADD COLUMN analysis jsonb;

-- What the model drafted for this finding in one run: wording, likely cause, recommended
-- action, and the evidence line it rests on. The rule's own columns are left as they are.
ALTER TABLE audit_findings ADD COLUMN assessment jsonb;
