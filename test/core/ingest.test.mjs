// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "../../packages/core/ingest/hash.mjs";
import { splitPages } from "../../packages/core/ingest/pdfText.mjs";

describe("splitPages", () => {
  it("splits on form feeds and drops the empty page after the last one", () => {
    expect(splitPages("one\fspan two\f")).toEqual([
      { page: 1, text: "one" },
      { page: 2, text: "span two" },
    ]);
  });

  it("returns one page for text without form feeds", () => {
    expect(splitPages("only")).toEqual([{ page: 1, text: "only" }]);
  });
});

describe("sha256File", () => {
  it("returns the SHA-256 hex digest of the file bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "concordance-"));
    try {
      const file = path.join(dir, "a.bin");
      const bytes = Buffer.from("witness statement\n");
      await writeFile(file, bytes);
      expect(await sha256File(file)).toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
