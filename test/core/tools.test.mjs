// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { beforeEach, describe, expect, it } from "vitest";
import { runComparison } from "../../packages/core/facts/compare.mjs";
import { STORE_TOOLS, buildTools } from "../../packages/core/tools/index.mjs";
import { countSql } from "../../packages/core/tools/countAssertions.mjs";
import { DOCUMENT_FACTS_SQL } from "../../packages/core/tools/documentFacts.mjs";
import {
  MAX_TOOL_ROWS,
  ToolInputError,
  chunkIdsOf,
  clockMinutes,
} from "../../packages/core/tools/shared.mjs";
import { WITNESS_CLAIMS_SQL } from "../../packages/core/tools/witnessClaims.mjs";
import { HISTORY_SQL } from "../../packages/core/spend.mjs";
import { createCompareStore } from "./compareFakeStore.mjs";
import { toolStore } from "./toolsFakeStore.mjs";
import { compareProvider, compareSeed } from "./compareFixture.mjs";

const CORPUS = "grenfell";

let db;
let tools;
const tool = (name) => tools.find((x) => x.name === name);
const evidenceOf = (result) => result.evidence.map((b) => [b.chunkId, b.locator]);

beforeEach(async () => {
  const store = createCompareStore(compareSeed());
  const { provider } = compareProvider();
  await runComparison({ corpus: CORPUS, db: store, provider, log: () => {} });
  db = toolStore(store);
  tools = buildTools({ db, corpus: CORPUS, provider });
});

describe("the tool list", () => {
  it("offers the eight store tools, each with a description and an object schema", () => {
    expect(tools.map((x) => x.name)).toEqual([
      "count_assertions",
      "witness_claims",
      "timeline_window",
      "matrix_cell",
      "corroborated_contradictions",
      "document_facts",
      "search_chunks",
      "usage_summary",
    ]);
    for (const x of STORE_TOOLS) {
      expect(x.description.length).toBeGreaterThan(40);
      expect(x.inputSchema.type).toBe("object");
    }
  });

  it("needs a database and a corpus", () => {
    expect(() => buildTools({ corpus: CORPUS })).toThrow(/database/);
    expect(() => buildTools({ db })).toThrow(/corpus/);
  });
});

describe("matrix_cell", () => {
  it("lists the pairs between two witnesses with both sentences as evidence, in either order", async () => {
    const result = await tool("matrix_cell").run({
      witnessA: "C123",
      witnessB: "IWS-A",
      event: "Smoke in the lobby",
    });
    expect(result.counts).toEqual({ agree: 1, contradict: 1, unrelated: 0 });
    expect(result.rows.map((r) => r.label)).toEqual(["contradict", "agree"]);
    const [row] = result.rows;
    expect(row).toMatchObject({ kind: "cross", label: "contradict", identityRevealing: false });
    expect(new Set([row.a.chunkId, row.b.chunkId])).toEqual(new Set(["101", "103"]));
    expect(evidenceOf(result)).toEqual(
      expect.arrayContaining([
        ["101", { page: 2, paragraph: 5 }],
        ["103", { page: 1, paragraph: 4 }],
      ]),
    );
    const reversed = await tool("matrix_cell").run({ witnessA: "IWS-A", witnessB: "C123" });
    expect(reversed.rows.map((r) => r.comparisonId)).toContain(row.comparisonId);
  });

  it("gives an identity-revealing pair without sentences, spans, reason or evidence", async () => {
    const result = await tool("matrix_cell").run({ witnessA: "IWS-B", witnessB: "C123" });
    const hidden = result.rows.find((r) => r.identityRevealing);
    expect(hidden).toMatchObject({ reason: null, spanA: null, spanB: null });
    expect(chunkIdsOf(hidden)).toEqual([]);
    expect(Object.keys(hidden.a)).toEqual(["assertionId", "witnessId"]);
    expect(result.evidence.map((b) => b.chunkId)).not.toContain("102");
  });
});

