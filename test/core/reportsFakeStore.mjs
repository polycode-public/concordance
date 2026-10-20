// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// An in-memory store that answers the retrieval reads of a report over fixed chunks and
// documents, and the statements of the reports table.

export const DOCUMENT_ROWS = {
  IWS1: {
    id: "IWS1",
    title: "Witness statement of IWS1",
    witness_id: "IWS1",
    format: "pdf",
    page_count: 9,
  },
  IWS2: {
    id: "IWS2",
    title: "Witness statement of IWS2",
    witness_id: "IWS2",
    format: "pdf",
    page_count: 4,
  },
};

export const CHUNK_ROWS = [
  {
    id: "1",
    document_id: "IWS1",
    level: "passage",
    text: "The stairs were dark and full of smoke.",
    header: "[Grenfell Inquiry | Witness IWS1 | p.3 para 11]",
    locator: { page: 3, paragraph: 11 },
    prev_id: null,
    next_id: null,
    parent_id: null,
  },
  {
    id: "2",
    document_id: "IWS2",
    level: "passage",
    text: "The lift stopped at the fourth floor.",
    header: "[Grenfell Inquiry | Witness IWS2 | p.2 para 4]",
    locator: { page: 2, paragraph: 4 },
    prev_id: null,
    next_id: null,
    parent_id: null,
  },
];

/** @param {{ chunks?: object[], documents?: Record<string, object> }} [seed] */
export function createReportsStore({ chunks = CHUNK_ROWS, documents = DOCUMENT_ROWS } = {}) {
  const reports = [];
  const sessions = new Map();
  const calls = [];
  let nextId = 1;
  let clock = Date.parse("2026-10-20T09:00:00.000Z");
  const rows = (r) => ({ rows: r, rowCount: r.length });
  const asRow = (r) => ({ ...r, id: String(r.id) });

  const query = async (text, params = []) => {
    calls.push({ text, params });
    if (/^SELECT id FROM chunks/.test(text.trim())) {
      const scope = /document_id = ANY\(\$(\d)/.exec(text);
      const ids = scope ? params[Number(scope[1]) - 1] : null;
      return rows(
        chunks.filter((c) => !ids || ids.includes(c.document_id)).map((c) => ({ id: c.id })),
      );
    }
    if (/FROM chunks WHERE id = ANY/.test(text)) {
      return rows(chunks.filter((c) => params[0].includes(c.id)));
    }
    if (/FROM documents d/.test(text)) {
      return rows(params[0].filter((id) => documents[id]).map((id) => documents[id]));
    }
    if (/^INSERT INTO sessions/.test(text)) {
      if (!sessions.has(params[0])) sessions.set(params[0], params[1]);
      return rows([]);
    }
    if (/^INSERT INTO reports/.test(text.trim())) {
      const [sessionId, userId, filename, title, topic, changePrompt, documentIds, body] = params;
      if (!sessions.has(sessionId)) throw new Error("reports_session_id_fkey");
      const version =
        Math.max(
          0,
          ...reports
            .filter((r) => r.user_id === userId && r.filename === filename)
            .map((r) => r.version),
        ) + 1;
      clock += 1000;
      const row = {
        id: nextId++,
        session_id: sessionId,
        user_id: userId,
        filename,
        version,
        title,
        topic,
        change_prompt: changePrompt,
        document_ids: documentIds,
        body_markdown: body,
        citations: JSON.parse(params[8]),
        checks: JSON.parse(params[9]),
        prompt_version: params[10],
        model_id: params[11],
        created_at: new Date(clock).toISOString(),
      };
      reports.push(row);
      return rows([{ id: String(row.id), version, created_at: row.created_at }]);
    }
    if (/^DELETE FROM reports/.test(text)) {
      const gone = reports.filter((r) => r.user_id === params[0] && r.filename === params[1]);
      for (const r of gone) reports.splice(reports.indexOf(r), 1);
      return rows(gone.map((r) => ({ version: r.version })));
    }
    if (/GROUP BY filename/.test(text)) {
      const byName = new Map();
      for (const r of reports.filter((x) => x.user_id === params[0])) {
        const list = byName.get(r.filename) ?? [];
        list.push(r);
        byName.set(r.filename, list);
      }
      return rows(
        [...byName.entries()]
          .map(([filename, list]) => {
            const sorted = list.sort((a, b) => a.version - b.version);
            return {
              filename,
              versions: sorted.map((r) => r.version),
              title: sorted.at(-1).title,
              updated_at: sorted.at(-1).created_at,
            };
          })
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      );
    }
    if (/FROM reports WHERE user_id = \$1 AND filename = \$2/.test(text)) {
      const found = reports
        .filter((r) => r.user_id === params[0] && r.filename === params[1])
        .sort((a, b) => a.version - b.version)
        .map(asRow);
      return rows(/DESC LIMIT 1/.test(text) ? found.slice(-1) : found);
    }
    throw new Error(`the fake store does not answer: ${text.slice(0, 80)}`);
  };
  return { query, close: async () => {}, reports, sessions, calls };
}
