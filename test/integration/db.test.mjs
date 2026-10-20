// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Docker tier: npm run db:up, then CONCORDANCE_DB_TESTS=1 npm test. Each run
// migrates into its own schema and drops it afterwards.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { DEFAULT_DATABASE_URL } from "../../packages/core/db.mjs";
import {
  conversationTurns,
  listConversations,
  recordSession,
  recordTurn,
} from "../../packages/core/sessions.mjs";

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
    expect(await migrate(client, { log: (l) => log.push(l) })).toEqual([
      "0001_initial.sql",
      "0002_session_frames.sql",
      "0003_fact_registers.sql",
      "0004_reports.sql",
      "0005_comparisons.sql",
      "0006_extraction_progress.sql",
    ]);
    expect(await migrate(client, { log: (l) => log.push(l) })).toEqual([]);
    expect(log.slice(-5)).toEqual([
      "skip    0001_initial.sql",
      "skip    0002_session_frames.sql",
      "skip    0003_fact_registers.sql",
      "skip    0004_reports.sql",
      "skip    0005_comparisons.sql",
    ]);
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
        "reports",
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

  it("has the vector extension at a 0.x version", async () => {
    const res = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    console.log(`pgvector ${res.rows[0].extversion}`);
    expect(res.rows[0].extversion).toMatch(/^0\.\d+/);
  });

  const unit = (i) => `[${Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;

  it("stores halfvec embeddings at all four chunk levels and ranks by cosine distance", async () => {
    await client.query(
      `INSERT INTO documents (id, corpus, source_url, fetched_at, sha256, licence, format, pipeline_version)
       VALUES ('VEC1', 'grenfell', 'https://example.test/v.pdf', now(), repeat('b', 64), 'OGL-3.0', 'pdf', 'v0')`,
    );
    const levels = ["document", "section", "passage", "sentence"];
    for (const [i, level] of levels.entries()) {
      await client.query(
        `INSERT INTO chunks (document_id, level, ordinal, text, embedding, embedding_model, embedding_dim, pipeline_version)
         VALUES ('VEC1', $1, $2, $3, $4::halfvec, 'bge-m3', 1024, 'v0')`,
        [level, i, `level ${level}`, unit(i)],
      );
    }
    const stored = await client.query(
      "SELECT level FROM chunks WHERE document_id = 'VEC1' AND embedding IS NOT NULL ORDER BY ordinal",
    );
    expect(stored.rows.map((r) => r.level)).toEqual(levels);

    const top = await client.query(
      "SELECT text FROM chunks WHERE document_id = 'VEC1' ORDER BY embedding <=> $1::halfvec LIMIT 3",
      [unit(2)],
    );
    expect(top.rows).toHaveLength(3);
    expect(top.rows[0].text).toBe("level passage");
  });

  it("resolves prev_id and next_id through a join", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await client.query(
        `INSERT INTO chunks (document_id, level, ordinal, text, pipeline_version)
         VALUES ('VEC1', 'passage', $1, $2, 'v0') RETURNING id`,
        [10 + i, `neighbour ${i}`],
      );
      ids.push(r.rows[0].id);
    }
    await client.query("UPDATE chunks SET next_id = $2 WHERE id = $1", [ids[0], ids[1]]);
    await client.query("UPDATE chunks SET prev_id = $1, next_id = $3 WHERE id = $2", [
      ids[0],
      ids[1],
      ids[2],
    ]);
    await client.query("UPDATE chunks SET prev_id = $1 WHERE id = $2", [ids[1], ids[2]]);
    const res = await client.query(
      `SELECT p.text AS prev, c.text AS cur, n.text AS next
       FROM chunks c JOIN chunks p ON p.id = c.prev_id JOIN chunks n ON n.id = c.next_id
       WHERE c.id = $1`,
      [ids[1]],
    );
    expect(res.rows).toEqual([{ prev: "neighbour 0", cur: "neighbour 1", next: "neighbour 2" }]);
  });

  it("writes a session and its turns and reads them through the conversations view", async () => {
    const sessionId = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
    await recordSession(client, { id: sessionId, userId: "laptop" });
    await recordSession(client, { id: sessionId, userId: "laptop" });
    const frames = [
      { type: "token", thread: "t1", turnId: "u1", text: "Dark " },
      { type: "token", thread: "t1", turnId: "u1", text: "[E1]." },
      { type: "done", thread: "t1", turnId: "u1", checks: { supported: 1 }, citations: [] },
    ];
    await recordTurn(client, {
      sessionId,
      thread: "t1",
      turnId: "u1",
      userText: "Were the stairs dark?",
      result: {
        answer: "Dark [E1].",
        abstained: false,
        checks: { model: "m1", promptVersion: "p1" },
      },
      frames,
    });
    await recordTurn(client, {
      sessionId,
      thread: "t1",
      turnId: "u2",
      userText: "And the lobby?",
      result: null,
      frames: [{ type: "cancelled", thread: "t1", turnId: "u2" }],
    });

    const [conversation] = await listConversations(client, "laptop");
    expect(conversation).toMatchObject({
      sessionId,
      thread: "t1",
      firstQuestion: "Were the stairs dark?",
      turnCount: 2,
    });
    expect(conversation.lastTurnAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await listConversations(client, "someone-else")).toEqual([]);

    const { turns } = await conversationTurns(client, {
      sessionId,
      userId: "laptop",
      thread: "t1",
    });
    expect(turns.map((t) => [t.turnId, t.modelId])).toEqual([
      ["u1", "m1"],
      ["u2", null],
    ]);
    expect(turns[0].frames).toEqual([
      { type: "token", thread: "t1", turnId: "u1", text: "Dark [E1]." },
      frames[2],
    ]);
    expect(await conversationTurns(client, { sessionId, userId: "someone-else" })).toBeNull();
    const row = await client.query(
      "SELECT query_rewrites, retrieved_ids, reranker_scores FROM session_turns WHERE turn_id = 'u1'",
    );
    expect(row.rows).toEqual([{ query_rewrites: [], retrieved_ids: [], reranker_scores: {} }]);
  });
});