describe("corroborated_contradictions", () => {
  it("lists an assertion that two other witnesses contradict, with every pair", async () => {
    const result = await tool("corroborated_contradictions").run({});
    const row = result.rows.find((r) => r.assertion.assertionId === "3");
    expect(row).toMatchObject({
      event: "smoke in the lobby",
      predicate: "saw",
      witnesses: 2,
      assertion: { witnessId: "C123", chunkId: "103" },
    });
    expect(row.contradictedBy.map((p) => p.label)).toEqual(["contradict", "contradict"]);
    expect(row.contradictedBy.filter((p) => p.identityRevealing)).toHaveLength(1);
    expect(result.evidence.map((b) => b.chunkId)).toContain("103");
    for (const r of result.rows) expect(r.witnesses).toBeGreaterThanOrEqual(2);
  });

  it("reads the newest label of each pair from the one corpus and takes a higher bar", async () => {
    await tool("corroborated_contradictions").run({ event: "smoke in the lobby" });
    const read = db.statements.findLast((s) => /label = 'contradict'/.test(s.text));
    expect(read.params).toEqual([CORPUS, "7"]);
    expect(read.text).toMatch(/\(model = 'operator'\) DESC, run_at DESC/);
    expect((await tool("corroborated_contradictions").run({ minWitnesses: 3 })).rows).toEqual([]);
    await expect(tool("corroborated_contradictions").run({ minWitnesses: 1 })).rejects.toThrow(
      ToolInputError,
    );
  });
});

describe("timeline_window", () => {
  it("keeps the assertions whose stated window overlaps the clock range, earliest first", async () => {
    const result = await tool("timeline_window").run({ from: "00:55", to: "01:05" });
    const ids = result.rows.map((r) => r.assertionId);
    expect(ids).toEqual(expect.arrayContaining(["1", "2"]));
    expect(ids).not.toContain("3");
    expect(ids).not.toContain("8");
    expect(result.rows[0].window).toMatchObject({ from: "00:50", to: "01:10", hedged: true });
    expect(evidenceOf(result)).toEqual(
      expect.arrayContaining([
        ["101", { page: 2, paragraph: 5 }],
        ["102", { page: 3, paragraph: 7 }],
      ]),
    );
  });

  it("filters by witness and refuses a range that is not two clock times", async () => {
    const result = await tool("timeline_window").run({
      from: "01:00",
      to: "02:30",
      witness: "C123",
    });
    expect(result.rows.map((r) => r.assertionId)).toEqual(["3", "8"]);
    await expect(tool("timeline_window").run({ from: "01:00" })).rejects.toThrow(/together/);
    await expect(tool("timeline_window").run({ from: "1am", to: "2am" })).rejects.toThrow(/HH:MM/);
    await expect(tool("timeline_window").run({ from: "02:00", to: "01:00" })).rejects.toThrow(
      /earlier/,
    );
  });
});

describe("count_assertions", () => {
  it("counts the assertions in a clock range by witness, with examples as evidence", async () => {
    const result = await tool("count_assertions").run({
      groupBy: "witness",
      from: "01:25",
      to: "01:35",
    });
    expect(result.rows).toEqual([
      { witness: "C123", count: 1, examples: [{ chunkId: "103" }] },
      { witness: "IWS-A", count: 1, examples: [{ chunkId: "106" }] },
    ]);
    expect(result.total).toBe(2);
    expect(evidenceOf(result)).toEqual([
      ["103", { page: 1, paragraph: 4 }],
      ["106", { page: 1, paragraph: 3 }],
    ]);
  });

  it("counts by event name inside a clock range", async () => {
    const result = await tool("count_assertions").run({
      groupBy: "event",
      from: "00:00",
      to: "03:00",
    });
    expect(result.rows.map((r) => [r.event, r.count])).toEqual([
      ["smoke in the lobby", 4],
      ["leaving the flat", 1],
    ]);
  });

  it("counts in SQL scoped to the corpus when no clock range is given", async () => {
    const calls = [];
    const sqlDb = {
      async query(text, params) {
        calls.push({ text, params });
        if (/lower\(name\)/.test(text)) return { rows: [{ id: "7" }] };
        if (text === countSql("predicate")) {
          return { rows: [{ key: "saw", n: "3", total: "5", chunk_ids: "103,102" }] };
        }
        return db.query(text, params);
      },
    };
    const [count] = buildTools({ db: sqlDb, corpus: CORPUS, provider: {} });
    const result = await count.run({ groupBy: "predicate", witness: "C123", event: "x" });
    expect(calls.find((c) => c.text === countSql("predicate")).params).toEqual([
      CORPUS,
      "C123",
      null,
      "7",
    ]);
    expect(result).toMatchObject({
      total: 5,
      truncated: false,
      rows: [{ predicate: "saw", count: 3, examples: [{ chunkId: "103" }, { chunkId: "102" }] }],
    });
    expect(result.evidence.map((b) => b.chunkId)).toEqual(["103", "102"]);
    expect(countSql("witness")).toMatch(/WHERE c\.corpus = \$1/);
    expect(countSql("event")).toMatch(/GROUP BY 1/);
    await expect(count.run({ groupBy: "colour" })).rejects.toThrow(/groupBy is one of/);
  });
});

