// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toDataApiParameter, toNamedParameters } from "../../packages/core/db.mjs";
import { sha256File } from "../../packages/core/ingest/hash.mjs";
import { splitPages } from "../../packages/core/ingest/pdfText.mjs";
import {
  batches,
  documentMeta,
  ingestDocument,
  LEVEL_BATCH_BYTES,
  levelBatches,
  parseArgs,
  parseManifest,
  parseSources,
  planChunks,
  readSources,
  toHalfvecLiteral,
} from "../../packages/core/ingest/run.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";

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

  it("writes five significant digits a value, within fp16 tolerance of the input", () => {
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i + 0.123456789) / 7);
    vector[0] = 1.23456789e-5;
    vector[1] = -9.87654321e-8;
    const literal = toHalfvecLiteral(vector, 1024);
    expect(literal.length).toBeLessThan(10 * 1024);
    const values = literal.slice(1, -1).split(",").map(Number.parseFloat);
    expect(values).toHaveLength(1024);
    values.forEach((value, i) => {
      expect(Math.abs(value - vector[i])).toBeLessThanOrEqual(Math.abs(vector[i]) * 1e-4);
    });
    expect(literal).toMatch(/^\[0\.000012346,-9\.8765e-8,/);
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

/** A database that records every statement and answers the ingest's queries. */
function recordingDb() {
  const statements = [];
  let nextId = 1;
  const query = async (text, params = []) => {
    statements.push({ text, params });
    if (/INSERT INTO chunks/.test(text)) {
      return { rows: params[5].map((ordinal) => ({ id: String(nextId++), ordinal })) };
    }
    return { rows: [] };
  };
  return {
    statements,
    query,
    pool: { connect: async () => ({ query, release: () => {} }) },
  };
}

const dataApiRequestBytes = ({ text, params }) =>
  Buffer.byteLength(
    JSON.stringify({
      resourceArn: "arn:aws:rds:eu-west-2:111111111111:cluster:concordance",
      secretArn: "arn:aws:secretsmanager:eu-west-2:111111111111:secret:concordance-AbCdEf",
      database: "concordance",
      sql: toNamedParameters(text),
      parameters: params.map((value, i) => toDataApiParameter(`p${i + 1}`, value)),
      includeResultMetadata: true,
      formatRecordsAs: "JSON",
      transactionId: "x".repeat(200),
    }),
  );

describe("ingestDocument statements", () => {
  const paragraphs = 30;
  const pages = [
    {
      page: 1,
      text: Array.from(
        { length: paragraphs },
        (_, i) => `${i + 1}. I saw smoke on floor ${i + 1} at 01:${String(i).padStart(2, "0")}.`,
      ).join("\n"),
    },
  ];
  const meta = {
    evidenceId: "IWS1",
    corpus: "grenfell",
    sourceUrl: "https://example.test/IWS1.pdf",
    fetchedAt: "2026-10-18T12:00:00Z",
    sha256: "c".repeat(64),
    licence: "OGL-3.0",
    witnessId: "IWS1",
    role: null,
    statementDate: "2019-08-06",
  };
  const run = async () => {
    const db = recordingDb();
    const provider = createFakeProvider({
      tokens: [],
      embedDim: 1024,
      embedFor: () => Array.from({ length: 1024 }, (_, i) => -0.0123456789 * (i % 7)),
      extractJson: ({ schema }) =>
        schema.required[0] === "context" ? { context: "Context." } : { abstract: "Abstract." },
    });
    const result = await ingestDocument({ pages, meta, provider, db, log: () => {} });
    return { db, result };
  };

  it("inserts each level in batches that fit a Data API request", async () => {
    const { db, result } = await run();
    expect(result.counts).toMatchObject({ section: paragraphs, sentence: paragraphs });
    const inserts = db.statements.filter((s) => /INSERT INTO chunks/.test(s.text));
    expect(inserts.length).toBeGreaterThan(4);
    for (const statement of inserts) {
      expect(dataApiRequestBytes(statement)).toBeLessThan(64 * 1024);
    }
    const ordinals = (level) =>
      inserts.filter((s) => s.params[1] === level).flatMap((s) => s.params[5]);
    expect(ordinals("section")).toEqual(Array.from({ length: paragraphs }, (_, i) => i));
    expect(ordinals("sentence")).toEqual(Array.from({ length: paragraphs }, (_, i) => i));
  });

  it("links every passage and sentence to the id returned for its section", async () => {
    const { db } = await run();
    const inserts = db.statements.filter((s) => /INSERT INTO chunks/.test(s.text));
    let id = 1;
    const sectionIds = new Map();
    for (const s of inserts) {
      for (const ordinal of s.params[5]) {
        if (s.params[1] === "section") sectionIds.set(ordinal, String(id));
        id++;
      }
    }
    const sentenceParents = inserts
      .filter((s) => s.params[1] === "sentence")
      .flatMap((s) => s.params[10]);
    expect(sentenceParents).toEqual(
      Array.from({ length: paragraphs }, (_, i) => sectionIds.get(i)),
    );
  });

  it("casts the timestamp and date parameters of the documents row", async () => {
    const { db } = await run();
    const insert = db.statements.find((s) => /INSERT INTO documents/.test(s.text));
    expect(insert.text).toMatch(/\$4::timestamptz/);
    expect(insert.text).toMatch(/\$9::date/);
    expect(insert.text).toMatch(/\$10::date/);
    expect(insert.params[3]).toBe(meta.fetchedAt);
    expect(insert.params[8]).toBe("2019-08-06");
  });
});

describe("levelBatches", () => {
  const row = (ordinal, textBytes) => ({
    ordinal,
    text: "x".repeat(textBytes),
    header: null,
    context: null,
    locator: { page: 1, paragraph: null },
    embedding: "[0]",
  });

  it("keeps order and starts a batch when the next row would pass the limit", () => {
    const rows = [row(0, 400), row(1, 400), row(2, 400)];
    const out = levelBatches(rows, 1200);
    expect(out.map((b) => b.map((r) => r.ordinal))).toEqual([[0, 1], [2]]);
  });

  it("puts a row larger than the limit in a batch of its own", () => {
    const out = levelBatches([row(0, 10), row(1, 5000), row(2, 10)], 1000);
    expect(out.map((b) => b.map((r) => r.ordinal))).toEqual([[0], [1], [2]]);
  });

  it("returns one batch for small rows under the default limit", () => {
    expect(levelBatches([row(0, 10), row(1, 10)])).toHaveLength(1);
    expect(LEVEL_BATCH_BYTES).toBe(60 * 1024);
  });
});
