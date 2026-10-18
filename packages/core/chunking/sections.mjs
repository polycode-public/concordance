// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

const NUMBERED = /^\s*(\d{1,3})\.\s/;

/**
 * Splits statement pages into numbered paragraphs ("1. ", "2. ", ...). A line
 * starts a new paragraph only when its number is the next in sequence, so a
 * numbered list inside a paragraph stays in that paragraph. Text before the
 * first numbered paragraph is returned with paragraph null.
 * @param {(string | { page: number, text: string })[]} pageTexts
 * @returns {{ paragraph: number | null, page: number, text: string }[]}
 */
export function splitNumberedParagraphs(pageTexts) {
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ paragraph: current.paragraph, page: current.page, text });
  };
  pageTexts.forEach((entry, i) => {
    const page = typeof entry === "string" ? i + 1 : entry.page;
    const text = typeof entry === "string" ? entry : entry.text;
    for (const line of text.split("\n")) {
      const match = NUMBERED.exec(line);
      const number = match ? Number(match[1]) : null;
      const expected = current?.paragraph == null ? null : current.paragraph + 1;
      const startsParagraph =
        number !== null && (expected === null ? current?.paragraph == null : number === expected);
      if (startsParagraph) {
        flush();
        current = { paragraph: number, page, lines: [line.replace(NUMBERED, "")] };
      } else {
        current ??= { paragraph: null, page, lines: [] };
        current.lines.push(line);
      }
    }
  });
  flush();
  return out;
}