describe("witness_claims", () => {
  it("lists a witness's assertions with their sentences and marks a cut list", async () => {
    const many = Array.from({ length: MAX_TOOL_ROWS + 1 }, (_, i) => ({
      id: String(i + 1),
      witness_id: "IWS-A",
      document_id: "IWS-A1",
      subject_text: "I",
      predicate: "saw",
      object_text: "smoke",
      time_text: null,
      place_text: "the lobby",
      polarity: "positive",
      modality: null,
      event: "smoke in the lobby",
      source_chunk_id: "101",
    }));
    let params;
    const sqlDb = {
      async query(text, p) {
        if (text === WITNESS_CLAIMS_SQL) {
          params = p;
          return { rows: many };
        }
        return db.query(text, p);
      },
    };
    const claims = buildTools({ db: sqlDb, corpus: CORPUS, provider: {} }).find(
      (x) => x.name === "witness_claims",
    );
    const result = await claims.run({ witness: "IWS-A", predicate: "saw" });
    expect(params).toEqual([CORPUS, "IWS-A", "saw", null]);
    expect(result.rows).toHaveLength(MAX_TOOL_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.rows[0]).toEqual({
      assertionId: "1",
      witnessId: "IWS-A",
      documentId: "IWS-A1",
      subject: "I",
      predicate: "saw",
      object: "smoke",
      time: null,
      polarity: "positive",
      chunkId: "101",
      place: "the lobby",
      modality: null,
      event: "smoke in the lobby",
    });
    expect(result.evidence).toHaveLength(1);
    await expect(claims.run({})).rejects.toThrow(/needs witness/);
  });
});

describe("document_facts", () => {
  it("gives each document's facts and first passage, and a cipher's document no title", async () => {
    let params;
    const sqlDb = {
      async query(text, p) {
        if (text === DOCUMENT_FACTS_SQL) {
          params = p;
          return {
            rows: [
              { id: "IWS-A1", first_chunk: "101" },
              { id: "C123-1", first_chunk: "103" },
            ],
          };
        }
        return db.query(text, p);
      },
    };
    const facts = buildTools({ db: sqlDb, corpus: CORPUS, provider: {} }).find(
      (x) => x.name === "document_facts",
    );
    const result = await facts.run({});
    expect(params).toEqual([CORPUS, null, null]);
    expect(result.rows).toEqual([
      {
        documentId: "IWS-A1",
        title: "Statement IWS-A1",
        witnessId: "IWS-A",
        cipherOnly: false,
        role: "Resident",
        statementDate: "2017-09-01",
        type: "pdf",
        pages: 4,
        chunkId: "101",
      },
      {
        documentId: "C123-1",
        title: null,
        witnessId: "C123",
        cipherOnly: true,
        role: null,
        statementDate: "2018-01-15",
        type: "pdf",
        pages: 4,
        chunkId: "103",
      },
    ]);
    expect(result.evidence.map((b) => b.document.title)).toEqual(["Statement IWS-A1", null]);
    expect(DOCUMENT_FACTS_SQL).toMatch(/d\.corpus = \$1/);
  });
});

