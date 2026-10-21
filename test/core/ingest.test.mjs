// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  MIN_TEXT_PAGE_FRACTION,
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

  it("reads cipher_only as a boolean that defaults to false", () => {
    const map = parseSources(
      JSON.stringify([{ evidence_id: "A", cipher_only: true }, { evidence_id: "B" }]),
    );
    expect(documentMeta("ucpi", ROW, map.get("A")).cipherOnly).toBe(true);
    expect(documentMeta("ucpi", ROW, map.get("B")).cipherOnly).toBe(false);
    expect(documentMeta("ucpi", ROW, undefined).cipherOnly).toBe(false);
  });

  it("rejects a non-boolean cipher_only", () => {
    expect(() => parseSources(JSON.stringify([{ evidence_id: "A", cipher_only: "yes" }]))).toThrow(
      /cipher_only must be a boolean/,
    );
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
      { page: 1, text: "Witness A, flat 18.\n1. I lived on floor 18. I lived alone.\n2. I woke" },
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

  it("bounds every section of a statement with unnumbered exhibit pages", () => {
    const filler = (n) =>
      Array.from({ length: n }, (_, i) => `Exhibit line ${i} of the email.`).join(" ");
    const pages = [
      { page: 1, text: "1. I lived on floor 18.\n2. I woke at 01:00." },
      { page: 2, text: filler(150) },
      { page: 3, text: filler(500) },
      { page: 4, text: filler(150) },
    ];
    const sections = planChunks(pages);
    expect(sections.length).toBeGreaterThan(4);
    for (const s of sections) expect(s.text.length).toBeLessThanOrEqual(6000);
    expect(sections.map((s) => s.locator).slice(0, 4)).toEqual([
      { page: 1, paragraph: 1 },
      { page: 1, paragraph: 2 },
      { page: 3, paragraph: null },
      { page: 3, paragraph: null },
    ]);
  });

  it("plans the page sections of a statement with no numbered paragraph", () => {
    const sections = planChunks(
      readFileSync(new URL("../fixtures/MG11-unnumbered-pages-1-3.txt", import.meta.url), "utf8")
        .split("\f")
        .map((text, i) => ({ page: i + 1, text })),
    );
    expect(sections.map((s) => s.locator)).toEqual([
      { page: 1, paragraph: null },
      { page: 2, paragraph: null },
      { page: 3, paragraph: null },
    ]);
    expect(sections[0].heading).toBe("ADAMS, YVONNE");
    expect(sections.every((s) => s.sentences.length > 0 && s.passages.length > 0)).toBe(true);
  });

  it.each([
    ["IWS00000490-pages-1-2", "381dd14b7c9b0fd75d1fdf2310f75f5b7ba4e1b30ef16330ca4dcc9561f6ab57"],
    ["IWS00000913-pages-3-4", "aa19877c9f945a417ffa6488960669f2e69dcb91eb5ee359bd9534837749faf4"],
    ["IWS00000990-pages-1-2", "8099baac15b308a9039a358646ad8fd424b1b3085c373034da91602b2e1df4b7"],
  ])("plans the numbered fixture %s unchanged", (name, sha256) => {
    const pages = readFileSync(new URL(`../fixtures/${name}.txt`, import.meta.url), "utf8")
      .split("\f")
      .map((text, i) => ({ page: i + 1, text }));
    expect(
      createHash("sha256")
        .update(JSON.stringify(planChunks(pages)))
        .digest("hex"),
    ).toBe(sha256);
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

describe("ingestDocument text layer", () => {
  const meta = {
    evidenceId: "IWS2",
    corpus: "grenfell",
    sha256: "d".repeat(64),
    witnessId: "IWS2",
  };
  const attempt = (pages) => {
    const db = recordingDb();
    const provider = createFakeProvider({ tokens: [], embedDim: 1024 });
    return { db, promise: ingestDocument({ pages, meta, provider, db, log: () => {} }) };
  };
  const blank = (n) => Array.from({ length: n }, (_, i) => ({ page: i + 1, text: "  \n" }));

  it("refuses pages with no text and writes nothing", async () => {
    const { db, promise } = attempt(blank(4));
    await expect(promise).rejects.toThrow(/IWS2: no text layer; 4 of 4 pages have no text/);
    expect(db.statements.filter((s) => /INSERT|DELETE|UPDATE/.test(s.text))).toEqual([]);
  });

  it("refuses a document with fewer text pages than the threshold", async () => {
    const pages = [...blank(8), { page: 9, text: "1. Smoke." }];
    const { promise } = attempt(pages);
    expect(MIN_TEXT_PAGE_FRACTION).toBe(0.25);
    await expect(promise).rejects.toThrow(/8 of 9 pages have no text/);
  });
});

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
  const run = async (log = () => {}) => {
    const db = recordingDb();
    const provider = createFakeProvider({
      tokens: [],
      embedDim: 1024,
      embedFor: () => Array.from({ length: 1024 }, (_, i) => -0.0123456789 * (i % 7)),
      extractJson: ({ schema }) =>
        schema.required[0] === "context" ? { context: "Context." } : { abstract: "Abstract." },
    });
    const result = await ingestDocument({ pages, meta, provider, db, log });
    return { db, result };
  };

  it("upserts the witness with its role and cipher flag", async () => {
    const { db } = await run();
    const witness = db.statements.find((s) => /INSERT INTO witnesses/.test(s.text));
    expect(witness.text).toMatch(
      /ON CONFLICT \(id\) DO UPDATE SET role = EXCLUDED\.role, cipher_only = EXCLUDED\.cipher_only/,
    );
    expect(witness.params).toEqual(["IWS1", null, false]);
  });

  it("logs one structured line per stage with the document id, count and elapsed time", async () => {
    const lines = [];
    await run((line) => lines.push(line));
    const stages = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(stages.map((l) => l.stage)).toEqual([
      "text-extracted",
      "sections-split",
      "context-lines-done",
      "abstract-done",
      "embeddings-done",
      "rows-written",
    ]);
    stages.forEach((l) => {
      expect(l.evidenceId).toBe("IWS1");
      expect(l.ms).toBeGreaterThanOrEqual(0);
    });
    expect(stages[2].count).toBe(paragraphs);
  });

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
