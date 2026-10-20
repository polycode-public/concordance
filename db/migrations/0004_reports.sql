-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- Generated reports. The body keeps the model's [En] tags; citations holds the locator each tag
-- resolved to when the report was written, so a re-ingest that renumbers chunks never changes
-- what a stored report cites. A filename names one report per user across sessions, because a
-- session is one connection and an edit often arrives on a later one; session_id records where
-- each version was written.
CREATE TABLE reports (
  id              bigserial PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id         text NOT NULL,
  filename        text NOT NULL,
  version         int NOT NULL,
  title           text NOT NULL,
  topic           text NOT NULL,
  change_prompt   text,
  document_ids    text[] NOT NULL DEFAULT '{}',
  body_markdown   text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]',
  checks          jsonb NOT NULL DEFAULT '{}',
  prompt_version  text NOT NULL,
  model_id        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, filename, version),
  UNIQUE (session_id, filename, version),
  CHECK (version > 0),
  CHECK (filename ~ '^[a-z0-9][a-z0-9-]*\.md$')
);
