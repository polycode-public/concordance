// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * Groups sentences into overlapping passages. The final window always reaches
 * the last sentence, so no sentence is left out. sentenceEnd is inclusive.
 * @param {string[]} sentences
 * @param {{ window?: number, stride?: number }} [options]
 * @returns {{ ordinal: number, sentenceStart: number, sentenceEnd: number, text: string }[]}
 */
export function slidingPassages(sentences, { window = 4, stride = 2 } = {}) {
  if (!Number.isInteger(window) || window < 1) throw new RangeError("window must be >= 1");
  if (!Number.isInteger(stride) || stride < 1) throw new RangeError("stride must be >= 1");
  const out = [];
  for (let start = 0; start < sentences.length; start += stride) {
    const end = Math.min(start + window, sentences.length);
    out.push({
      ordinal: out.length,
      sentenceStart: start,
      sentenceEnd: end - 1,
      text: sentences.slice(start, end).join(" "),
    });
    if (end >= sentences.length) break;
  }
  return out;
}
