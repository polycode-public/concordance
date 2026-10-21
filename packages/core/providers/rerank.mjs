// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The model reranker: the extraction model scores each fused candidate against the question, ten
// passages to one extractJson call.
import { rerankPrompt } from "../prompt.mjs";
import { InvalidReplyError } from "./jsonReply.mjs";

/** The passages one extraction call scores. */
export const RERANK_BATCH = 10;

/** The fused candidates the reranker scores. */
export const RERANK_CANDIDATES = 40;

export const MAX_RERANK_SCORE = 3;

export const RERANK_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          passage: { type: "integer", minimum: 1 },
          score: { type: "integer", minimum: 0, maximum: MAX_RERANK_SCORE },
        },
        required: ["passage", "score"],
      },
    },
  },
  required: ["scores"],
});

/**
 * The scores of one batch in passage order. Throws unless every passage has exactly one integer
 * score from 0 to MAX_RERANK_SCORE.
 * @param {unknown} reply
 * @param {number} count
 */
export function batchScores(reply, count) {
  const scores = new Array(count).fill(null);
  const entries = Array.isArray(reply?.scores) ? reply.scores : [];
  for (const entry of entries) {
    const n = entry?.passage;
    const score = entry?.score;
    if (!Number.isInteger(n) || n < 1 || n > count || scores[n - 1] !== null) {
      throw new InvalidReplyError(`the reranker named passage ${JSON.stringify(n)} of ${count}`);
    }
    if (!Number.isInteger(score) || score < 0 || score > MAX_RERANK_SCORE) {
      throw new InvalidReplyError(
        `the reranker gave passage ${n} the score ${JSON.stringify(score)}`,
      );
    }
    scores[n - 1] = score;
  }
  const missing = scores.findIndex((s) => s === null);
  if (missing >= 0) {
    throw new InvalidReplyError(`the reranker gave passage ${missing + 1} of ${count} no score`);
  }
  return scores;
}

/**
 * A rerank function over a provider's extractJson: the passages go to the extraction model in
 * batches of RERANK_BATCH, all batches at once.
 * @param {{ extractJson: Function }} provider
 * @returns {(question: string, passages: { id: string, header?: string | null, text: string }[],
 *   options?: { signal?: AbortSignal }) => Promise<{ id: string, score: number }[]>}
 *   One score per passage, in passage order.
 */
export function modelReranker(provider) {
  return async function rerank(question, passages, { signal } = {}) {
    const batches = [];
    for (let i = 0; i < passages.length; i += RERANK_BATCH) {
      batches.push(passages.slice(i, i + RERANK_BATCH));
    }
    const scored = await Promise.all(
      batches.map(async (batch) => {
        const reply = await provider.extractJson({
          prompt: rerankPrompt(question, batch),
          schema: RERANK_SCHEMA,
          signal,
        });
        return batchScores(reply, batch.length);
      }),
    );
    return scored.flat().map((score, i) => ({ id: passages[i].id, score }));
  };
}
