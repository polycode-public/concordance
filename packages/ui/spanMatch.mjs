// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Finds a cited sentence in the text items of a PDF page, so the viewer can mark it. Matching
// works on words: case, punctuation and the breaks between items do not count.

const MIN_RUN = 3;
const SENTENCE_WORDS = 6;

const wordsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The first sentence of an evidence block's text, extended by the next sentences until it holds
 * enough words to be found in a page.
 * @param {string} text
 */
export function firstSentence(text) {
  const sentences = String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let out = "";
  for (const sentence of sentences) {
    out = out ? `${out} ${sentence}` : sentence;
    if (wordsOf(out).length >= SENTENCE_WORDS) break;
  }
  return out;
}

/**
 * The items that hold the longest run of the sentence's words that also runs unbroken through the
 * page's words. A run shorter than three words (or than the sentence, when that is shorter) is no
 * match.
 * @param {(string | { str: string })[]} items text items in reading order
 * @param {string} sentence
 * @returns {number[]} ascending item indices; empty when nothing matches
 */
export function matchSpan(items, sentence) {
  const target = wordsOf(sentence);
  const page = [];
  const owner = [];
  items.forEach((item, index) => {
    for (const word of wordsOf(typeof item === "string" ? item : (item?.str ?? ""))) {
      page.push(word);
      owner.push(index);
    }
  });
  if (!target.length || !page.length) return [];
  let best = 0;
  let end = 0;
  let previous = new Array(target.length + 1).fill(0);
  for (let i = 1; i <= page.length; i++) {
    const row = new Array(target.length + 1).fill(0);
    for (let j = 1; j <= target.length; j++) {
      if (page[i - 1] !== target[j - 1]) continue;
      row[j] = previous[j - 1] + 1;
      if (row[j] > best) {
        best = row[j];
        end = i;
      }
    }
    previous = row;
  }
  if (best < Math.min(MIN_RUN, target.length)) return [];
  return [...new Set(owner.slice(end - best, end))];
}

/**
 * The box of a text item in viewport pixels: left, top, width, height.
 * @param {number[]} viewportTransform the viewport's 6-number matrix
 * @param {{ transform: number[], width: number, height: number }} item
 * @param {number} scale the viewport's scale
 */
export function itemBox(viewportTransform, item, scale) {
  const [a, b, c, d, e, f] = viewportTransform;
  const [, , ic, id, ie, ifx] = item.transform;
  const x = a * ie + c * ifx + e;
  const y = b * ie + d * ifx + f;
  const width = item.width * scale;
  const height = (item.height || Math.hypot(ic, id)) * scale;
  return { left: x, top: y - height, width, height };
}
