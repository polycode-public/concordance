// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// An in-memory store that answers the statements of the comparison run and the facts views by
// their exact text, over seeded tables with the store's column names.

import { RUN_SQL } from "../../packages/core/facts/compare.mjs";
import { VIEW_SQL, comparisonFromRow, latestPerPair } from "../../packages/core/facts/views.mjs";

/**
 * @param {{ witnesses?: object[], documents?: object[], chunks?: object[], assertions?: object[],
 *   events?: object[], facts?: object[], sessions?: object[], identityPairs?: object[] }} seed
 */
export function createCompareStore(seed = {}) {
  let nextId = 5000;
  let clock = Date.parse("2026-10-20T09:00:00.000Z");
  const t = {
    witnesses: seed.witnesses ?? [],
    documents: seed.documents ?? [],
    chunks: seed.chunks ?? [],
    assertions: seed.assertions ?? [],
    events: seed.events ?? [],
    accepted_facts: seed.facts ?? [],
    sessions: seed.sessions ?? [],
    identity_revealing_pairs: seed.identityPairs ?? [],
    comparison_runs: [],
    assertion_comparisons: [],
  };
  const statements = [];
  const newId = () => String(nextId++);
  const tick = () => new Date((clock += 1000)).toISOString();
  const rows = (r) => ({ rows: r, rowCount: r.length });
  const chunk = (id) => t.chunks.find((c) => c.id === String(id));
  const doc = (id) => t.documents.find((d) => d.id === id);
  const assertion = (id) => t.assertions.find((a) => a.id === String(id));
  const asId = (v) => (v === null || v === undefined ? null : String(v));
  const pairOf = (c) =>
    `${c.kind}:${c.assertion_a}:${c.assertion_b ?? 0}:${c.accepted_fact_id ?? 0}`;

  const handlers = new Map([
    [
      RUN_SQL.assertions,
      ([corpus, after, limit]) =>
        t.assertions
          .filter((a) => Number(a.id) > Number(after))
          .map((a) => {
            const c = chunk(a.source_chunk_id);
            const d = doc(c.document_id);
            return { a, c, d };
          })
          .filter(({ d }) => d.corpus === corpus)
          .sort((x, y) => Number(x.a.id) - Number(y.a.id))
          .slice(0, limit)
          .map(({ a, c, d }) => ({
            ...a,
            document_id: c.document_id,
            sentence: c.text,
            statement_date: d.statement_date ?? null,
          })),
    ],
    [
      RUN_SQL.facts,
      () =>
        [...t.accepted_facts]
          .sort((x, y) => Number(x.id) - Number(y.id))
          .map(({ id, assertion_id, text, is_hypothesis }) => ({
            id,
            assertion_id,
            text,
            is_hypothesis,
          })),
    ],
    [
      RUN_SQL.findRun,
      ([corpus, version, hash, model]) =>
        t.comparison_runs
          .filter(
            (r) =>
              r.corpus === corpus &&
              r.pipeline_version === version &&
              r.input_sha256 === hash &&
              r.model === model,
          )
          .map(({ id, status, counts }) => ({ id, status, counts: structuredClone(counts) })),
    ],
    [
      RUN_SQL.insertRun,
      ([corpus, version, prompt, hash, model]) => {
        const exists = t.comparison_runs.some(
          (r) =>
            r.corpus === corpus &&
            r.pipeline_version === version &&
            r.input_sha256 === hash &&
            r.model === model,
        );
        if (!exists) {
          t.comparison_runs.push({
            id: newId(),
            corpus,
            pipeline_version: version,
            prompt_version: prompt,
            input_sha256: hash,
            model,
            status: "running",
            counts: {},
          });
        }
        return [];
      },
    ],
    [
      RUN_SQL.labelled,
      ([corpus, version, model, after, limit]) => {
        const runs = new Set(
          t.comparison_runs
            .filter(
              (r) => r.corpus === corpus && r.pipeline_version === version && r.model === model,
            )
            .map((r) => r.id),
        );
        return t.assertion_comparisons
          .filter((c) => runs.has(c.run_id) && Number(c.id) > Number(after))
          .sort((x, y) => Number(x.id) - Number(y.id))
          .slice(0, limit)
          .map(({ id, kind, assertion_a, assertion_b, accepted_fact_id }) => ({
            id,
            kind,
            assertion_a,
            assertion_b,
            accepted_fact_id,
          }));
      },
    ],
    [
      RUN_SQL.insertComparisons,
      ([runId, ...cols]) => {
        let n = 0;
        cols[0].forEach((_, i) => {
          const row = {
            run_id: String(runId),
            model: cols[0][i],
            kind: cols[1][i],
            assertion_a: asId(cols[2][i]),
            assertion_b: asId(cols[3][i]),
            accepted_fact_id: asId(cols[4][i]),
            label: cols[5][i],
            reason: cols[6][i],
            span_a: cols[7][i],
            span_b: cols[8][i],
            event_id: asId(cols[9][i]),
            topic: cols[10][i],
            similarity: cols[11][i],
            decided_by: null,
            overrides: null,
          };
          const clash = t.assertion_comparisons.some(
            (c) => c.run_id === row.run_id && pairOf(c) === pairOf(row),
          );
          if (clash) return;
          t.assertion_comparisons.push({ id: newId(), ...row, run_at: tick() });
          n++;
        });
        return { rows: [], rowCount: n };
      },
    ],
    [
      RUN_SQL.finishRun,
      ([runId, status, counts]) => {
        const run = t.comparison_runs.find((r) => r.id === String(runId));
        Object.assign(run, { status, counts: structuredClone(counts) });
        return { rows: [], rowCount: 1 };
      },
    ],
    [
      VIEW_SQL.groups,
      () => {
        const latest = latestPerPair(t.assertion_comparisons.map(comparisonFromRow))
          .map(({ shown }) => shown)
          .filter((c) => c.kind !== "accepted");
        const groups = new Map();
        for (const c of latest) {
          const topic = c.eventId ? null : c.topic;
          const k = `${c.eventId}\u0000${topic}`;
          const g = groups.get(k) ?? {
            event_id: c.eventId,
            name: t.events.find((e) => e.id === c.eventId)?.name ?? null,
            topic,
            pairs: "0",
            contradictions: "0",
          };
          g.pairs = String(Number(g.pairs) + 1);
          if (c.label === "contradict") g.contradictions = String(Number(g.contradictions) + 1);
          groups.set(k, g);
        }
        return [...groups.values()];
      },
    ],
    [
      VIEW_SQL.byEvent,
      ([eventId]) => t.assertion_comparisons.filter((c) => c.event_id === String(eventId)),
    ],
    [
      VIEW_SQL.byTopic,
      ([topic]) => t.assertion_comparisons.filter((c) => c.event_id === null && c.topic === topic),
    ],
    [
      VIEW_SQL.byWitness,
      ([witnessId]) =>
        t.assertion_comparisons.filter(
          (c) =>
            assertion(c.assertion_a)?.witness_id === witnessId ||
            (c.assertion_b && assertion(c.assertion_b)?.witness_id === witnessId),
        ),
    ],
    [VIEW_SQL.comparison, ([id]) => t.assertion_comparisons.filter((c) => c.id === String(id))],
    [VIEW_SQL.event, ([id]) => t.events.filter((e) => e.id === String(id))],
    [
      VIEW_SQL.assertions,
      ([ids]) =>
        t.assertions
          .filter((a) => ids.map(String).includes(a.id))
          .map((a) => {
            const c = chunk(a.source_chunk_id);
            const d = doc(c.document_id);
            const w = t.witnesses.find((x) => x.id === a.witness_id);
            return {
              ...a,
              cipher_only: w?.cipher_only ?? null,
              document_id: c.document_id,
              sentence: c.text,
              locator: c.locator ?? {},
              statement_date: d.statement_date ?? null,
            };
          }),
    ],
    [
      VIEW_SQL.facts,
      ([ids]) =>
        t.accepted_facts
          .filter((f) => ids.map(String).includes(f.id))
          .map((f) => ({
            ...f,
            session_user: t.sessions.find((s) => s.id === f.session_id)?.user_id ?? null,
          })),
    ],
    [
      VIEW_SQL.identityPairs,
      ([documents]) =>
        t.identity_revealing_pairs.filter(
          (p) => documents.includes(p.document_a) && documents.includes(p.document_b),
        ),
    ],
    [VIEW_SQL.witness, ([id]) => t.witnesses.filter((w) => w.id === id)],
    [
      VIEW_SQL.witnessDocuments,
      ([id]) =>
        t.documents
          .filter((d) => d.witness_id === id)
          .sort((x, y) => String(x.statement_date).localeCompare(String(y.statement_date)))
          .map((d) => ({ id: d.id, statement_date: d.statement_date ?? null })),
    ],
    [
      VIEW_SQL.timeline,
      ([eventId, witnessId, after, limit]) =>
        t.assertions
          .filter(
            (a) =>
              a.time_text &&
              (eventId === null || a.event_id === String(eventId)) &&
              (witnessId === null || a.witness_id === witnessId) &&
              Number(a.id) > Number(after),
          )
          .sort((x, y) => Number(x.id) - Number(y.id))
          .slice(0, limit)
          .map((a) => {
            const c = chunk(a.source_chunk_id);
            return { ...a, document_id: c.document_id, locator: c.locator ?? {} };
          }),
    ],
    [
      VIEW_SQL.insertOverride,
      (p) => {
        const row = {
          id: newId(),
          run_id: null,
          kind: p[0],
          assertion_a: asId(p[1]),
          assertion_b: asId(p[2]),
          accepted_fact_id: asId(p[3]),
          label: p[4],
          reason: p[5],
          span_a: p[6],
          span_b: p[7],
          model: "operator",
          decided_by: p[8],
          overrides: asId(p[9]),
          event_id: asId(p[10]),
          topic: p[11],
          similarity: p[12],
          run_at: tick(),
        };
        if (!row.decided_by) throw new Error("an operator row needs decided_by");
        t.assertion_comparisons.push(row);
        return [{ id: row.id, run_at: row.run_at }];
      },
    ],
    [VIEW_SQL.sessionUser, ([id]) => t.sessions.filter((s) => s.id === id)],
    [
      VIEW_SQL.insertFact,
      ([assertionId, text, citation, by, sessionId, hypothesis]) => {
        if (!citation) throw new Error("source_citation is NOT NULL");
        if (hypothesis && !sessionId) throw new Error("a hypothesis needs a session");
        const row = {
          id: newId(),
          assertion_id: asId(assertionId),
          text,
          source_citation: citation,
          promoted_by: by,
          promoted_at: tick(),
          session_id: sessionId ?? null,
          is_hypothesis: hypothesis,
        };
        t.accepted_facts.push(row);
        return [{ id: row.id, promoted_at: row.promoted_at }];
      },
    ],
  ]);

  const query = async (text, params = []) => {
    statements.push({ text, params });
    const handler = handlers.get(text);
    if (!handler) throw new Error(`the fake store does not answer: ${text}`);
    const out = handler(params);
    return Array.isArray(out) ? rows(out) : out;
  };

  return {
    statements,
    tables: t,
    query,
    closed: 0,
    async close() {
      this.closed++;
    },
    /** Whether a statement text is one this store answers. */
    answers: (text) => handlers.has(text),
  };
}
