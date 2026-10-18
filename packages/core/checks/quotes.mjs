// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * Normalises text for quote matching: NFKC, curly quotes and dashes to ASCII,
 * whitespace collapsed, case folded.
 * @param {string} text
 */
export function normaliseForMatch(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the quote appears in the chunk text after normalisation.
 * @param {string} quote
 * @param {string} chunkText
 */
export function verifyQuote(quote, chunkText) {
  const q = normaliseForMatch(quote).replace(/^["']|["']$/g, "");
  if (!q) return false;
  return normaliseForMatch(chunkText).includes(q);
}
