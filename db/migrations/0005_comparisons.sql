-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- One row per comparison run over a corpus. The input hash covers the assertions and the accepted
-- facts the run read, so a rerun over the same input with the same pipeline version and model
-- finds its row; a complete row means the run inserts nothing, and a partial row resumes.
CREATE TABLE comparison_runs (
  id                bigserial PRIMARY KEY,
  corpus            text NOT NULL,
  pipeline_version  text NOT NULL,
  prompt_version    text NOT NULL,
  input_sha256      char(64) NOT NULL,
  model             text NOT NULL,
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'partial', 'complete')),
  counts            jsonb NOT NULL DEFAULT '{}',
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (corpus, pipeline_version, input_sha256, model)
);

-- A machine label belongs to a run. A person's relabel is a row with model 'operator', no run,
-- the person in decided_by and the row it overrides; the newest person's row for a pair wins
-- over every machine row, so a later run never hides a person's judgment. An accepted-kind row
-- names the accepted fact it compares against. event_id and topic place the pair in a group.
ALTER TABLE assertion_comparisons
  ADD COLUMN run_id            bigint REFERENCES comparison_runs (id) ON DELETE CASCADE,
  ADD COLUMN accepted_fact_id  bigint REFERENCES accepted_facts (id) ON DELETE CASCADE,
  ADD COLUMN event_id          bigint REFERENCES events (id) ON DELETE SET NULL,
  ADD COLUMN topic             text,
  ADD COLUMN similarity        real,
  ADD COLUMN decided_by        text,
  ADD COLUMN overrides         bigint REFERENCES assertion_comparisons (id) ON DELETE CASCADE,
  ADD CONSTRAINT assertion_comparisons_operator_check
    CHECK ((model = 'operator') = (decided_by IS NOT NULL AND run_id IS NULL)),
  ADD CONSTRAINT assertion_comparisons_accepted_check
    CHECK ((kind = 'accepted') = (accepted_fact_id IS NOT NULL)),
  ADD CONSTRAINT assertion_comparisons_label_kind_check
    CHECK ((kind = 'accepted') = (label IN ('consistent', 'inconsistent', 'not_covered')));

-- One machine label per pair per run, so a resumed run cannot write a pair twice.
CREATE UNIQUE INDEX assertion_comparisons_run_pair_idx
  ON assertion_comparisons (run_id, kind, assertion_a, coalesce(assertion_b, 0), coalesce(accepted_fact_id, 0))
  WHERE run_id IS NOT NULL;

-- The matrix reads one group; the witness report and the newest label read one pair.
CREATE INDEX assertion_comparisons_event_idx ON assertion_comparisons (event_id);
CREATE INDEX assertion_comparisons_topic_idx ON assertion_comparisons (topic) WHERE event_id IS NULL;
CREATE INDEX assertion_comparisons_pair_idx
  ON assertion_comparisons (kind, assertion_a, assertion_b, accepted_fact_id, run_at DESC);
CREATE INDEX assertion_comparisons_b_idx ON assertion_comparisons (assertion_b);
CREATE INDEX assertion_comparisons_fact_idx ON assertion_comparisons (accepted_fact_id);
CREATE INDEX assertions_time_idx ON assertions (event_id) WHERE time_text IS NOT NULL;
