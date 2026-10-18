// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Extracts text per page from a born-digital PDF with pdftotext -layout.
 * @param {string} path
 * @returns {Promise<{ page: number, text: string }[]>}
 */
export async function pdfToPages(path) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("pdftotext", ["-layout", path, "-"], {
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf8",
    }));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("pdftotext is not installed; run: brew install poppler", { cause: err });
    }
    throw new Error(`pdftotext failed for ${path}: ${err.stderr || err.message}`, { cause: err });
  }
  return splitPages(stdout);
}

/**
 * Splits pdftotext output on form feeds. The trailing form feed after the
 * last page does not make an extra page.
 * @param {string} text
 */
export function splitPages(text) {
  const parts = text.split("\f");
  if (parts.length > 1 && parts.at(-1).trim() === "") parts.pop();
  return parts.map((pageText, i) => ({ page: i + 1, text: pageText }));
}

let pdfjsReady;
const loadPdfjs = () =>
  (pdfjsReady ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    // The fake worker otherwise loads its module from a path at run time, which a Lambda
    // bundle does not carry; a worker handler on globalThis is taken first.
    globalThis.pdfjsWorker ??= worker;
    return pdfjs;
  })());

/** The text extractor recorded in provenance for pdfToPagesFromBuffer(). */
export async function pdfjsTool() {
  return { tool: "pdfjs-dist", version: (await loadPdfjs()).version };
}

/**
 * Rebuilds the lines of one page from pdf.js text items. Items whose baselines are within
 * half a font height share a line; a line is ordered by x and read top to bottom. A gap
 * wider than a fifth of the font height between two items is a space.
 * @param {{ str: string, transform: number[], width: number, height: number }[]} items
 */
export function itemsToText(items) {
  const lines = [];
  const sorted = items
    .filter((item) => typeof item.str === "string" && item.str.length > 0)
    .map((item) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      size: Math.abs(item.height) || Math.abs(item.transform[3]) || 1,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - item.y) <= Math.max(line.size, item.size) / 2) {
      line.items.push(item);
    } else {
      lines.push({ y: item.y, size: item.size, items: [item] });
    }
  }
  return lines
    .map(({ items: lineItems }) => {
      lineItems.sort((a, b) => a.x - b.x);
      let text = "";
      let end = null;
      for (const item of lineItems) {
        const gap = end === null ? 0 : item.x - end;
        if (end !== null && gap > item.size / 5 && !/\s$/.test(text) && !/^\s/.test(item.str)) {
          text += " ";
        }
        text += item.str;
        end = item.x + item.width;
      }
      return text.trimEnd();
    })
    .join("\n");
}

/**
 * Extracts text per page from a born-digital PDF held in memory, with pdf.js. Runs where
 * the pdftotext binary is absent (a Lambda zip bundle).
 * @param {Uint8Array} buffer
 * @returns {Promise<{ page: number, text: string }[]>}
 */
export async function pdfToPagesFromBuffer(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({ page: n, text: itemsToText(content.items) });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
