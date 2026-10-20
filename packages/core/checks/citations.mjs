// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { splitSentences } from "../chunking/sentences.mjs";

const TAG = /\[E(\d+(?:\s*,\s*E?\d+)*)\]/g;
const LEADING = /^((?:\[E\d+(?:\s*,\s*E?\d+)*\]\s*)+)(.*)$/s;

const BULLET = /^(?:[-*\u2022]|\d+[.)])\s+/;

/**
 * Splits a model answer into sentences. Every line is its own run of text, so
 * a paragraph, a bullet and a colon-ended lead each start a sentence even when
 * the closing citation tag stands where the full stop would. Tags written after
 * the full stop ("... the stairs. [E3]") stay with the sentence they follow.
 * @param {string} text
 * @returns {string[]}
 */
export function splitAnswerSentences(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const body = line.trim().replace(BULLET, "");
    for (const sentence of splitSentences(body)) {
      const leading = LEADING.exec(sentence);
      if (leading && out.length) {
        out[out.length - 1] += ` ${leading[1].trim()}`;
        if (leading[2].trim()) out.push(leading[2].trim());
      } else {
        out.push(sentence);
      }
    }
  }
  return out;
}

/**
 * Returns the evidence numbers cited in a sentence, in order, without repeats.
 * @param {string} sentence
 * @returns {number[]}
 */
export function citationTags(sentence) {
  const tags = [];
  for (const match of sentence.matchAll(TAG)) {
    for (const part of match[1].split(",")) {
      const n = Number(part.replace(/\D/g, ""));
      if (!tags.includes(n)) tags.push(n);
    }
  }
  return tags;
}

/**
 * Flags every sentence without at least one [En] tag.
 * @param {string} answerText
 */
export function markUnsupported(answerText) {
  const sentences = splitAnswerSentences(answerText).map((text) => {
    const tags = citationTags(text);
    return { text, tags, supported: tags.length > 0 };
  });
  const supported = sentences.filter((s) => s.supported).length;
  const flaggedRatio = sentences.length ? (sentences.length - supported) / sentences.length : 0;
  return { sentences, supported, total: sentences.length, flaggedRatio };
}
