-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- Conversations, reports and accepted facts belong to one corpus, as documents do. The rows that
-- exist are Grenfell's: the default fills them and is then dropped, so every later write names
-- its corpus.
ALTER TABLE sessions ADD COLUMN corpus text NOT NULL DEFAULT 'grenfell';
ALTER TABLE sessions ALTER COLUMN corpus DROP DEFAULT;
CREATE INDEX sessions_user_corpus_idx ON sessions (user_id, corpus);

ALTER TABLE reports ADD COLUMN corpus text NOT NULL DEFAULT 'grenfell';
ALTER TABLE reports ALTER COLUMN corpus DROP DEFAULT;

-- A filename names one report per user within a corpus.
ALTER TABLE reports
  DROP CONSTRAINT reports_user_id_filename_version_key,
  ADD CONSTRAINT reports_user_id_corpus_filename_version_key
    UNIQUE (user_id, corpus, filename, version);

ALTER TABLE accepted_facts ADD COLUMN corpus text NOT NULL DEFAULT 'grenfell';
ALTER TABLE accepted_facts ALTER COLUMN corpus DROP DEFAULT;
CREATE INDEX accepted_facts_corpus_idx ON accepted_facts (corpus);

-- The corpus of a chunk is its document's, copied so retrieval filters one table. The trigger
-- keeps it on every insert, so the ingest's chunk insert needs no new column.
ALTER TABLE chunks ADD COLUMN corpus text;
UPDATE chunks c SET corpus = d.corpus FROM documents d WHERE d.id = c.document_id;
ALTER TABLE chunks ALTER COLUMN corpus SET NOT NULL;

CREATE FUNCTION chunks_corpus() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT d.corpus INTO STRICT NEW.corpus FROM documents d WHERE d.id = NEW.document_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER chunks_corpus BEFORE INSERT OR UPDATE OF document_id ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_corpus();

-- A corpus that holds few of the chunks reads them through this index and sorts them exactly;
-- the planner keeps the HNSW index for a corpus that holds most of them.
CREATE INDEX chunks_corpus_level_idx ON chunks (corpus, level);

-- The HNSW index applies a filter after it reads its candidate list (hnsw.ef_search, 40), so a
-- filter on level or corpus returns fewer rows than the LIMIT. An iterative scan reads on until
-- the LIMIT is met, in distance order. The setting applies to every new session.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = %L', current_database(), 'strict_order');
END
$$;

-- The conversation list filters by corpus; the new column goes last, as CREATE OR REPLACE needs.
CREATE OR REPLACE VIEW conversations AS
SELECT
  s.id AS session_id,
  s.user_id,
  t.thread,
  (array_agg(t.user_text ORDER BY t.created_at, t.id))[1] AS first_question,
  max(t.created_at) AS last_turn_at,
  count(*)::int AS turn_count,
  s.corpus
FROM sessions s
JOIN session_turns t ON t.session_id = s.id
GROUP BY s.id, s.user_id, s.corpus, t.thread;

-- Model use by corpus, day and model. A turn and a report store their tokens in checks.usage; a
-- comparison run stores its model calls in counts and no tokens; an extraction stores neither.
-- The spend route prices the tokens with the list prices in packages/core/pricing.mjs.
CREATE VIEW usage_daily AS
SELECT u.corpus, u.day, u.model, u.source,
       sum(u.requests)::bigint AS requests,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens
  FROM (
    SELECT s.corpus,
           (t.created_at AT TIME ZONE 'UTC')::date AS day,
           t.checks ->> 'model' AS model,
           'turn' AS source,
           1 AS requests,
           coalesce((t.checks -> 'usage' ->> 'inputTokens')::bigint, 0) AS input_tokens,
           coalesce((t.checks -> 'usage' ->> 'outputTokens')::bigint, 0) AS output_tokens
      FROM session_turns t JOIN sessions s ON s.id = t.session_id
     WHERE jsonb_typeof(t.checks -> 'usage') = 'object'
    UNION ALL
    SELECT r.corpus,
           (r.created_at AT TIME ZONE 'UTC')::date,
           r.checks ->> 'model',
           'report',
           1,
           coalesce((r.checks -> 'usage' ->> 'inputTokens')::bigint, 0),
           coalesce((r.checks -> 'usage' ->> 'outputTokens')::bigint, 0)
      FROM reports r
     WHERE jsonb_typeof(r.checks -> 'usage') = 'object'
    UNION ALL
    SELECT c.corpus,
           (coalesce(c.finished_at, c.started_at) AT TIME ZONE 'UTC')::date,
           c.model,
           'comparison',
           coalesce((c.counts ->> 'modelCalls')::bigint, 0),
           0,
           0
      FROM comparison_runs c
  ) u
 GROUP BY u.corpus, u.day, u.model, u.source;
