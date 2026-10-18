// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Docker tier: npm run db:up, then CONCORDANCE_DB_TESTS=1 npm test. The run migrates into
// its own schema and drops it afterwards.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/db-migrate.mjs";
import { DEFAULT_DATABASE_URL } from "../../packages/core/db.mjs";
import { ingestDocument } from "../../packages/core/ingest/run.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";

const enabled = process.env.CONCORDANCE_DB_TESTS === "1";
if (!enabled) console.log("database tier skipped: set CONCORDANCE_DB_TESTS=1 to run it");

const schema = `test_${process.pid}_${Date.now()}`;

const PAGES = [
  {
    page: 1,
    text: [
      "1. I lived on the eighteenth floor of Grenfell Tower. I lived there with my family.",
      "   My flat faced east.",
      "2. On the night of 13 June 2017 I went to bed at 23:30. I was woken by a neighbour",
      "   at 01:10. She said there was a fire. I looked out of the window. I saw smoke below me.",
      "3. I left the flat at 01:20. The lobby was clear",
    ].join("\n"),
  },
  {
    page: 2,
    text: [
      "   of smoke at that time. I took the stairs down. The stairs were dark.",
      "4. I reached the ground floor at 01:35. A firefighter took me outside.",
    ].join("\n"),
  },
];

const META = {
  evidenceId: "IWS00000001",
  corpus: "grenfell",
  sourceUrl: "https://example.test/IWS00000001.pdf",
  fetchedAt: "2026-10-18T12:00:00Z",
  sha256: "b".repeat(64),
  licence: "OGL-3.0",
  witnessId: "IWS00000001",
  role: "resident, floor 18",
  statementDate: "2019-08-06",
};

const EXPECTED = { document: 1, section: 4, passage: 5, sentence: 14 };

