-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- An accepted fact keeps its own text and citation, so re-extracting a document clears the
-- link to its source assertion instead of failing the delete.
ALTER TABLE accepted_facts
  DROP CONSTRAINT accepted_facts_assertion_id_fkey,
  ADD CONSTRAINT accepted_facts_assertion_id_fkey
    FOREIGN KEY (assertion_id) REFERENCES assertions (id) ON DELETE SET NULL;
