// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// An in-memory store that answers the statements of the assertion extractor, with BEGIN,
// COMMIT and ROLLBACK over a snapshot of the tables.

const lower = (s) => s.toLowerCase();

/**
 * @param {{ documents?: object[], sentences?: object[], witnesses?: object[],
 *   entities?: object[], events?: object[] }} seed
 */
export function createFactsStore(seed = {}) {
  let nextId = 1000;
  let tables = {
    documents: seed.documents ?? [],
    chunks: seed.sentences ?? [],
    witnesses: seed.witnesses ?? [],
    entities: seed.entities ?? [],
    events: seed.events ?? [],
    assertions: [],
    provenance: [],
  };
  let snapshot = null;
  const statements = [];
  const id = () => String(nextId++);
  const rows = (r) => ({ rows: r, rowCount: r.length });
  const pairs = (a, b) => a.map((x, i) => [x, b[i]]);

  const query = async (text, params = []) => {
    statements.push({ text, params });
    const t = tables;
    if (/^BEGIN$/.test(text)) {
      if (snapshot) throw new Error("a transaction is already open");
      snapshot = structuredClone(tables);
      return rows([]);
    }
    if (/^COMMIT$/.test(text)) {
      snapshot = null;
      return rows([]);
    }
    if (/^ROLLBACK$/.test(text)) {
      tables = snapshot;
      snapshot = null;
      return rows([]);
    }
    if (/FROM documents WHERE id = \$1/.test(text)) {
      return rows(t.documents.filter((d) => d.id === params[0]));
    }
    if (/FROM chunks\s+WHERE document_id = \$1 AND level = 'sentence'/.test(text)) {
      const [doc, after, limit] = params;
      return rows(
        t.chunks
          .filter((c) => c.document_id === doc && c.ordinal > after)
          .sort((a, b) => a.ordinal - b.ordinal)
          .slice(0, limit)
          .map(({ id: cid, ordinal, text: body, header, context_line }) => ({
            id: cid,
            ordinal,
            text: body,
            header,
            context_line,
          })),
      );
    }
    if (/FROM provenance WHERE source_sha256/.test(text)) {
      const [src, step, version, model, prompt] = params;
      return rows(
        t.provenance.filter(
          (p) =>
            p.source_sha256 === src &&
            p.step === step &&
            p.tool_version === version &&
            p.model === model &&
            p.prompt_version === prompt,
        ),
      );
    }
    if (/^SELECT id, cipher_only, aliases FROM witnesses$/.test(text)) return rows(t.witnesses);
    if (/^SELECT id, kind, canonical, aliases FROM entities$/.test(text)) return rows(t.entities);
    if (/^\s*DELETE FROM assertions a USING chunks c/.test(text)) {
      const chunkIds = new Set(
        t.chunks.filter((c) => c.document_id === params[0]).map((c) => c.id),
      );
      const before = t.assertions.length;
      t.assertions = t.assertions.filter((a) => !chunkIds.has(a.source_chunk_id));
      return { rows: [], rowCount: before - t.assertions.length };
    }
    if (/^\s*INSERT INTO entities/.test(text)) {
      let n = 0;
      for (const [kind, canonical] of pairs(params[0], params[1])) {
        if (t.entities.some((e) => e.kind === kind && lower(e.canonical) === lower(canonical)))
          continue;
        t.entities.push({ id: id(), kind, canonical, aliases: [] });
        n++;
      }
      return { rows: [], rowCount: n };
    }
    if (/JOIN entities e/.test(text)) {
      return rows(
        pairs(params[0], params[1]).flatMap(([kind, canonical]) =>
          t.entities
            .filter((e) => e.kind === kind && lower(e.canonical) === lower(canonical))
            .map((e) => ({ kind, canonical, id: e.id })),
        ),
      );
    }
    if (/^\s*INSERT INTO events/.test(text)) {
      for (const name of params[0]) {
        if (!t.events.some((e) => lower(e.name) === lower(name))) t.events.push({ id: id(), name });
      }
      return rows([]);
    }
    if (/JOIN events e/.test(text)) {
      return rows(
        params[0].flatMap((name) =>
          t.events.filter((e) => lower(e.name) === lower(name)).map((e) => ({ name, id: e.id })),
        ),
      );
    }
    if (/^\s*INSERT INTO assertions/.test(text)) {
      const [witness, extractor, version, ...cols] = params;
      const inserted = cols[0].map((_, i) => ({
        id: id(),
        witness_id: witness,
        source_chunk_id: cols[0][i],
        event_id: cols[1][i],
        predicate: cols[2][i],
        object_text: cols[3][i],
        object_entity_id: cols[4][i],
        time_text: cols[5][i],
        place_text: cols[6][i],
        place_entity_id: cols[7][i],
        polarity: cols[8][i],
        modality: cols[9][i],
        confidence: cols[10][i],
        extractor,
        pipeline_version: version,
      }));
      t.assertions.push(...inserted);
      return { rows: [], rowCount: inserted.length };
    }
    if (/^\s*INSERT INTO provenance/.test(text)) {
      const [derived, source, step, tool, toolVersion, model, prompt] = params;
      t.provenance.push({
        derived_sha256: derived,
        source_sha256: source,
        step,
        tool,
        tool_version: toolVersion,
        model,
        prompt_version: prompt,
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`the fake store does not answer: ${text}`);
  };

  const store = {
    statements,
    closed: 0,
    get tables() {
      return tables;
    },
    query,
    pool: { connect: async () => ({ query, release: () => {} }) },
    close: async () => {
      store.closed++;
    },
  };
  return store;
}