describe("search_chunks", () => {
  const row = {
    id: "1",
    document_id: "IWS-A1",
    level: "passage",
    text: "The stairs were dark.",
    header: "[h]",
    locator: { page: 3, paragraph: 9 },
    prev_id: null,
    next_id: null,
    parent_id: null,
  };
  const provider = {
    name: "p",
    embedModel: "m",
    embedDim: 1024,
    embed: async () => [new Array(1024).fill(0.5)],
  };

  it("runs the hybrid retrieval over the phrase in one witness's documents", async () => {
    const calls = [];
    const sqlDb = {
      async query(text, params) {
        calls.push({ text, params });
        if (/SELECT id FROM documents WHERE corpus/.test(text)) return { rows: [{ id: "IWS-A1" }] };
        if (/SELECT id FROM chunks/.test(text)) return { rows: [{ id: "1" }] };
        if (/FROM chunks WHERE id = ANY/.test(text)) return { rows: [row] };
        return db.query(text, params);
      },
    };
    const search = buildTools({ db: sqlDb, corpus: CORPUS, provider }).find(
      (x) => x.name === "search_chunks",
    );
    const result = await search.run({ phrase: "dark stairs", witness: "IWS-A" });
    expect(result.rows).toEqual([{ documentId: "IWS-A1", chunkId: "1" }]);
    expect(result.evidence[0]).toMatchObject({ chunkId: "1", text: "The stairs were dark." });
    const rankings = calls.filter((c) => /SELECT id FROM chunks/.test(c.text));
    expect(rankings).toHaveLength(4);
    for (const { params } of rankings) expect(params).toContainEqual(["IWS-A1"]);
  });

  it("returns nothing for a witness with no document in the corpus", async () => {
    const sqlDb = { query: async () => ({ rows: [] }) };
    const search = buildTools({ db: sqlDb, corpus: CORPUS, provider }).find(
      (x) => x.name === "search_chunks",
    );
    expect(await search.run({ phrase: "x", witness: "NOBODY" })).toEqual({
      rows: [],
      evidence: [],
    });
  });
});

describe("usage_summary", () => {
  it("gives this corpus's use newest first with its list-price cost and no evidence", async () => {
    let params;
    const sqlDb = {
      async query(text, p) {
        expect(text).toBe(HISTORY_SQL);
        params = p;
        return {
          rows: [
            {
              corpus: CORPUS,
              day: "2026-10-19",
              model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
              source: "turn",
              requests: "2",
              input_tokens: "1000000",
              output_tokens: "0",
            },
            {
              corpus: "ucpi",
              day: "2026-10-19",
              model: "x",
              source: "turn",
              requests: "1",
              input_tokens: "1",
              output_tokens: "1",
            },
            {
              corpus: CORPUS,
              day: "2026-10-20",
              model: "unknown-model",
              source: "report",
              requests: "1",
              input_tokens: "5",
              output_tokens: "6",
            },
          ],
        };
      },
    };
    const usage = buildTools({ db: sqlDb, corpus: CORPUS, provider: {} }).find(
      (x) => x.name === "usage_summary",
    );
    const result = await usage.run({ days: 7 });
    expect(params).toEqual([7]);
    expect(result.evidence).toEqual([]);
    expect(result.rows.map((r) => [r.day, r.source, r.requests, r.cost === null])).toEqual([
      ["2026-10-20", "report", 1, true],
      ["2026-10-19", "turn", 2, false],
    ]);
    expect(result.rows[1].cost).toBeGreaterThan(0);
    await expect(usage.run({ days: 0 })).rejects.toThrow(/days/);
  });
});

describe("the clock", () => {
  it("reads HH:MM on the night's scale, with the evening before as negative minutes", () => {
    expect(clockMinutes("01:30")).toBe(90);
    expect(clockMinutes("23:00")).toBe(-60);
    expect(() => clockMinutes("24:00")).toThrow(ToolInputError);
  });
});
