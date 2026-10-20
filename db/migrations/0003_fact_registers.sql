-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- Document pairs that together reveal a cipher-only witness's identity. The page refuses to
-- show such a pair side by side. A pair is stored once, with the smaller id first. The ids
-- carry no foreign key, so a flag can be set before a document is ingested and outlives a
-- re-ingest, which deletes and re-inserts the document row.
CREATE TABLE identity_revealing_pairs (
  document_a  text NOT NULL,
  document_b  text NOT NULL,
  reason      text NOT NULL,
  marked_by   text NOT NULL,
  marked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_a, document_b),
  CHECK (document_a < document_b)
);

-- Extraction reuses an entity or an event by its name, compared without case.
CREATE UNIQUE INDEX entities_kind_canonical_idx ON entities (kind, lower(canonical));
CREATE UNIQUE INDEX events_name_idx ON events (lower(name));

CREATE INDEX assertions_source_chunk_idx ON assertions (source_chunk_id);

-- A re-ingest deletes the document and its chunks; the assertions made from those chunks,
-- and the comparisons made from those assertions, go with them. An accepted fact keeps its
-- foreign key without a cascade, so a re-ingest that would remove a promoted assertion fails.
ALTER TABLE assertions DROP CONSTRAINT assertions_source_chunk_id_fkey;
ALTER TABLE assertions
  ADD CONSTRAINT assertions_source_chunk_id_fkey
  FOREIGN KEY (source_chunk_id) REFERENCES chunks (id) ON DELETE CASCADE;

ALTER TABLE assertion_comparisons DROP CONSTRAINT assertion_comparisons_assertion_a_fkey;
ALTER TABLE assertion_comparisons
  ADD CONSTRAINT assertion_comparisons_assertion_a_fkey
  FOREIGN KEY (assertion_a) REFERENCES assertions (id) ON DELETE CASCADE;

ALTER TABLE assertion_comparisons DROP CONSTRAINT assertion_comparisons_assertion_b_fkey;
ALTER TABLE assertion_comparisons
  ADD CONSTRAINT assertion_comparisons_assertion_b_fkey
  FOREIGN KEY (assertion_b) REFERENCES assertions (id) ON DELETE CASCADE;
