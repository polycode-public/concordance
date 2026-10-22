// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Docker tier: CONCORDANCE_DB_TESTS=1 npm test. The store tools run their statements against the
// migrated schema with the comparison fixture and answer as the in-memory store does. Each run
// migrates into its own schema and drops it afterwards.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { DEFAULT_DATABASE_URL } from "../../packages/core/db.mjs";
import { runComparison } from "../../packages/core/facts/compare.mjs";
import { buildTools } from "../../packages/core/tools/index.mjs";
import { createCompareStore } from "../core/compareFakeStore.mjs";
import { compareProvider, compareSeed } from "../core/compareFixture.mjs";
import { toolStore } from "../core/toolsFakeStore.mjs";
import { seed } from "./compareSeedSql.mjs";

const enabled = process.env.CONCORDANCE_DB_TESTS === "1";
if (!enabled) console.log("database tier skipped: set CONCORDANCE_DB_TESTS=1 to run it");

const schema = `test_tools_${process.pid}_${Date.now()}`;
const CORPUS = "grenfell";

// Comparison ids differ between the stores; everything else must match.
const stable = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === "comparisonId" ? undefined : v)));

describe.skipIf(!enabled)("the store tools (CONCORDANCE_DB_TESTS=1)", () => {
  let client;
  let real;
  let fake;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    client = new pg.Client({ connectionString, options: `-c search_path=${schema},public` });
    await client.connect();
    await migrate(client, { log: () => {} });
    const db = { query: (text, params) => client.query(text, params) };
    await seed(db);
    await db.query("UPDATE documents SET title = 'Statement ' || id, page_count = 4");
    await db.query(
      `INSERT INTO chunks (id, document_id, level, ordinal, text, locator, pipeline_version)
       VALUES (900, 'IWS-A1', 'passage', 0, 'Statement of IWS-A.', '{"page": 1, "paragraph": 1}', 'v')`,
    );
    const store = createCompareStore(compareSeed());
    for (const s of [db, store]) {
      await runComparison({
        corpus: CORPUS,
        db: s,
        provider: compareProvider({ dimensions: 1024 }).provider,
        log: () => {},
      });
    }
    real = buildTools({
      db,
      corpus: CORPUS,
      provider: compareProvider({ dimensions: 1024 }).provider,
      question: "What did the witness see in the lobby?",
    });
    fake = buildTools({ db: toolStore(store), corpus: CORPUS, provider: {} });
  });
  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end();
  });

  const run = (tools, name, input) => tools.find((t) => t.name === name).run(input);
  const both = async (name, input) => {
    const fromDb = await run(real, name, input);
    expect(stable(fromDb)).toEqual(stable(await run(fake, name, input)));
    return fromDb;
  };

  it("answers the matrix cell, the corroborated contradictions and the timeline window", async () => {
    const cell = await both("matrix_cell", { witnessA: "IWS-A", witnessB: "C123" });
    expect(cell.counts.contradict).toBe(1);
    await both("matrix_cell", { witnessA: "IWS-B", witnessB: "C123", event: "smoke in the lobby" });
    const corroborated = await both("corroborated_contradictions", {});
    expect(corroborated.rows.map((r) => r.assertion.assertionId)).toContain("3");
    await both("corroborated_contradictions", { event: "the fire alarm" });
    const window = await both("timeline_window", { from: "00:55", to: "01:05" });
    expect(window.rows.length).toBeGreaterThan(0);
    await both("count_assertions", { groupBy: "event", from: "00:00", to: "03:00" });
  });

  it("counts, lists a witness's claims and gives document facts from SQL", async () => {
    const byWitness = await run(real, "count_assertions", { groupBy: "witness" });
    expect(byWitness.rows).toEqual([
      {
        witness: "IWS-A",
        count: 5,
        examples: [{ chunkId: "101" }, { chunkId: "104" }, { chunkId: "106" }],
      },
      {
        witness: "IWS-B",
        count: 4,
        examples: [{ chunkId: "102" }, { chunkId: "105" }, { chunkId: "107" }],
      },
      {
        witness: "C123",
        count: 3,
        examples: [{ chunkId: "103" }, { chunkId: "108" }, { chunkId: "110" }],
      },
    ]);
    expect(byWitness.total).toBe(12);
    expect(byWitness.evidence).toHaveLength(9);
    const byEvent = await run(real, "count_assertions", {
      groupBy: "predicate",
      event: "Smoke in the lobby",
    });
    expect(byEvent.rows.map((r) => [r.predicate, r.count])).toEqual([
      ["first saw", 2],
      ["saw", 2],
    ]);
    const none = await run(real, "count_assertions", { groupBy: "witness", event: "no such" });
    expect(none).toMatchObject({ rows: [], total: 0 });

    const claims = await run(real, "witness_claims", { witness: "C123" });
    expect(claims.rows.map((r) => [r.assertionId, r.chunkId, r.event])).toEqual([
      ["3", "103", "smoke in the lobby"],
      ["8", "108", "leaving the flat"],
      ["10", "110", null],
    ]);
    expect(claims.evidence.map((b) => b.locator)).toEqual([
      { page: 1, paragraph: 4 },
      { page: 2, paragraph: 6 },
      { page: 2, paragraph: 8 },
    ]);

    const documents = await run(real, "document_facts", {});
    expect(documents.rows.map((r) => [r.documentId, r.title, r.chunkId ?? null])).toEqual([
      ["IWS-A1", "Statement IWS-A1", "900"],
      ["IWS-B1", "Statement IWS-B1", null],
      ["C123-1", null, null],
      ["IWS-A2", "Statement IWS-A2", null],
    ]);
    const usage = await run(real, "usage_summary", {});
    expect(usage).toMatchObject({
      rows: [{ source: "comparison", model: "fake-extract", requests: 1, cost: null }],
      truncated: false,
      evidence: [],
    });
  });
});
