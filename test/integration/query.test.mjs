// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Docker tier: npm run db:up, then CONCORDANCE_DB_TESTS=1 npm test. The run
// migrates into its own schema and drops it afterwards.
import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { DEFAULT_DATABASE_URL } from "../../packages/core/db.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { runQuery } from "../../packages/core/query.mjs";
import { createServer } from "../../packages/local/server.mjs";

const enabled = process.env.CONCORDANCE_DB_TESTS === "1";
if (!enabled) console.log("database tier skipped: set CONCORDANCE_DB_TESTS=1 to run it");

const schema = `test_${process.pid}_${Date.now()}`;
const DIM = 1024;
const EMBED_MODEL = "test-embed";
const ANSWER = ["The stairs were dark ", "[E1]. ", "Help came later [E2]. ", "Nobody knew [E9]."];

/** A unit vector along `axis`, plus `lean` along `toward`. */
function vector(axis, toward = null, lean = 0) {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  if (toward != null) v[toward] = lean;
  return v;
}
const literal = (v) => (v ? `[${v.join(",")}]` : null);

function testProvider() {
  return {
    ...createFakeProvider({ tokens: ANSWER, delayMs: 1 }),
    embedModel: EMBED_MODEL,
    embedDim: DIM,
    async embed(texts) {
      return texts.map(() => vector(2, 3, 0.3));
    },
  };
}

