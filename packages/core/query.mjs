// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The query pipeline: rewrite, hybrid retrieval, rerank, expand, answer, check.

/**
 * Runs one question through the full pipeline. It takes
 * { question, provider, db, signal } and resolves to the shape below.
 * @returns {Promise<{ answer: string, abstained: boolean,
 *   citations: { evidence: number, locator: unknown }[],
 *   checks: { sentences: number, supported: number, flaggedRatio: number } }>}
 */
export async function runQuery() {
  throw new Error("runQuery is not built: the query pipeline has no retrieval yet");
}
