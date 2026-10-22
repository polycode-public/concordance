-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- The cached share of the input tokens, by corpus, day and model. A turn and a report keep the
-- two counts in checks.usage beside inputTokens, which stays the total input. A row without the
-- counts adds 0. The two columns follow the existing ones, so the view is replaced in place.
CREATE OR REPLACE VIEW usage_daily AS
SELECT u.corpus, u.day, u.model, u.source,
       sum(u.requests)::bigint AS requests,
       sum(u.input_tokens)::bigint AS input_tokens,
       sum(u.output_tokens)::bigint AS output_tokens,
       sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
       sum(u.cache_write_tokens)::bigint AS cache_write_tokens
  FROM (
    SELECT s.corpus,
           (t.created_at AT TIME ZONE 'UTC')::date AS day,
           t.checks ->> 'model' AS model,
           'turn' AS source,
           1 AS requests,
           coalesce((t.checks -> 'usage' ->> 'inputTokens')::bigint, 0) AS input_tokens,
           coalesce((t.checks -> 'usage' ->> 'outputTokens')::bigint, 0) AS output_tokens,
           coalesce((t.checks -> 'usage' ->> 'cacheReadTokens')::bigint, 0) AS cache_read_tokens,
           coalesce((t.checks -> 'usage' ->> 'cacheWriteTokens')::bigint, 0) AS cache_write_tokens
      FROM session_turns t JOIN sessions s ON s.id = t.session_id
     WHERE jsonb_typeof(t.checks -> 'usage') = 'object'
    UNION ALL
    SELECT r.corpus,
           (r.created_at AT TIME ZONE 'UTC')::date,
           r.checks ->> 'model',
           'report',
           1,
           coalesce((r.checks -> 'usage' ->> 'inputTokens')::bigint, 0),
           coalesce((r.checks -> 'usage' ->> 'outputTokens')::bigint, 0),
           coalesce((r.checks -> 'usage' ->> 'cacheReadTokens')::bigint, 0),
           coalesce((r.checks -> 'usage' ->> 'cacheWriteTokens')::bigint, 0)
      FROM reports r
     WHERE jsonb_typeof(r.checks -> 'usage') = 'object'
    UNION ALL
    SELECT c.corpus,
           (coalesce(c.finished_at, c.started_at) AT TIME ZONE 'UTC')::date,
           c.model,
           'comparison',
           coalesce((c.counts ->> 'modelCalls')::bigint, 0),
           0,
           0,
           0,
           0
      FROM comparison_runs c
  ) u
 GROUP BY u.corpus, u.day, u.model, u.source;
