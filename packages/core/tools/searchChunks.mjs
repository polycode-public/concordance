// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// search_chunks: the hybrid retrieval over a phrase in one corpus, optionally in one witness's
// documents, as evidence blocks.
import { retrieveEvidence } from "../retrieval/evidence.mjs";
import { optionalText, requiredText } from "./shared.mjs";

const WITNESS_DOCUMENTS = `SELECT id FROM documents WHERE corpus = $1 AND witness_id = $2`;

export const searchChunks = {
  name: "search_chunks",
  description:
    "Searches the statements of this corpus for a phrase with the same hybrid retrieval as the " +
    "question (words and meaning) and returns the best passages as evidence blocks. Optional " +
    "filter: a witness id. Returns at most 12 blocks.",
  inputSchema: {
    type: "object",
    properties: {
      phrase: { type: "string" },
      witness: { type: "string" },
    },
    required: ["phrase"],
  },
  async run({ db, corpus, provider, signal }, input) {
    const phrase = requiredText(input, "phrase");
    const witness = optionalText(input, "witness");
    let documentIds = null;
    if (witness !== null) {
      documentIds = (await db.query(WITNESS_DOCUMENTS, [corpus, witness])).rows.map((r) =>
        String(r.id),
      );
      if (!documentIds.length) return { rows: [], evidence: [] };
    }
    const { blocks } = await retrieveEvidence({
      question: phrase,
      corpus,
      provider,
      db,
      signal,
      documentIds,
    });
    return {
      rows: blocks.map((b) => ({ documentId: b.documentId, chunkId: b.chunkId })),
      evidence: blocks,
    };
  },
};
