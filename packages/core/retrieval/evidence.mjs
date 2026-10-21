// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One retrieval as evidence: the fused hits of one corpus, reranked when asked, their neighbours
// and sections, and the numbered blocks with the facts of their documents.
import { buildEvidence, loadDocuments, neighbourIds, withDocuments, MAX_HITS } from "./expand.mjs";
import { loadChunks, retrieve } from "./hybrid.mjs";
import { RERANK_CANDIDATES } from "../providers/rerank.mjs";

/**
 * Orders the fused candidates by the provider's rerank scores, highest first; equal scores keep
 * the fused order.
 * @returns {Promise<{ ids: string[], scores: Record<string, number> }>}
 */
async function reranked(provider, question, ids, rows, signal) {
  const passages = ids.map((id) => {
    const row = rows.get(id);
    if (!row) throw new Error(`chunk ${id} was not loaded`);
    return { id, header: row.header, text: row.text };
  });
  const scored = await provider.rerank(question, passages, { signal });
  if (!Array.isArray(scored) || scored.length !== ids.length) {
    throw new Error(`the reranker scored ${scored?.length ?? "no"} of ${ids.length} passages`);
  }
  const scores = {};
  scored.forEach(({ id, score }, i) => {
    if (id !== ids[i]) throw new Error(`the reranker scored ${id} in the place of ${ids[i]}`);
    scores[id] = score;
  });
  const order = ids
    .map((id, position) => ({ id, position }))
    .sort((a, b) => scores[b.id] - scores[a.id] || a.position - b.position);
  return { ids: order.map((o) => o.id), scores };
}

/**
 * `queries` are the search queries to run; with none given the question is the one query. With
 * `rerankQuestion` and a provider that has rerank(), the top RERANK_CANDIDATES fused candidates
 * are scored against it before expansion.
 * @param {{ question: string, queries?: string[], rerankQuestion?: string | null, corpus: string,
 *   provider: object, db: { query: Function }, signal?: AbortSignal,
 *   documentIds?: string[] | null,
 *   filters?: import('./hybrid.mjs').RetrievalFilters | null }} args
 * @returns {Promise<{ fused: { id: string, score: number }[], blocks: object[],
 *   rerankerScores: Record<string, number> | null }>}
 *   `rerankerScores` maps each scored chunk id to its score, or is null when nothing was reranked.
 */
export async function retrieveEvidence({
  question,
  queries = [question],
  rerankQuestion = null,
  corpus,
  provider,
  db,
  signal,
  documentIds = null,
  filters = null,
}) {
  const { fused } = await retrieve({
    queries,
    corpus,
    provider,
    db,
    signal,
    documentIds,
    filters,
  });
  let hitIds = fused.slice(0, MAX_HITS).map((f) => f.id);
  let rerankerScores = null;
  let rows;
  if (rerankQuestion && typeof provider.rerank === "function" && fused.length) {
    const candidates = fused.slice(0, RERANK_CANDIDATES).map((f) => f.id);
    const candidateRows = await loadChunks(db, candidates);
    const { ids, scores } = await reranked(
      provider,
      rerankQuestion,
      candidates,
      candidateRows,
      signal,
    );
    signal?.throwIfAborted();
    hitIds = ids.slice(0, MAX_HITS);
    rerankerScores = scores;
    rows = new Map(hitIds.map((id) => [id, candidateRows.get(id)]));
  } else {
    rows = await loadChunks(db, hitIds);
  }
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
  return { fused, blocks, rerankerScores };
}