describe.skipIf(!enabled)("ingestDocument (CONCORDANCE_DB_TESTS=1)", () => {
  let db;
  let provider;
  const prompts = [];
  const embedCalls = [];

  const levelCounts = async () => {
    const { rows } = await db.query(
      "SELECT level::text AS level, count(*)::int AS n FROM chunks GROUP BY level",
    );
    return Object.fromEntries(rows.map((r) => [r.level, r.n]));
  };
  const tableCounts = async () => {
    const out = {};
    for (const table of ["documents", "witnesses", "chunks", "provenance"]) {
      out[table] = (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    }
    return out;
  };

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public` });
    db = { pool, query: (text, params) => pool.query(text, params) };
    const client = await pool.connect();
    try {
      await migrate(client, { log: () => {} });
    } finally {
      client.release();
    }
    const fake = createFakeProvider({
      tokens: [],
      embedDim: 1024,
      extractJson: ({ prompt }) => {
        prompts.push(prompt);
        return { abstract: "fake abstract", context: "fake context" };
      },
    });
    provider = {
      ...fake,
      embed: (texts) => {
        embedCalls.push(texts.length);
        return fake.embed(texts);
      },
    };
  });
  afterAll(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  it("writes the document, the witness and every chunk level", async () => {
    const result = await ingestDocument({ pages: PAGES, meta: META, provider, db, log: () => {} });
    expect(result).toEqual({ status: "ingested", counts: EXPECTED });
    expect(prompts).toHaveLength(EXPECTED.section + 1);
    expect(embedCalls).toEqual([24]);
    expect(await levelCounts()).toEqual(EXPECTED);

    const docs = await db.query("SELECT * FROM documents");
    expect(docs.rows).toHaveLength(1);
    expect(docs.rows[0]).toMatchObject({
      id: META.evidenceId,
      corpus: "grenfell",
      format: "pdf",
      witness_id: META.witnessId,
      role: META.role,
      page_count: 2,
      locator_scheme: "page-paragraph",
      abstract: "fake abstract",
      pipeline_version: "ingest-v1",
    });
    const witnesses = await db.query("SELECT id, role FROM witnesses");
    expect(witnesses.rows).toEqual([{ id: META.witnessId, role: META.role }]);
  });

  it("chains passages by prev_id and next_id in ordinal order", async () => {
    const { rows } = await db.query(
      "SELECT id, prev_id, next_id FROM chunks WHERE level = 'passage' ORDER BY ordinal",
    );
    expect(rows).toHaveLength(EXPECTED.passage);
    rows.forEach((row, i) => {
      expect(row.prev_id).toBe(rows[i - 1]?.id ?? null);
      expect(row.next_id).toBe(rows[i + 1]?.id ?? null);
    });
  });

  it("links each chunk to its enclosing chunk", async () => {
    const { rows } = await db.query(
      `SELECT c.level::text AS level, p.level::text AS parent_level, count(*)::int AS n
         FROM chunks c LEFT JOIN chunks p ON p.id = c.parent_id
        GROUP BY 1, 2 ORDER BY 1`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { level: "document", parent_level: null, n: 1 },
        { level: "section", parent_level: "document", n: 4 },
        { level: "passage", parent_level: "section", n: 5 },
        { level: "sentence", parent_level: "section", n: 14 },
      ]),
    );
  });

  it("stores a page and paragraph locator, a header and an embedding on every chunk", async () => {
    const { rows } = await db.query(
      `SELECT level::text AS level, ordinal, locator, header, context_line, embedding_model,
              embedding_dim, embedding IS NOT NULL AS embedded, pipeline_version
         FROM chunks`,
    );
    for (const row of rows) {
      expect(Object.keys(row.locator).sort()).toEqual(["page", "paragraph"]);
      expect(row.header).toMatch(
        /^\[Grenfell Inquiry \| Witness IWS00000001 \| resident, floor 18/,
      );
      expect(row).toMatchObject({
        embedding_model: "fake-embed",
        embedding_dim: 1024,
        embedded: true,
        pipeline_version: "ingest-v1",
      });
      if (row.level !== "document") {
        expect(row.context_line).toBe("fake context");
        expect(row.locator.paragraph).toEqual(expect.any(Number));
      }
    }
    const sections = rows
      .filter((r) => r.level === "section")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => r.locator);
    expect(sections).toEqual([
      { page: 1, paragraph: 1 },
      { page: 1, paragraph: 2 },
      { page: 1, paragraph: 3 },
      { page: 2, paragraph: 4 },
    ]);
  });

  it("records provenance for the text, the abstract and each context line", async () => {
    const { rows } = await db.query(
      `SELECT step, count(*)::int AS n, bool_and(source_sha256 = $1) AS from_source
         FROM provenance GROUP BY step ORDER BY step`,
      [META.sha256],
    );
    expect(rows).toEqual([
      { step: "abstract", n: 1, from_source: true },
      { step: "context-line", n: 4, from_source: true },
      { step: "extract-text", n: 1, from_source: true },
    ]);
  });

  it("inserts nothing on a second run", async () => {
    const before = await tableCounts();
    const result = await ingestDocument({ pages: PAGES, meta: META, provider, db, log: () => {} });
    expect(result.status).toBe("skipped");
    expect(await tableCounts()).toEqual(before);
  });

  it("fails a document with no numbered paragraph and writes nothing for it", async () => {
    const before = await tableCounts();
    await expect(
      ingestDocument({
        pages: [{ page: 1, text: "A covering letter." }],
        meta: { ...META, evidenceId: "IWS00000002", sha256: "c".repeat(64) },
        provider,
        db,
        log: () => {},
      }),
    ).rejects.toThrow(/no numbered paragraph/);
    expect(await tableCounts()).toEqual(before);
  });

  it("replaces the chunks when the pipeline version changes", async () => {
    const result = await ingestDocument({
      pages: PAGES,
      meta: META,
      provider,
      db,
      pipelineVersion: "ingest-test-v2",
      log: () => {},
    });
    expect(result).toEqual({ status: "replaced", counts: EXPECTED });
    expect(await levelCounts()).toEqual(EXPECTED);
    const versions = await db.query("SELECT DISTINCT pipeline_version FROM chunks");
    expect(versions.rows).toEqual([{ pipeline_version: "ingest-test-v2" }]);
  });
});
