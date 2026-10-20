-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- How many windows of a document's sentences the assertion extractor has stored. A later run
-- with the same sentence set, versions and window size resumes after the last stored window;
-- any other run starts over. The row is deleted in the transaction that writes the document's
-- finished provenance row.
CREATE TABLE extraction_progress (
  document_id     text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  source_sha256   char(64) NOT NULL,
  tool_version    text NOT NULL,
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  window_size     int NOT NULL,
  windows_done    int NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (window_size > 0),
  CHECK (windows_done >= 0)
);
