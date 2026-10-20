-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- Who or what a claim is about doing: the witness (first person), a person, a group or a thing.
-- subject_text is a span of the source sentence; a witness subject is the row's witness_id. Rows
-- extracted before the subject was recorded keep both columns null.
ALTER TABLE assertions
  ADD COLUMN subject_text  text,
  ADD COLUMN subject_kind  text CHECK (subject_kind IN ('witness', 'person', 'group', 'thing')),
  ADD CONSTRAINT assertions_subject_kind_with_text
    CHECK ((subject_text IS NULL) = (subject_kind IS NULL));
