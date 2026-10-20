// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The comparison store with the chunk, document and event reads that the store tools add,
// answered from the same tables.

/**
 * The comparison store, plus the chunk, document and event reads the tools add, answered from
 * the same tables.
 */
export function toolStore(store) {
  const t = store.tables;
  const extra = [
    [
      /FROM chunks WHERE id = ANY\(\$1::bigint\[\]\)/,
      ([ids]) =>
        t.chunks
          .filter((c) => ids.map(String).includes(c.id))
          .map((c) => ({
            id: c.id,
            document_id: c.document_id,
            level: c.level,
            text: c.text,
            header: c.header ?? null,
            locator: c.locator,
            prev_id: null,
            next_id: null,
            parent_id: null,
          })),
    ],
    [
      /FROM documents d LEFT JOIN witnesses w/,
      ([ids]) =>
        t.documents
          .filter((d) => ids.includes(d.id))
          .map((d) => {
            const w = t.witnesses.find((x) => x.id === d.witness_id);
            return {
              id: d.id,
              title: `Statement ${d.id}`,
              witness_id: d.witness_id,
              role: null,
              statement_date: d.statement_date,
              format: "pdf",
              page_count: 4,
              cipher_only: w?.cipher_only ?? false,
              witness_role: w?.role ?? null,
            };
          }),
    ],
    [
      /SELECT id FROM events WHERE lower\(name\) = lower\(\$1\)/,
      ([name]) => t.events.filter((e) => e.name.toLowerCase() === name.toLowerCase()),
    ],
    [
      /SELECT id, name FROM events WHERE id = ANY/,
      ([ids]) => t.events.filter((e) => ids.map(String).includes(e.id)),
    ],
  ];
  return {
    statements: store.statements,
    async query(text, params = []) {
      if (store.answers(text)) return store.query(text, params);
      const hit = extra.find(([pattern]) => pattern.test(text));
      if (!hit) throw new Error(`the tool store does not answer: ${text}`);
      store.statements.push({ text, params });
      return { rows: hit[1](params) };
    },
  };
}
