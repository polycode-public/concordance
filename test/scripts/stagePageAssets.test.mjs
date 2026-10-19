// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAGE_ASSETS, stagePageAssets } from "../../scripts/stage-page-assets.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "page-assets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("stagePageAssets", () => {
  it("names the pdf.js build, its image decoders and the fonts", () => {
    expect(Object.keys(PAGE_ASSETS)).toEqual(
      expect.arrayContaining([
        "vendor/pdf.min.mjs",
        "vendor/pdf.worker.min.mjs",
        "vendor/wasm/openjpeg.wasm",
        "vendor/wasm/jbig2.wasm",
      ]),
    );
    for (const source of Object.values(PAGE_ASSETS)) expect(existsSync(source)).toBe(true);
  });

  it("copies every asset to its served path", () => {
    stagePageAssets(dir);
    for (const served of Object.keys(PAGE_ASSETS)) {
      expect(statSync(path.join(dir, served)).size).toBeGreaterThan(0);
    }
    expect(readdirSync(path.join(dir, "vendor", "wasm")).sort()).toEqual([
      "jbig2.wasm",
      "openjpeg.wasm",
    ]);
  });
});
