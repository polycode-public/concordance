// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Docker tier: npm run db:up, then CONCORDANCE_DB_TESTS=1 npm test. The comparison run and the
// facts views run every statement against the migrated schema with the fixture, and answer as
// the in-memory store does. Each run migrates into its own schema and drops it afterwards.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { DEFAULT_DATABASE_URL } from "../../packages/core/db.mjs";
import { runComparison } from "../../packages/core/facts/compare.mjs";
import { factsResponse } from "../../packages/core/facts/views.mjs";
import { createCompareStore } from "../core/compareFakeStore.mjs";
import { SESSION, compareProvider, compareSeed } from "../core/compareFixture.mjs";
import { seed } from "./compareSeedSql.mjs";

const enabled = process.env.CONCORDANCE_DB_TESTS === "1";
if (!enabled) console.log("database tier skipped: set CONCORDANCE_DB_TESTS=1 to run it");

const schema = `test_compare_${process.pid}_${Date.now()}`;

// Ids and timestamps differ between the stores; everything else must match.
const stable = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, v) =>
      ["id", "runId", "runAt", "promotedAt", "pairIds", "overrides"].includes(key) ? undefined : v,
    ),
  );

describe.skipIf(!enabled)("the comparison run and facts views (CONCORDANCE_DB_TESTS=1)", () => {
  let client;
  let db;
  const fake = createCompareStore(compareSeed());

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
    db = { query: (text, params) => client.query(text, params) };
    await seed(db);
  });
  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end();
  });

  const both = async (fn) => {
    const real = await fn(db);
    const inMemory = await fn(fake);
    expect(stable(real)).toEqual(stable(inMemory));
    return real;
  };
  const run = (store) =>
    runComparison({
      corpus: "grenfell",
      db: store,
      provider: compareProvider({ dimensions: 1024 }).provider,
      log: () => {},
    });
  const request =
    (method, path, { query = {}, body, userId = "sub-1" } = {}) =>
    (store) =>
      factsResponse(store, { method, path, query: { corpus: "grenfell", ...query }, body, userId });

  it("labels the fixture, then skips the rerun and writes nothing", async () => {
    expect((await both(run)).status).toBe("complete");
    const rows = (await db.query("SELECT count(*) AS n FROM assertion_comparisons")).rows[0].n;
    expect((await both(run)).status).toBe("skipped");
    expect((await db.query("SELECT count(*) AS n FROM assertion_comparisons")).rows[0].n).toBe(
      rows,
    );
  });

  it("answers the groups, the matrices, the timeline and a witness", async () => {
    const groups = await both(request("GET", "/facts/groups"));
    expect(groups.body.groups[0]).toMatchObject({ eventId: "7", contradictions: 4 });
    const matrix = await both(request("GET", "/facts/matrix", { query: { event: "7" } }));
    expect(matrix.body.pairs.find((p) => p.identityRevealing).a.sentence).toBeNull();
    await both(request("GET", "/facts/matrix", { query: { topic: "dark" } }));
    await both(request("GET", "/facts/timeline", { query: { event: "7", witness: "IWS-A" } }));
    await both(request("GET", "/facts/witness/IWS-A"));
  });

  it("keeps a person's relabel over the machine label", async () => {
    const realId = (await db.query("SELECT id FROM assertion_comparisons WHERE assertion_a = 4"))
      .rows[0].id;
    const fakeId = fake.tables.assertion_comparisons.find((c) => c.assertion_a === "4").id;
    const body = { label: "agree", reason: "The same alarm." };
    const real = await factsResponse(db, {
      method: "POST",
      path: "/facts/override",
      query: { corpus: "grenfell" },
      body: { ...body, comparisonId: String(realId) },
      userId: "sub-1",
    });
    await factsResponse(fake, {
      method: "POST",
      path: "/facts/override",
      query: { corpus: "grenfell" },
      body: { ...body, comparisonId: fakeId },
      userId: "sub-1",
    });
    expect(real.status).toBe(201);
    const matrix = await both(request("GET", "/facts/matrix", { query: { event: "8" } }));
    expect(matrix.body.pairs[0]).toMatchObject({ label: "agree", model: "operator" });
  });

  it("stores a promotion and a hypothesis, and compares against them on the next run", async () => {
    await both(
      request("POST", "/facts/accept", { body: { assertionId: "2", sourceCitation: "fixture" } }),
    );
    await both(
      request("POST", "/facts/hypothesis", {
        body: { sessionId: SESSION, text: "Assume smoke in the lobby at about 1.00 am." },
      }),
    );
    const result = await both(run);
    expect(result.counts.rules).toBe(3);
    const mine = await both(request("GET", "/facts/matrix", { query: { event: "7" } }));
    expect(mine.body.accepted).toHaveLength(3);
  });
});
