// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * One bracket of evidence numbers: [E3], [E3, E4], [E3, 4], or a range such as [E13-E30] or
 * [E13-E30, E44]. The same grammar is in packages/core/checks/citations.mjs, because the page
 * and the server must read the same numbers from an answer.
 */
export const TAG = /\[E(\d+(?:\s*[-\u2013]\s*E?\d+)?(?:\s*,\s*E?\d+(?:\s*[-\u2013]\s*E?\d+)?)*)\]/g;

/** A range wider than this many numbers reads as its two ends. */
export const MAX_RANGE = 100;

/**
 * The evidence numbers in one TAG match, in order.
 * @param {RegExpMatchArray} match
 * @returns {number[]}
 */
export function tagNumbers(match) {
  return match[1].split(",").flatMap((part) => {
    const [from, to] = part.match(/\d+/g).map(Number);
    if (to === undefined) return [from];
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    if (high - low >= MAX_RANGE) return [from, to];
    return Array.from({ length: high - low + 1 }, (_, i) => low + i);
  });
}
