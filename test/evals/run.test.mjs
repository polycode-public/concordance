// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRow,
  locatorMatches,
  missReport,
  parseArgs,
  parseGold,
  run,
  score,
} from "../../evals/run.mjs";

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "concordance-eval-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const row = (id, expected, gold_locators = []) =>
  JSON.stringify({ id, question: `q ${id}?`, gold_locators, expected });

describe("evals runner", () => {
  it("defaults to the laptop provider and the Grenfell gold set", () => {
    expect(parseArgs([])).toEqual({
      provider: "laptop",
      gold: "evals/grenfell/gold.jsonl",
      corpus: "grenfell",
    });
    expect(parseArgs(["--gold=evals/ucpi/gold.jsonl"]).corpus).toBe("ucpi");
    expect(parseArgs(["--corpus=other"]).corpus).toBe("other");
    expect(parseArgs(["--provider=bedrock"]).provider).toBe("bedrock");
    expect(() => parseArgs(["--provider=gpu"])).toThrow(/laptop or bedrock/);
  });

  it("prints nothing to score for an empty gold file", async () => {
    const gold = path.join(dir, "gold.jsonl");
    await writeFile(gold, "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run([`--gold=${gold}`])).toBeNull();
    expect(log).toHaveBeenCalledWith(`0 gold rows in ${gold}; nothing to score`);
  });

  it("opens a database for runQuery and closes it at the end", async () => {
    const gold = path.join(dir, "gold.jsonl");
    await writeFile(gold, row("g1", "abstain") + "\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = { query: vi.fn(), close: vi.fn(async () => {}) };
    const runQuery = vi.fn(async () => ({
      abstained: true,
      citations: [],
      checks: { sentences: 1, supported: 0 },
    }));
    const metrics = await run([`--gold=${gold}`], {
      runQuery,
      providerFor: async () => ({ name: "stub" }),
      openDb: () => db,
    });
    expect(runQuery).toHaveBeenCalledWith({
      question: "q g1?",
      corpus: path.basename(dir),
      provider: { name: "stub" },
      db,
    });
    expect(db.close).toHaveBeenCalledOnce();
    expect(metrics.abstentionCorrectness).toBe(1);
  });

  it("leaves a database the caller passes open, also when a query fails", async () => {
    const gold = path.join(dir, "gold.jsonl");
    await writeFile(gold, row("g1", "answer", ["p.3 para 11"]) + "\n");
    const db = { query: vi.fn(), close: vi.fn() };
    const openDb = vi.fn();
    await expect(
      run([`--gold=${gold}`], {
        db,
        openDb,
        providerFor: async () => ({}),
        runQuery: async () => {
          throw new Error("retrieval failed");
        },
      }),
    ).rejects.toThrow(/retrieval failed/);
    expect(openDb).not.toHaveBeenCalled();
    expect(db.close).not.toHaveBeenCalled();
  });

  it("rejects a gold row with an unknown expected value", () => {
    expect(() => parseGold(row("g1", "maybe"), "gold.jsonl")).toThrow(/gold.jsonl:1/);
  });

  it("matches a gold paragraph on any page and a gold page when the paragraph is unknown", () => {
    const gold = { document: "IWS1", page: 2, paragraph: 11 };
    expect(locatorMatches(gold, { document: "IWS1", page: 3, paragraph: 11 })).toBe(true);
    expect(locatorMatches(gold, { document: "IWS1", page: 2, paragraph: 12 })).toBe(false);
    expect(locatorMatches(gold, { document: "IWS2", page: 2, paragraph: 11 })).toBe(false);
    const pageOnly = { document: "IWS1", page: 2, paragraph: null };
    expect(locatorMatches(pageOnly, { document: "IWS1", page: 2, paragraph: 7 })).toBe(true);
    expect(locatorMatches(pageOnly, { document: "IWS1", page: 3, paragraph: 7 })).toBe(false);
    expect(locatorMatches("p.3 para 11", "p.3 para 11")).toBe(true);
  });

  it("scores citation precision, recall, unsupported rate and abstention", () => {
    const metrics = score([
      {
        row: { expected: "answer", gold_locators: ["a", "b"] },
        result: {
          abstained: false,
          citations: [{ locator: "a" }, { locator: "c" }],
          checks: { sentences: 4, supported: 3 },
        },
      },
      {
        row: { expected: "abstain", gold_locators: [] },
        result: { abstained: false, citations: [], checks: { sentences: 1, supported: 0 } },
      },
    ]);
    expect(metrics).toEqual({
      rows: 2,
      citationPrecision: 0.5,
      citationRecall: 0.5,
      unsupportedSentenceRate: 0.4,
      abstentionCorrectness: 0.5,
    });
  });

  const loc = (document, page, paragraph) => ({ document, page, paragraph });
  const block = (documentId, page, paragraph) => ({ documentId, locator: { page, paragraph } });

  it("classifies each distinct cited locator by miss kind", () => {
    const report = classifyRow({
      row: {
        id: "g1",
        question: "q?",
        expected: "answer",
        gold_locators: [loc("IWS1", 3, 11)],
      },
      result: {
        abstained: false,
        citations: [
          { locator: loc("IWS1", 4, 11) },
          { locator: loc("IWS1", 3, 11) },
          { locator: loc("IWS1", 3, 12) },
          { locator: loc("IWS1", 5, 20) },
          { locator: loc("IWS2", 3, 11) },
          { locator: loc("IWS2", 3, 11) },
        ],
        checks: { sentences: 3, supported: 2 },
      },
    });
    expect(report).toMatchObject({
      id: "g1",
      expected: "answer",
      abstained: false,
      sentences: 3,
      supported: 2,
    });
    expect(report.cited.map((c) => c.kind)).toEqual([
      "gold",
      "gold",
      "paragraph",
      "page",
      "document",
    ]);
  });

  it("marks every citation of a row that expects abstain as abstain-row", () => {
    const report = classifyRow({
      row: { id: "g2", question: "q?", expected: "abstain", gold_locators: [] },
      result: {
        abstained: false,
        citations: [{ locator: loc("IWS1", 1, 1) }],
        checks: { sentences: 1, supported: 1 },
      },
    });
    expect(report.cited).toEqual([{ locator: loc("IWS1", 1, 1), kind: "abstain-row" }]);
    expect(report.gold).toEqual([]);
  });

  it("flags whether retrieval returned each gold document and paragraph", () => {
    const report = classifyRow({
      row: {
        id: "g3",
        question: "q?",
        expected: "answer",
        gold_locators: [loc("IWS1", 3, 11), loc("IWS1", 3, 12), loc("IWS2", 1, 2)],
      },
      result: {
        abstained: false,
        citations: [{ locator: loc("IWS1", 3, 11) }],
        checks: { sentences: 1, supported: 1 },
        evidenceBlocks: [block("IWS1", 3, 11), block("IWS3", 1, 2)],
      },
    });
    expect(report.gold).toEqual([
      { locator: loc("IWS1", 3, 11), cited: true, retrieved: true, retrievedParagraph: true },
      { locator: loc("IWS1", 3, 12), cited: false, retrieved: true, retrievedParagraph: false },
      { locator: loc("IWS2", 1, 2), cited: false, retrieved: false, retrievedParagraph: false },
    ]);
  });

  it("lists the evidence blocks and the tool calls of a row", () => {
    const report = classifyRow({
      row: { id: "g4", question: "q?", expected: "answer", gold_locators: [loc("IWS1", 3, 11)] },
      result: {
        abstained: false,
        citations: [],
        checks: {
          sentences: 0,
          supported: 0,
          tools: [{ name: "search_chunks", input: { phrase: "smoke" }, rows: 2, ms: 40 }],
        },
        evidenceBlocks: [{ evidence: 1, ...block("IWS1", 3, 11) }],
      },
    });
    expect(report.evidence).toEqual([{ evidence: 1, document: "IWS1", page: 3, paragraph: 11 }]);
    expect(report.tools).toEqual([{ name: "search_chunks", input: { phrase: "smoke" }, rows: 2 }]);
  });

  it("counts cited locators by kind and gold locators by cited and retrieved", () => {
    const { summary } = missReport([
      {
        row: { id: "g1", question: "q?", expected: "answer", gold_locators: [loc("A", 1, 1)] },
        result: {
          abstained: false,
          citations: [{ locator: loc("A", 1, 1) }, { locator: loc("B", 1, 1) }],
          checks: { sentences: 1, supported: 1 },
          evidenceBlocks: [block("A", 1, 1)],
        },
      },
      {
        row: {
          id: "g2",
          question: "q?",
          expected: "answer",
          gold_locators: [loc("A", 2, 5), loc("C", 1, 1)],
        },
        result: {
          abstained: false,
          citations: [{ locator: loc("A", 2, 6) }],
          checks: { sentences: 1, supported: 1 },
          evidenceBlocks: [block("A", 2, 5)],
        },
      },
    ]);
    expect(summary).toEqual({
      citedByKind: { gold: 1, paragraph: 1, page: 0, document: 1, "abstain-row": 0 },
      gold: {
        total: 3,
        cited: 1,
        retrievedNotCited: 1,
        notRetrieved: 1,
        paragraphRetrievedNotCited: 1,
      },
    });
  });

  it("writes the miss report to the --report path and prints that path", async () => {
    const gold = path.join(dir, "gold.jsonl");
    await writeFile(gold, row("g1", "answer", [loc("A", 1, 1)]) + "\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const reportPath = path.join(dir, "out", "report.json");
    const metrics = await run([`--gold=${gold}`, `--report=${reportPath}`], {
      db: { query: vi.fn() },
      providerFor: async () => ({}),
      runQuery: async () => ({
        abstained: false,
        citations: [{ locator: loc("A", 1, 2) }],
        checks: { sentences: 1, supported: 1 },
        evidenceBlocks: [block("A", 1, 2)],
      }),
    });
    expect(metrics.citationPrecision).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.metrics).toEqual(metrics);
    expect(report.summary.citedByKind.paragraph).toBe(1);
    expect(report.rows[0].id).toBe("g1");
    expect(JSON.parse(log.mock.calls[0][0]).report).toBe(reportPath);
  });

  it("writes the miss report under runs beside the gold file by default", async () => {
    const gold = path.join(dir, "gold.jsonl");
    await writeFile(gold, row("g1", "abstain") + "\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("RERANK", "");
    await run([`--gold=${gold}`, "--provider=bedrock"], {
      db: { query: vi.fn() },
      providerFor: async () => ({}),
      runQuery: async () => ({
        abstained: true,
        citations: [],
        checks: { sentences: 0, supported: 0 },
      }),
    });
    vi.unstubAllEnvs();
    const files = await readdir(path.join(dir, "runs"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-bedrock-rerank-off\.json$/);
  });
});
