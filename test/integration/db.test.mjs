// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Docker tier: npm run db:up, then CONCORDANCE_DB_TESTS=1 npm test. Each run
// migrates into its own schema and drops it afterwards.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { DEFAULT_DATABASE_URL } from "../../packages/core/db.mjs";

const enabled = process.env.CONCORDANCE_DB_TESTS === "1";
if (!enabled) console.log("database tier skipped: set CONCORDANCE_DB_TESTS=1 to run it");

const schema = `test_${process.pid}_${Date.now()}`;

describe.skipIf(!enabled)("database schema (CONCORDANCE_DB_TESTS=1)", () => {
  let client;
  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    client = new pg.Client({ connectionString, options: `-c search_path=${schema},public` });
    await client.connect();
  });
  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end();
  });

  it("applies migrations once and skips them on a second run", async () => {
    const log = [];
    expect(await migrate(client, { log: (l) => log.push(l) })).toContain("0001_initial.sql");
    expect(await migrate(client, { log: (l) => log.push(l) })).toEqual([]);
    expect(log.at(-1)).toMatch(/^skip\s+0001_initial\.sql$/);
  });

  it("creates the tables, the triples view and the search indexes", async () => {
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        "documents",
        "witnesses",
        "chunks",
        "entities",
        "events",
        "assertions",
        "accepted_facts",
        "assertion_comparisons",
        "provenance",
        "sessions",
        "session_turns",
        "triples",
        "schema_migrations",
      ]),
    );
    const indexes = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'chunks'",
      [schema],
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(["chunks_embedding_hnsw_idx", "chunks_tsv_gin_idx"]),
    );
  });

  it("stores no real-name column for witnesses", async () => {
    const cols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'witnesses'",
      [schema],
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      "aliases",
      "cipher_only",
      "id",
      "role",
    ]);
  });

  it("finds a chunk by its generated lexical vector", async () => {
    await client.query("INSERT INTO witnesses (id) VALUES ('IWS1')");
    await client.query(
      `INSERT INTO documents (id, corpus, source_url, fetched_at, sha256, licence, format, witness_id, pipeline_version)
       VALUES ('IWS1', 'grenfell', 'https://example.test/a.pdf', now(), repeat('a', 64), 'OGL-3.0', 'pdf', 'IWS1', 'v0')`,
    );
    await client.query(
      `INSERT INTO chunks (document_id, level, ordinal, text, header, pipeline_version)
       VALUES ('IWS1', 'sentence', 0, 'The stairwell was full of smoke.', '[Grenfell Inquiry | Witness IWS1]', 'v0')`,
    );
    const hit = await client.query(
      "SELECT text FROM chunks WHERE tsv @@ plainto_tsquery('english', 'smoke stairwell')",
    );
    expect(hit.rows).toEqual([{ text: "The stairwell was full of smoke." }]);
  });
});
