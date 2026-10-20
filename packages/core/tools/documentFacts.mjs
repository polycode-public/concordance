// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// document_facts: the stored facts of the documents of one corpus (title, witness, role,
// statement date, type, pages), with each document's first passage as evidence. A cipher-only
// witness's document carries its cipher only.
import { loadDocuments } from "../retrieval/expand.mjs";
import { MAX_TOOL_ROWS, optionalText, withEvidence } from "./shared.mjs";

export const DOCUMENT_FACTS_SQL = `
  SELECT d.id,
         (SELECT c.id FROM chunks c
           WHERE c.document_id = d.id AND c.level = 'passage'
           ORDER BY c.ordinal, c.id LIMIT 1) AS first_chunk
    FROM documents d
   WHERE d.corpus = $1
     AND ($2::text IS NULL OR d.witness_id = $2)
     AND ($3::text IS NULL OR d.id = $3)
   ORDER BY d.statement_date NULLS LAST, d.id
   LIMIT ${MAX_TOOL_ROWS + 1}`;

export const documentFacts = {
  name: "document_facts",
  description:
    "Lists the documents of this corpus with their stored facts: document id, title, witness " +
    "id, role, statement date, type and page count, oldest statement first, each with its first " +
    "passage as an evidence block. Optional filters: a witness id or a document id. Returns at " +
    "most 50 documents and says when there are more.",
  inputSchema: {
    type: "object",
    properties: {
      witness: { type: "string" },
      document: { type: "string" },
    },
  },
  async run({ db, corpus }, input) {
    const { rows } = await db.query(DOCUMENT_FACTS_SQL, [
      corpus,
      optionalText(input, "witness"),
      optionalText(input, "document"),
    ]);
    const shown = rows.slice(0, MAX_TOOL_ROWS);
    const facts = await loadDocuments(
      db,
      shown.map((r) => String(r.id)),
    );
    const out = shown.map((r) => {
      const d = facts.get(String(r.id));
      return {
        documentId: String(r.id),
        title: d.title,
        witnessId: d.witnessId,
        cipherOnly: d.cipherOnly,
        role: d.role,
        statementDate: d.statementDate,
        type: d.type,
        pages: d.pages,
        ...(r.first_chunk == null ? {} : { chunkId: String(r.first_chunk) }),
      };
    });
    return withEvidence(db, out, { truncated: rows.length > MAX_TOOL_ROWS });
  },
};
