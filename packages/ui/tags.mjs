// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/** One bracket of evidence numbers: [E3], [E3, E4] or [E3, 4]. */
export const TAG = /\[E(\d+(?:\s*,\s*E?\d+)*)\]/g;

/**
 * The evidence numbers in one TAG match, in order.
 * @param {RegExpMatchArray} match
 * @returns {number[]}
 */
export function tagNumbers(match) {
  return match[1].split(",").map((part) => Number(part.replace(/\D/g, "")));
}
