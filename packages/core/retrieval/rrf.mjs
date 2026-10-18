// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * Reciprocal rank fusion: each id scores the sum of 1 / (k + rank) over the
 * rankings it appears in (rank starts at 1). Ties keep first-seen order.
 * @param {Array<Array<string | number>>} rankings
 * @param {{ k?: number }} [options]
 * @returns {{ id: string | number, score: number }[]}
 */
export function reciprocalRankFusion(rankings, { k = 60 } = {}) {
  const scores = new Map();
  for (const ranking of rankings) {
    const seen = new Set();
    ranking.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score], order) => ({ id, score, order }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ id, score }) => ({ id, score }));
}
