// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Scores the query pipeline against a gold set:
//   node evals/run.mjs --provider=laptop|bedrock --gold=evals/grenfell/gold.jsonl
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = new Set(["answer", "abstain"]);

export function parseArgs(argv) {
  const args = { provider: "laptop", gold: "evals/grenfell/gold.jsonl" };
  for (const arg of argv) {
    const match = /^--(provider|gold)=(.+)$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    args[match[1]] = match[2];
  }
  if (args.provider === "local") args.provider = "laptop";
  if (!["laptop", "bedrock"].includes(args.provider)) {
    throw new Error(`--provider must be laptop or bedrock, got ${args.provider}`);
  }
  return args;
}

/** Parses gold JSONL and validates each row. */
export function parseGold(text, source = "gold") {
  const rows = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${source}:${i + 1} is not valid JSON`);
    }
    if (typeof row.id !== "string" || typeof row.question !== "string") {
      throw new Error(`${source}:${i + 1} needs string id and question`);
    }
    if (!Array.isArray(row.gold_locators)) {
      throw new Error(`${source}:${i + 1} needs a gold_locators array`);
    }
    if (!EXPECTED.has(row.expected)) {
      throw new Error(`${source}:${i + 1} expected must be answer or abstain`);
    }
    rows.push(row);
  });
  return rows;
}

const locatorKey = (l) => (typeof l === "string" ? l : JSON.stringify(l));

/**
 * Aggregates per-row results into the four tracked metrics.
 * @param {{ row: object, result: { abstained: boolean, citations: { locator: unknown }[],
 *   checks: { sentences: number, supported: number } } }[]} scored
 */
export function score(scored) {
  let cited = 0;
  let citedCorrect = 0;
  let gold = 0;
  let goldFound = 0;
  let sentences = 0;
  let unsupported = 0;
  let abstainCorrect = 0;
  for (const { row, result } of scored) {
    const goldKeys = new Set(row.gold_locators.map(locatorKey));
    const citedKeys = new Set(result.citations.map((c) => locatorKey(c.locator)));
    cited += citedKeys.size;
    for (const key of citedKeys) if (goldKeys.has(key)) citedCorrect++;
    gold += goldKeys.size;
    for (const key of goldKeys) if (citedKeys.has(key)) goldFound++;
    sentences += result.checks.sentences;
    unsupported += result.checks.sentences - result.checks.supported;
    if (result.abstained === (row.expected === "abstain")) abstainCorrect++;
  }
  const ratio = (a, b) => (b ? a / b : null);
  return {
    rows: scored.length,
    citationPrecision: ratio(citedCorrect, cited),
    citationRecall: ratio(goldFound, gold),
    unsupportedSentenceRate: ratio(unsupported, sentences),
    abstentionCorrectness: ratio(abstainCorrect, scored.length),
  };
}

export async function run(argv, { runQuery, providerFor } = {}) {
  const args = parseArgs(argv);
  const goldPath = path.resolve(args.gold);
  const rows = parseGold(await readFile(goldPath, "utf8"), args.gold);
  if (rows.length === 0) {
    console.log(`0 gold rows in ${args.gold}; nothing to score`);
    return null;
  }
  runQuery ??= (await import("../packages/core/query.mjs")).runQuery;
  providerFor ??= async (kind) =>
    (await import("../packages/core/providers/index.mjs")).providerFromEnv({
      ...process.env,
      MODEL_PROVIDER: kind,
    });
  const provider = await providerFor(args.provider);
  const scored = [];
  for (const row of rows) {
    const result = await runQuery({ question: row.question, provider });
    scored.push({ row, result });
  }
  const metrics = score(scored);
  console.log(JSON.stringify({ provider: args.provider, gold: args.gold, ...metrics }, null, 2));
  return metrics;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`eval failed: ${err.message}`);
    process.exit(1);
  });
}
