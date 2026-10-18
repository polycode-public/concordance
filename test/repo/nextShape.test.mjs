// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nextPath = path.join(root, "NEXT.md");
const present = existsSync(nextPath);

const HEADINGS = [
  "## In flight",
  "## Machine-only",
  "## Machine-ask",
  "## Human-driven",
  "## Blocked",
  "## Discipline",
];
const ROW_END =
  /\*\*Size\*\* ~?\d+ files?\. \*\*Model\*\* (Fable|Opus|Sonnet|Haiku|operator)\.( .*)?$/;

if (!present) console.log("NEXT.md is not present; skipping its shape checks");

describe.skipIf(!present)("NEXT.md shape", () => {
  const lines = present ? readFileSync(nextPath, "utf8").split("\n") : [];

  it("has exactly the six level-2 headings in order", () => {
    expect(lines.filter((l) => /^## /.test(l)).map((l) => l.trimEnd())).toEqual(HEADINGS);
  });

  it("ends every row with its size in files and its model", () => {
    const bad = lines.filter((l) => l.startsWith("- [ ] **") && !ROW_END.test(l.trimEnd()));
    expect(bad).toEqual([]);
  });
});
