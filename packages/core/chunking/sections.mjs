// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// A paragraph number ends in a dot, or in the comma that OCR reads in its place ("3, I was").
// The dot is followed by a space, by the end of the line, or by the character that OCR reads in
// place of the capital I that opens the sentence ("12.1 opened", "19.} had").
const NUMBERED = /^\s*(\d{1,3})(?:\.(?:\s|$|1\s|[^\s\d.])|,\s+[^\s\d])/;
const NUMBER_PREFIX = /^\s*\d{1,3}[.,]/;
// OCR drops or misreads some paragraph numbers, so the next number may skip ahead by this much.
export const MAX_NUMBER_SKIP = 4;
export const MAX_SECTION_CHARS = 6000;
// A statement page ends with its footer: a page number, the witness name and the reference, in
// whatever order and line breaks the PDF gives them ("Behailu Kebede 1" / "IWS00000490 0001").
const REFERENCE = /(IWS\d{8})[ _]\d{4}\s*$/;
const NAME_LINE = /^[\p{L}'’-]+(?: [\p{L}'’-]+){1,3}$/u;
const PAGE_NUMBER_LINE = /^(?:\d{1,3}|Page \d{1,3} of \d{1,3})$/;
const SIGNATURE_LINE = /\b(?:Signed|Dated)\b/;
const MAX_FOOTER_LINES = 3;
const MAX_HEADING_CHARS = 60;
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

const nonBlank = (lines) => {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return end;
};

/** The reference and the witness name that the first page's footer shows, or null. */
function learnFooter(pageLines) {
  const end = nonBlank(pageLines);
  const match = end > 0 ? REFERENCE.exec(pageLines[end - 1]) : null;
  if (!match) return null;
  let name = null;
  for (let i = end - 2; i >= Math.max(0, end - 1 - MAX_FOOTER_LINES); i--) {
    const candidate = pageLines[i].trim().replace(/\s+\d{1,3}$/, "");
    if (NAME_LINE.test(candidate)) {
      name = candidate.toLowerCase();
      break;
    }
  }
  return { reference: match[1], name };
}

/** Drops the footer lines that end a page, only when the reference is the one learnt. */
function dropFooter(lines, footer) {
  const end = nonBlank(lines);
  if (!footer || end === 0) return lines;
  const last = REFERENCE.exec(lines[end - 1]);
  if (!last || last[1] !== footer.reference) return lines;
  let start = end - 1;
  while (start > 0 && end - start <= MAX_FOOTER_LINES) {
    const line = lines[start - 1].trim();
    const isName = footer.name && line.toLowerCase().replace(/\s+\d{1,3}$/, "") === footer.name;
    if (!isName && !PAGE_NUMBER_LINE.test(line)) break;
    start--;
  }
  return lines.slice(0, start);
}

const isHeadingShape = (line) => {
  const text = line.trim();
  return (
    text.length > 1 &&
    text.length < MAX_HEADING_CHARS &&
    /^[\p{Lu}\d]/u.test(text) &&
    !/[.,;:!?]$/.test(text) &&
    !NUMBERED.test(text)
  );
};

/**
 * Splits statement pages into sections. A numbered paragraph ("1. ", "2. ", ...) starts
 * when its number is the next in sequence, so a numbered list inside a paragraph stays in
 * that paragraph. It ends at the next numbered paragraph, or at a page boundary once it has
 * run past its first page and the next page would take it over MAX_SECTION_CHARS. Text without a paragraph number
 * (before the first, or after a paragraph was cut) becomes one section per page with
 * paragraph null; a page over MAX_SECTION_CHARS splits at blank lines, then at sentence ends.
 * The footer of each page is left out once the first page shows its pattern. A short line
 * without end punctuation that sits right before a numbered paragraph becomes that
 * paragraph's heading; a page number, a signature line or the witness name there is dropped.
 * @param {(string | { page: number, text: string })[]} pageTexts
 * @returns {{ paragraph: number | null, page: number, text: string, heading?: string }[]}
 */
export function splitNumberedParagraphs(pageTexts) {
  const pages = pageTexts.map((entry, i) => ({
    page: typeof entry === "string" ? i + 1 : entry.page,
    lines: (typeof entry === "string" ? entry : entry.text).split("\n"),
  }));
  const footer = pages.length ? learnFooter(pages[0].lines) : null;
  const flat = [];
  for (const { page, lines } of pages) {
    const kept = dropFooter(lines, footer);
    const chars = kept.join("\n").length;
    kept.forEach((text, i) => flat.push({ page, text, chars, first: i === 0 }));
  }

  const isFurniture = (line) => {
    const text = line.trim();
    const name = text.replace(/\s+\d{1,3}$/, "").toLowerCase();
    return PAGE_NUMBER_LINE.test(text) || SIGNATURE_LINE.test(text) || name === footer?.name;
  };

  const out = [];
  let current = null;
  let lastNumber = null;
  let pendingHeading = null;
  const startsParagraph = (line) => {
    const match = NUMBERED.exec(line);
    if (!match) return false;
    const number = Number(match[1]);
    return lastNumber === null || (number > lastNumber && number <= lastNumber + MAX_NUMBER_SKIP);
  };
  const flush = () => {
    if (!current) return;
    if (current.paragraph === null) {
      for (const text of partsOfUnnumbered(current.lines)) {
        out.push({ paragraph: null, page: current.page, text });
      }
    } else {
      const text = normalise(current.lines.join(" "));
      if (text) {
        const section = { paragraph: current.paragraph, page: current.page, text };
        if (current.heading) section.heading = current.heading;
        out.push(section);
      } else {
        pendingHeading = current.heading ?? pendingHeading;
      }
    }
    current = null;
  };
  let lastPage = null;
  flat.forEach((item, i) => {
    const { page, text: line } = item;
    if (page !== lastPage) {
      lastPage = page;
      if (current && current.page !== page) {
        const cut =
          current.paragraph === null ||
          (current.lastPage > current.page && current.chars + item.chars > MAX_SECTION_CHARS);
        if (cut) flush();
        else current.lastPage = page;
      }
    }
    if (startsParagraph(line)) {
      flush();
      lastNumber = Number(NUMBERED.exec(line)[1]);
      const first = line.replace(NUMBER_PREFIX, "");
      current = {
        paragraph: lastNumber,
        page,
        lastPage: page,
        lines: [first],
        chars: first.length,
        heading: pendingHeading,
      };
      pendingHeading = null;
      return;
    }
    if (isHeadingShape(line) || PAGE_NUMBER_LINE.test(line.trim())) {
      let next = i + 1;
      while (next < flat.length && flat[next].text.trim() === "") next++;
      if (next < flat.length && startsParagraph(flat[next].text)) {
        flush();
        if (!isFurniture(line)) pendingHeading = line.trim();
        return;
      }
    }
    current ??= { paragraph: null, page, lastPage: page, lines: [], chars: 0 };
    current.lines.push(line);
    current.chars += line.length + 1;
  });
  flush();
  return out;
}
