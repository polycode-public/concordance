// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSIONS = new Set([
  ".mjs",
  ".js",
  ".sh",
  ".sql",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".md",
  ".toml",
]);
const EXEMPT = new Set([
  "LICENSE",
  "docs/SPEC_WITNESS_RESEARCH_TOOL.md",
  "CODENAMES.txt",
  "README.md",
]);
const SKIP_DIRS = new Set(["node_modules", "cdk.out", ".git", "target", "coverage"]);

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = out.split("\n").filter(Boolean);
    if (files.length) return files;
  } catch {
    // No git, or no commits yet: walk the tree instead.
  }
  return walk("");
}

function walk(rel) {
  const out = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || child === ".claude/worktrees") continue;
      out.push(...walk(child));
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}

// A file that must open with YAML front matter (a skill or a rule) carries the
// header in the first five lines after the front matter closes.
function headLines(text) {
  const lines = text.split("\n");
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) return lines.slice(close + 1, close + 6);
  }
  return lines.slice(0, 5);
}

const isExempt = (file) => EXEMPT.has(file) || /^corpora\/[^/]+\/raw\//.test(file);

describe("licence headers", () => {
  it("every source file carries the AGPL SPDX identifier in its first five lines", () => {
    const files = trackedFiles().filter((f) => EXTENSIONS.has(path.extname(f)) && !isExempt(f));
    expect(files.length).toBeGreaterThan(0);
    const missing = files.filter((f) => {
      const head = headLines(readFileSync(path.join(root, f), "utf8")).join("\n");
      return !head.includes("SPDX-License-Identifier: AGPL-3.0-only");
    });
    expect(missing).toEqual([]);
  });
});
