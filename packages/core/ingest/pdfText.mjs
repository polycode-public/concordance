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
