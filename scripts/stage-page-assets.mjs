// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The third-party files the page loads from its own origin: PDF.js under /vendor/ and the
// faces under /fonts/. The laptop server resolves them from node_modules; the app stack
// copies them into .page-assets/ and deploys that directory beside the page.
//
//   node scripts/stage-page-assets.mjs

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STAGE_DIR = path.join(ROOT, ".page-assets");

const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const pdfBuild = path.join(packageDir("pdfjs-dist"), "build");
const sansFiles = path.join(packageDir("@fontsource/source-sans-3"), "files");
const serifFiles = path.join(packageDir("@fontsource/source-serif-4"), "files");

/** Each served path (no leading slash) and the file in node_modules behind it. */
export const PAGE_ASSETS = {
  "vendor/pdf.min.mjs": path.join(pdfBuild, "pdf.min.mjs"),
  "vendor/pdf.worker.min.mjs": path.join(pdfBuild, "pdf.worker.min.mjs"),
  "fonts/source-sans-3-latin-400-normal.woff2": path.join(
    sansFiles,
    "source-sans-3-latin-400-normal.woff2",
  ),
  "fonts/source-sans-3-latin-600-normal.woff2": path.join(
    sansFiles,
    "source-sans-3-latin-600-normal.woff2",
  ),
  "fonts/source-serif-4-latin-400-normal.woff2": path.join(
    serifFiles,
    "source-serif-4-latin-400-normal.woff2",
  ),
};

/** Replaces `dir` with a copy of every page asset at its served path. */
export function stagePageAssets(dir = STAGE_DIR) {
  rmSync(dir, { recursive: true, force: true });
  for (const [served, source] of Object.entries(PAGE_ASSETS)) {
    const target = path.join(dir, served);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`staged ${Object.keys(PAGE_ASSETS).length} files in ${stagePageAssets()}`);
}
