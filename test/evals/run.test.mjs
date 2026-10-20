// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, parseGold, run, score } from "../../evals/run.mjs";

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
});
