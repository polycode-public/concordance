// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One retrieval as evidence: the fused hits of one corpus, their neighbours and sections, and
// the numbered blocks with the facts of their documents.
import { buildEvidence, loadDocuments, neighbourIds, withDocuments, MAX_HITS } from "./expand.mjs";
import { loadChunks, retrieve } from "./hybrid.mjs";

/**
 * @param {{ question: string, corpus: string, provider: object, db: { query: Function },
 *   signal?: AbortSignal, documentIds?: string[] | null }} args
 * @returns {Promise<{ fused: { id: string, score: number }[], blocks: object[] }>}
 */
export async function retrieveEvidence({
  question,
  corpus,
  provider,
  db,
  signal,
  documentIds = null,
}) {
  const { fused } = await retrieve({ question, corpus, provider, db, signal, documentIds });
  const hitIds = fused.slice(0, MAX_HITS).map((f) => f.id);
  const rows = await loadChunks(db, hitIds);
  for (const [id, r] of await loadChunks(db, neighbourIds([...rows.values()], rows))) {
    rows.set(id, r);
  }
  signal?.throwIfAborted();
  const built = buildEvidence(hitIds, rows);
  const blocks = withDocuments(
    built,
    await loadDocuments(
      db,
      built.map((b) => b.documentId),
    ),
  );
  return { fused, blocks };
}
