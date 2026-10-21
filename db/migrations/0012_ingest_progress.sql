-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- The context lines an ingest run has stored for a document that is not yet written. A later run
-- with the same sha256, pipeline version, model, prompt version and section count resumes after
-- the last stored line; any other run starts over. The row is deleted in the transaction that
-- writes the document. The document id has no foreign key because the document row does not exist
-- until that transaction.
CREATE TABLE ingest_progress (
  document_id     text PRIMARY KEY,
  source_sha256   char(64) NOT NULL,
  pipeline_version text NOT NULL,
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  section_count   int NOT NULL,
  contexts        jsonb NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (section_count >= 0)
);
