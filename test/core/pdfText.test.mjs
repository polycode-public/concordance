// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  itemsToText,
  pdfjsTool,
  pdfToPagesFromBuffer,
} from "../../packages/core/ingest/pdfText.mjs";
import { splitNumberedParagraphs } from "../../packages/core/chunking/sections.mjs";

/**
 * A minimal PDF: one Helvetica font and one page for each entry, each line a run of
 * `[x, y, text]` shown with Tj.
 * @param {[number, number, string][][]} pages
 */
function buildPdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pagesId = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = pages.map((runs) => {
    const stream = runs
      .map(([x, y, text]) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const STATEMENT = buildPdf([
  [
    [72, 720, "WITNESS STATEMENT"],
    [72, 690, "1."],
    [100, 690, "I lived on the eighteenth floor."],
    [100, 675, "My flat faced east."],
    [72, 650, "2."],
    [100, 650, "I woke at 01:10."],
  ],
  [
    [100, 720, "I smelt smoke."],
    [72, 700, "3."],
    [100, 700, "I left at 01:20."],
  ],
]);

describe("pdfToPagesFromBuffer", () => {
  it("returns one entry for each page with its lines top to bottom", async () => {
    const pages = await pdfToPagesFromBuffer(STATEMENT);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0].text.split("\n")).toEqual([
      "WITNESS STATEMENT",
      "1. I lived on the eighteenth floor.",
      "My flat faced east.",
      "2. I woke at 01:10.",
    ]);
    expect(pages[1].text).toContain("3. I left at 01:20.");
  });

  it("gives text the paragraph splitter numbers", async () => {
    const sections = splitNumberedParagraphs(await pdfToPagesFromBuffer(STATEMENT));
    expect(sections.map((s) => [s.paragraph, s.page])).toEqual([
      [null, 1],
      [1, 1],
      [2, 1],
      [3, 2],
    ]);
    expect(sections[2].text).toBe("I woke at 01:10. I smelt smoke.");
  });

  it("throws on bytes that are not a PDF", async () => {
    await expect(pdfToPagesFromBuffer(Buffer.from("not a pdf"))).rejects.toThrow();
  });

  it("names pdfjs-dist and its version as the tool", async () => {
    expect(await pdfjsTool()).toEqual({
      tool: "pdfjs-dist",
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });
});

describe("itemsToText", () => {
  const item = (str, x, y, width = str.length * 6) => ({
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
  });

  it("joins fragments without a gap and spaces fragments with one", () => {
    expect(
      itemsToText([item("smo", 72, 700, 18), item("ke", 90, 700), item("rose", 110, 701)]),
    ).toBe("smoke rose");
  });

  it("orders lines top to bottom and items left to right", () => {
    expect(itemsToText([item("second", 72, 680), item("b", 120, 700), item("a", 72, 700)])).toBe(
      "a b\nsecond",
    );
  });
});
