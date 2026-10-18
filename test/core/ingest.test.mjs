// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "../../packages/core/ingest/hash.mjs";
import { splitPages } from "../../packages/core/ingest/pdfText.mjs";
import {
  batches,
  documentMeta,
  parseArgs,
  parseManifest,
  parseSources,
  planChunks,
  readSources,
  toHalfvecLiteral,
} from "../../packages/core/ingest/run.mjs";

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

const ROW = {
  url: "https://example.test/IWS1.pdf",
  sha256: "a".repeat(64),
  bytes: 10,
  fetched_at: "2026-10-18T12:00:00Z",
  licence: "OGL-3.0",
  evidence_id: "IWS1",
};

describe("parseManifest", () => {
  it("reads one row a line and skips blank lines", () => {
    const text = `${JSON.stringify(ROW)}\n\n${JSON.stringify({ ...ROW, evidence_id: "IWS2" })}\n`;
    expect(parseManifest(text).map((r) => r.evidence_id)).toEqual(["IWS1", "IWS2"]);
  });

  it("throws with the line number on invalid JSON", () => {
    expect(() => parseManifest(`${JSON.stringify(ROW)}\n{bad`, "m.jsonl")).toThrow(
      "m.jsonl:2: invalid JSON",
    );
  });

  it("throws on a missing or malformed field", () => {
    expect(() => parseManifest(JSON.stringify({ ...ROW, sha256: "abc" }))).toThrow(/sha256/);
    expect(() => parseManifest(JSON.stringify({ ...ROW, licence: undefined }))).toThrow(/licence/);
  });

  it("throws on a duplicate evidence id", () => {
    expect(() => parseManifest(`${JSON.stringify(ROW)}\n${JSON.stringify(ROW)}`)).toThrow(
      /duplicate IWS1/,
    );
  });
});

describe("sources", () => {
  it("parses entries into a map keyed by evidence id", () => {
    const map = parseSources(
      JSON.stringify([
        { evidence_id: "IWS1", role: "resident", floor: 18, statement_date: "2019-08-06" },
      ]),
    );
    expect(map.get("IWS1")).toMatchObject({ role: "resident", floor: 18 });
  });

  it("rejects a malformed statement date", () => {
    expect(() =>
      parseSources(JSON.stringify([{ evidence_id: "IWS1", statement_date: "6 Aug 2019" }])),
    ).toThrow(/statement_date/);
  });

  it("returns an empty map when the file is absent", async () => {
    expect((await readSources("/nonexistent/sources.json")).size).toBe(0);
  });

  it("builds meta with the floor in the role and the evidence id as the witness id", () => {
    const meta = documentMeta("grenfell", ROW, {
      evidence_id: "IWS1",
      role: "resident",
      floor: 18,
      statement_date: "2019-08-06",
    });
    expect(meta).toMatchObject({
      evidenceId: "IWS1",
      witnessId: "IWS1",
      role: "resident, floor 18",
      statementDate: "2019-08-06",
      sha256: ROW.sha256,
    });
    expect(documentMeta("grenfell", ROW, undefined)).toMatchObject({
      role: null,
      statementDate: null,
    });
  });
});

describe("batches", () => {
  it("splits into groups of the given size with a short last group", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 32)).toEqual([]);
  });

  it("rejects a size below 1", () => {
    expect(() => batches([1], 0)).toThrow(RangeError);
  });
});

describe("toHalfvecLiteral", () => {
  it("formats a vector of the expected length", () => {
    expect(toHalfvecLiteral([0, 0.5, -1], 3)).toBe("[0,0.5,-1]");
  });

  it("throws on a wrong length or a non-finite value", () => {
    expect(() => toHalfvecLiteral([0, 1], 3)).toThrow("embedding has length 2; expected 3");
    expect(() => toHalfvecLiteral([0, NaN, 1], 3)).toThrow(/finite/);
  });
});

describe("planChunks", () => {
  it("locates each level by the start page and paragraph of its section", () => {
    const sections = planChunks([
      { page: 1, text: "WITNESS STATEMENT\n1. I lived on floor 18. I lived alone.\n2. I woke" },
      { page: 2, text: "at 01:00. I smelt smoke." },
    ]);
    expect(sections.map((s) => s.locator)).toEqual([
      { page: 1, paragraph: null },
      { page: 1, paragraph: 1 },
      { page: 1, paragraph: 2 },
    ]);
    expect(sections[2].sentences).toEqual([
      { ordinal: 3, text: "I woke at 01:00.", locator: { page: 1, paragraph: 2 } },
      { ordinal: 4, text: "I smelt smoke.", locator: { page: 1, paragraph: 2 } },
    ]);
    expect(sections.flatMap((s) => s.passages.map((p) => p.ordinal))).toEqual([0, 1, 2]);
  });

  it("throws when no numbered paragraph exists", () => {
    expect(() => planChunks([{ page: 1, text: "A letter with no numbers." }])).toThrow(
      /no numbered paragraph/,
    );
  });
});

describe("parseArgs", () => {
  it("reads --corpus in both forms and rejects unknown arguments", () => {
    expect(parseArgs(["--corpus", "grenfell"])).toEqual({ corpus: "grenfell" });
    expect(parseArgs(["--corpus=grenfell"])).toEqual({ corpus: "grenfell" });
    expect(() => parseArgs([])).toThrow(/--corpus is required/);
    expect(() => parseArgs(["--x"])).toThrow(/unknown argument/);
  });
});
