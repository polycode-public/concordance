-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- Every server frame of a turn, in the order the server sent it, so the page can replay the
-- turn without a model call. query_rewrites, retrieved_ids and reranker_scores are in 0001.

ALTER TABLE session_turns ADD COLUMN frames jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A turn that ends before the model answers, or that needs no model call, has no model id.
ALTER TABLE session_turns ALTER COLUMN model_id DROP NOT NULL;

-- One row per conversation: a thread within a session.
CREATE VIEW conversations AS
SELECT
  s.id AS session_id,
  s.user_id,
  t.thread,
  (array_agg(t.user_text ORDER BY t.created_at, t.id))[1] AS first_question,
  max(t.created_at) AS last_turn_at,
  count(*)::int AS turn_count
FROM sessions s
JOIN session_turns t ON t.session_id = s.id
GROUP BY s.id, s.user_id, t.thread;
