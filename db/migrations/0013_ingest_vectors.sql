-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- The vectors an ingest run has made for a document that is not yet written, keyed by the row's
-- position among the document's section, passage and sentence rows. The transaction that writes
-- the chunks reads them in the database, so no vector travels back through the Data API, and
-- deletes them. The rows belong to the ingest_progress row with the same document id.
CREATE TABLE ingest_vectors (
  document_id text NOT NULL,
  idx         int NOT NULL,
  embedding   halfvec(1024) NOT NULL,
  PRIMARY KEY (document_id, idx)
);
