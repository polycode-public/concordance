// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// Words that end with a full stop but do not end a sentence (compared lower-case,
// without the full stop).
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "no",
  "nos",
  "para",
  "paras",
  "p",
  "pp",
  "fig",
  "vol",
  "ch",
  "cf",
  "vs",
  "v",
  "jr",
  "sr",
  "capt",
  "sgt",
  "insp",
  "supt",
  "lt",
  "col",
  "cllr",
  "approx",
  "ref",
  "tel",
  "e.g",
  "i.e",
  "etc",
]);

// A candidate boundary: terminal punctuation, optional closing quotes or
// brackets, whitespace, then something that can start a sentence.
const BOUNDARY = /([.!?])(["'”’)\]]*)\s+(?=["'“‘([]?[A-Z0-9])/g;

/**
 * Splits English statement text into sentences. Whitespace is collapsed.
 * Titles (Mr., Dr.), references (No., para.), single initials, decimals and
 * times (01:15, 3.5) do not end a sentence.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return [];
  const out = [];
  let start = 0;
  for (const match of flat.matchAll(BOUNDARY)) {
    const punctEnd = match.index + 1;
    if (match[1] === "." && isAbbreviation(flat.slice(start, match.index))) continue;
    const end = punctEnd + match[2].length;
    out.push(flat.slice(start, end).trim());
    start = match.index + match[0].length;
  }
  const rest = flat.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function isAbbreviation(before) {
  const word = /(\S+)$/.exec(before)?.[1] ?? "";
  const bare = word.replace(/^["'“‘([]+/, "").toLowerCase();
  if (ABBREVIATIONS.has(bare)) return true;
  // A single initial such as "J." in "J. Smith".
  return /^[a-z]$/.test(bare) && /^[A-Z]$/.test(word.replace(/^["'“‘([]+/, ""));
}
