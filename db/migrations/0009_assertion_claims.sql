-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- What a claim states, and the register entry its subject names. claim_kind is attribute (the
-- witness's own age, health, home, family or job), action, observation or report; alignment pairs
-- two witnesses' first-person claims only when both are observations, and never pairs one
-- witness's attribute with another's claim by a shared event. subject_entity_id is the entity a
-- non-pronoun subject resolves to through the registers; a witness resolves to the entity named by
-- its id. A person subject may be a span of a sentence next to its own when its own sentence
-- uses a pronoun. Rows extracted before these were recorded keep both columns null.
ALTER TABLE assertions
  ADD COLUMN claim_kind         text CHECK (claim_kind IN ('attribute', 'action', 'observation', 'report')),
  ADD COLUMN subject_entity_id  bigint REFERENCES entities (id);