describe.skipIf(!enabled)("query pipeline (CONCORDANCE_DB_TESTS=1)", () => {
  let client;
  let db;
  const ids = {};

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

    await client.query(
      `INSERT INTO documents (id, corpus, source_url, fetched_at, sha256, licence, format, title, pipeline_version)
       VALUES ('IWS9', 'grenfell', 'https://example.org/IWS9.pdf', now(), $1, 'OGL-3.0', 'pdf', 'Statement of IWS9', 'test')`,
      ["0".repeat(64)],
    );
    const insert = async (name, level, ordinal, text, locator, embedding, parent = null) => {
      const { rows } = await client.query(
        `INSERT INTO chunks (document_id, level, ordinal, text, header, locator, parent_id,
                             embedding, embedding_model, embedding_dim, pipeline_version)
         VALUES ('IWS9', $1, $2, $3, $4, $5, $6, $7::halfvec, $8, $9, 'test') RETURNING id`,
        [
          level,
          ordinal,
          text,
          `[Grenfell Inquiry | Witness IWS9 | p.${locator.page} para ${locator.paragraph}]`,
          locator,
          parent,
          literal(embedding),
          embedding ? EMBED_MODEL : null,
          embedding ? DIM : null,
        ],
      );
      ids[name] = String(rows[0].id);
    };
    await insert(
      "s1",
      "section",
      1,
      "Section one: the night in the flat.",
      { page: 1, paragraph: 1 },
      null,
    );
    await insert(
      "s2",
      "section",
      2,
      "Section two: outside the tower.",
      { page: 2, paragraph: 5 },
      vector(6),
    );
    await insert(
      "p1",
      "passage",
      1,
      "The witness woke at one.",
      { page: 1, paragraph: 1 },
      null,
      ids.s1,
    );
    await insert(
      "p2",
      "passage",
      2,
      "The dark stairs were full of smoke.",
      { page: 1, paragraph: 2 },
      vector(2),
      ids.s1,
    );
    await insert(
      "p3",
      "passage",
      3,
      "The witness reached the ground floor.",
      { page: 2, paragraph: 5 },
      vector(3),
      ids.s2,
    );
    await insert(
      "p4",
      "passage",
      4,
      "Firefighters met the witness outside.",
      { page: 2, paragraph: 6 },
      null,
      ids.s2,
    );
    const chain = [ids.p1, ids.p2, ids.p3, ids.p4];
    for (let i = 0; i < chain.length; i++) {
      await client.query("UPDATE chunks SET prev_id = $2, next_id = $3 WHERE id = $1", [
        chain[i],
        chain[i - 1] ?? null,
        chain[i + 1] ?? null,
      ]);
    }
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end();
  });

  it("fuses the lexical and vector rankings with the near passage first", async () => {
    const result = await runQuery({ question: "dark stairs", provider: testProvider(), db });
    expect(result.retrievedIds[0]).toBe(ids.p2);
    expect(result.retrievedIds).toEqual(expect.arrayContaining([ids.p3, ids.s2]));
    expect(result.retrievedIds).not.toContain(ids.p1);
  });

  it("expands the hit to its neighbours and builds headed evidence blocks", async () => {
    const stages = [];
    let sent;
    const tokens = [];
    const result = await runQuery({
      question: "dark stairs",
      provider: testProvider(),
      db,
      onStage: (s) => stages.push(s),
      onEvidence: (blocks) => (sent = blocks),
      onToken: (t) => tokens.push(t),
    });
    expect(stages).toEqual(["rewriting", "retrieving", "answering", "checking"]);
    expect(sent).toBe(result.evidenceBlocks);
    const [e1, e2, ...rest] = result.evidenceBlocks;
    expect(rest).toEqual([]);
    expect(e1).toMatchObject({
      evidence: 1,
      chunkId: ids.p2,
      chunkIds: [ids.p1, ids.p2, ids.p3],
      documentId: "IWS9",
      locator: { page: 1, paragraph: 2 },
      header: "[Grenfell Inquiry | Witness IWS9 | p.1 para 2]",
    });
    expect(e1.text).toBe(
      "The witness woke at one. The dark stairs were full of smoke. The witness reached the ground floor.",
    );
    expect(e2).toMatchObject({ evidence: 2, chunkId: ids.s2, level: "section" });
    expect(e2.header).toBe("[Grenfell Inquiry | Witness IWS9 | p.2 para 5]");
    expect(tokens).toEqual(ANSWER);
  });

  it("resolves [En] to document, page and paragraph and drops unknown tags", async () => {
    const result = await runQuery({ question: "dark stairs", provider: testProvider(), db });
    expect(result.citations).toEqual([
      { evidence: 1, locator: { document: "IWS9", page: 1, paragraph: 2 } },
      { evidence: 2, locator: { document: "IWS9", page: 2, paragraph: 5 } },
    ]);
    expect(Object.keys(result.citations[0].locator)).toEqual(["document", "page", "paragraph"]);
    expect(result.abstained).toBe(false);
    expect(result.checks).toMatchObject({
      sentences: 3,
      supported: 2,
      droppedCitations: 1,
      promptVersion: "answer-closed-world-v2",
      model: "fake-chat",
    });
  });

  it("abstains without calling the model when nothing matches", async () => {
    const provider = {
      ...testProvider(),
      embedModel: "another-embed",
    };
    const result = await runQuery({ question: "helicopter", provider, db });
    expect(result.evidenceBlocks).toEqual([]);
    expect(result.abstained).toBe(true);
    expect(result.answer).toBe("The corpus does not say.");
    expect(provider.calls).toEqual([]);
  });

  it("sends the populated evidence frame and the resolved citations over the socket", async () => {
    const app = await createServer({ provider: testProvider(), db });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      const frames = [];
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      const done = new Promise((resolve) =>
        ws.on("message", (data) => {
          const frame = JSON.parse(String(data));
          frames.push(frame);
          if (frame.type === "done" || frame.type === "error") resolve(frame);
        }),
      );
      ws.send(JSON.stringify({ type: "turn", thread: "t", turnId: "u", text: "dark stairs" }));
      const last = await done;
      ws.close();
      expect(last.type).toBe("done");
      const evidence = frames.find((f) => f.type === "evidence");
      expect(evidence.blocks.map((b) => [b.evidence, b.documentId, b.header])).toEqual([
        [1, "IWS9", "[Grenfell Inquiry | Witness IWS9 | p.1 para 2]"],
        [2, "IWS9", "[Grenfell Inquiry | Witness IWS9 | p.2 para 5]"],
      ]);
      expect(last.citations[0]).toEqual({
        evidence: 1,
        locator: { document: "IWS9", page: 1, paragraph: 2 },
      });
    } finally {
      await app.close();
    }
  });
});
