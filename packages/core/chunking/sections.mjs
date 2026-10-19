// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

const NUMBERED = /^\s*(\d{1,3})\.\s/;
export const MAX_SECTION_CHARS = 6000;
const SENTENCE_END = /[.!?]["')\]]?\s/g;

const normalise = (text) => text.replace(/\s+/g, " ").trim();

function cutLong(text) {
  const parts = [];
  let rest = text;
  while (rest.length > MAX_SECTION_CHARS) {
    const window = rest.slice(0, MAX_SECTION_CHARS + 1);
    let at = -1;
    for (const match of window.matchAll(SENTENCE_END)) {
      if (match.index + 1 <= MAX_SECTION_CHARS) at = match.index + 1;
    }
    if (at <= 0) at = window.lastIndexOf(" ");
    if (at <= 0) at = MAX_SECTION_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Splits unnumbered text at blank lines into parts of at most MAX_SECTION_CHARS. */
function partsOfUnnumbered(lines) {
  const blocks = [];
  let block = [];
  for (const line of [...lines, ""]) {
    if (line.trim() === "") {
      const text = normalise(block.join(" "));
      if (text) blocks.push(text);
      block = [];
    } else {
      block.push(line);
    }
  }
  const parts = [];
  let packed = "";
  for (const text of blocks.flatMap(cutLong)) {
    if (packed && packed.length + 1 + text.length > MAX_SECTION_CHARS) {
      parts.push(packed);
      packed = text;
    } else {
      packed = packed ? `${packed} ${text}` : text;
    }
  }
  if (packed) parts.push(packed);
  return parts;
}

/**
 * Splits statement pages into sections. A numbered paragraph ("1. ", "2. ", ...) starts
 * when its number is the next in sequence, so a numbered list inside a paragraph stays in
 * that paragraph. It ends at the next numbered paragraph, or at a page boundary once it has
 * run past its first page and the next page would take it over MAX_SECTION_CHARS. Text without a paragraph number
 * (before the first, or after a paragraph was cut) becomes one section per page with
 * paragraph null; a page over MAX_SECTION_CHARS splits at blank lines, then at sentence ends.
 * @param {(string | { page: number, text: string })[]} pageTexts
 * @returns {{ paragraph: number | null, page: number, text: string }[]}
 */
export function splitNumberedParagraphs(pageTexts) {
  const out = [];
  let current = null;
  let lastNumber = null;
  const flush = () => {
    if (!current) return;
    if (current.paragraph === null) {
      for (const text of partsOfUnnumbered(current.lines)) {
        out.push({ paragraph: null, page: current.page, text });
      }
    } else {
      const text = normalise(current.lines.join(" "));
      if (text) out.push({ paragraph: current.paragraph, page: current.page, text });
    }
    current = null;
  };
  pageTexts.forEach((entry, i) => {
    const page = typeof entry === "string" ? i + 1 : entry.page;
    const text = typeof entry === "string" ? entry : entry.text;
    if (current && current.page !== page) {
      const cut =
        current.paragraph === null ||
        (current.lastPage > current.page && current.chars + text.length > MAX_SECTION_CHARS);
      if (cut) flush();
      else current.lastPage = page;
    }
    for (const line of text.split("\n")) {
      const match = NUMBERED.exec(line);
      const number = match ? Number(match[1]) : null;
      const startsParagraph = number !== null && (lastNumber === null || number === lastNumber + 1);
      if (startsParagraph) {
        flush();
        lastNumber = number;
        const first = line.replace(NUMBERED, "");
        current = { paragraph: number, page, lastPage: page, lines: [first], chars: first.length };
      } else {
        current ??= { paragraph: null, page, lastPage: page, lines: [], chars: 0 };
        current.lines.push(line);
        current.chars += line.length + 1;
      }
    }
  });
  flush();
  return out;
}
