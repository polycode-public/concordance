// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Scores the query pipeline against a gold set:
//   node evals/run.mjs --provider=laptop|bedrock --gold=evals/<corpus>/gold.jsonl
// The corpus is the gold file's directory name unless --corpus= names it. Each run also writes a
// per-row miss report to evals/<corpus>/runs/ unless --report= names the path.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = new Set(["answer", "abstain"]);

export function parseArgs(argv) {
  const args = { provider: "laptop", gold: "evals/grenfell/gold.jsonl" };
  for (const arg of argv) {
    const match = /^--(provider|gold|corpus|report)=(.+)$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    args[match[1]] = match[2];
  }
  args.corpus ??= path.basename(path.dirname(path.resolve(args.gold)));
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

/**
 * A gold locator with a paragraph matches a citation of the same document and paragraph, whatever
 * page the citation names (a paragraph can start on the page before); one without a paragraph
 * matches any citation of the same document and page.
 */
export function locatorMatches(gold, cited) {
  if (typeof gold === "string" || typeof cited === "string") return gold === cited;
  if (gold.document !== cited.document) return false;
  if (gold.paragraph !== null && gold.paragraph !== undefined) {
    return gold.paragraph === cited.paragraph;
  }
  return gold.page === cited.page;
}

const locatorKey = (l) => (typeof l === "string" ? l : JSON.stringify(l));

const distinctCitations = (citations) => [
  ...new Map(citations.map((c) => [locatorKey(c.locator), c.locator])).values(),
];

const sameDocument = (gold, cited) =>
  typeof gold !== "string" && typeof cited !== "string" && gold.document === cited.document;

/** The miss kind of one cited locator against the gold locators of its row. */
function citedKind(golds, cited) {
  if (golds.length === 0) return "abstain-row";
  if (golds.some((g) => locatorMatches(g, cited))) return "gold";
  const documentGolds = golds.filter((g) => sameDocument(g, cited));
  if (documentGolds.length === 0) return "document";
  if (documentGolds.some((g) => g.page === cited.page)) return "paragraph";
  return "page";
}

/**
 * Classifies one scored row for the miss report: each distinct cited locator gets a kind, and each
 * gold locator records whether the answer cites it and whether retrieval returned its document
 * and its paragraph.
 * @param {{ row: object, result: { abstained: boolean, citations: { locator: unknown }[],
 *   checks: { sentences: number, supported: number },
 *   evidenceBlocks?: { documentId: string, locator: { paragraph?: unknown } }[] } }} scored
 */
export function classifyRow({ row, result }) {
  const golds = row.gold_locators;
  const citations = distinctCitations(result.citations);
  const blocks = result.evidenceBlocks ?? [];
  return {
    id: row.id,
    question: row.question,
    expected: row.expected,
    abstained: result.abstained,
    sentences: result.checks.sentences,
    supported: result.checks.supported,
    gold: golds.map((g) => {
      const documentBlocks =
        typeof g === "string" ? [] : blocks.filter((b) => b.documentId === g.document);
      return {
        locator: g,
        cited: citations.some((c) => locatorMatches(g, c)),
        retrieved: documentBlocks.length > 0,
        retrievedParagraph:
          g.paragraph !== null &&
          g.paragraph !== undefined &&
          documentBlocks.some((b) => b.locator?.paragraph === g.paragraph),
      };
    }),
    cited: citations.map((c) => ({ locator: c, kind: citedKind(golds, c) })),
  };
}

/** Builds the miss report: the summary counts over all rows, then each classified row. */
export function missReport(scored) {
  const rows = scored.map(classifyRow);
  const citedByKind = { gold: 0, paragraph: 0, page: 0, document: 0, "abstain-row": 0 };
  const gold = {
    total: 0,
    cited: 0,
    retrievedNotCited: 0,
    notRetrieved: 0,
    paragraphRetrievedNotCited: 0,
  };
  for (const r of rows) {
    for (const c of r.cited) citedByKind[c.kind]++;
    for (const g of r.gold) {
      gold.total++;
      if (g.cited) gold.cited++;
      else if (g.retrieved) gold.retrievedNotCited++;
      else gold.notRetrieved++;
      if (!g.cited && g.retrievedParagraph) gold.paragraphRetrievedNotCited++;
    }
  }
  return { summary: { citedByKind, gold }, rows };
}

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
    const golds = row.gold_locators;
    const citations = distinctCitations(result.citations);
    cited += citations.length;
    for (const c of citations) if (golds.some((g) => locatorMatches(g, c))) citedCorrect++;
    gold += golds.length;
    for (const g of golds) if (citations.some((c) => locatorMatches(g, c))) goldFound++;
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

function defaultReportPath(goldPath, provider) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rerank = process.env.RERANK || "off";
  return path.join(path.dirname(goldPath), "runs", `${stamp}-${provider}-rerank-${rerank}.json`);
}

/**
 * Runs every gold question through runQuery and prints the metrics. A database
 * that the caller passes stays open; one this function opens is closed at the end.
 * @param {string[]} argv
 * @param {{ runQuery?: Function, providerFor?: Function, db?: { query: Function },
 *   openDb?: () => { query: Function, close: () => Promise<void> } }} [deps]
 */
export async function run(argv, { runQuery, providerFor, db, openDb } = {}) {
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
  openDb ??= async () => (await import("../packages/core/db.mjs")).openDbFromEnv();
  const owned = db ? null : await openDb();
  try {
    const scored = [];
    for (const row of rows) {
      const result = await runQuery({
        question: row.question,
        corpus: args.corpus,
        provider,
        db: db ?? owned,
      });
      scored.push({ row, result });
    }
    const metrics = score(scored);
    const reportPath = path.resolve(args.report ?? defaultReportPath(goldPath, args.provider));
    const header = {
      provider: args.provider,
      corpus: args.corpus,
      gold: args.gold,
      rerank: process.env.RERANK || "off",
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({ ...header, metrics, ...missReport(scored) }, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        {
          provider: args.provider,
          corpus: args.corpus,
          gold: args.gold,
          ...metrics,
          report: reportPath,
        },
        null,
        2,
      ),
    );
    return metrics;
  } finally {
    await owned?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`eval failed: ${err.message}`);
    process.exit(1);
  });
}
