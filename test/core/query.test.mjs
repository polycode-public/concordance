// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  checkAnswer,
  citationLocator,
  isAbstention,
  runQuery,
} from "../../packages/core/query.mjs";
import {
  MAX_CONTEXT_CHARS,
  blockChars,
  buildEvidence,
  joinOverlapping,
  loadDocuments,
  neighbourIds,
  withDocuments,
} from "../../packages/core/retrieval/expand.mjs";
import { halfvecLiteral, retrieve } from "../../packages/core/retrieval/hybrid.mjs";
import { evidencePrompt } from "../../packages/core/prompt.mjs";

const chunk = (id, level, extra = {}) => ({
  id,
  document_id: "doc1",
  level,
  text: `text of ${id}`,
  header: `[h ${id}]`,
  locator: { page: Number(id), paragraph: Number(id) * 10 },
  prev_id: null,
  next_id: null,
  parent_id: null,
  ...extra,
});

const rowsOf = (...rows) => new Map(rows.map((r) => [r.id, r]));

describe("joinOverlapping", () => {
  it("writes the shared text of two window passages once", () => {
    const a = "One sentence here. Two sentence here. Three sentence here.";
    const b = "Two sentence here. Three sentence here. Four sentence here.";
    expect(joinOverlapping(a, b)).toBe(
      "One sentence here. Two sentence here. Three sentence here. Four sentence here.",
    );
  });

  it("joins with a space when nothing repeats", () => {
    expect(joinOverlapping("Alpha.", "Beta.")).toBe("Alpha. Beta.");
  });
});

describe("buildEvidence", () => {
  it("adds the previous and next passage to a passage hit and keeps its locator", () => {
    const rows = rowsOf(
      chunk("1", "passage", { next_id: "2" }),
      chunk("2", "passage", { prev_id: "1", next_id: "3" }),
      chunk("3", "passage", { prev_id: "2" }),
    );
    const [block, ...rest] = buildEvidence(["2"], rows);
    expect(rest).toEqual([]);
    expect(block).toMatchObject({
      evidence: 1,
      chunkId: "2",
      chunkIds: ["1", "2", "3"],
      locator: { page: 2, paragraph: 20 },
      header: "[h 2]",
      text: "text of 1 text of 2 text of 3",
    });
  });

  it("collapses passage hits that share a section into that section", () => {
    const rows = rowsOf(
      chunk("10", "section"),
      chunk("1", "passage", { parent_id: "10", next_id: "2" }),
      chunk("2", "passage", { parent_id: "10", prev_id: "1" }),
      chunk("5", "passage"),
    );
    const blocks = buildEvidence(["1", "5", "2"], rows);
    expect(blocks.map((b) => [b.evidence, b.chunkId, b.level])).toEqual([
      [1, "10", "section"],
      [2, "5", "passage"],
    ]);
  });

  it("lets a section hit cover its own passages", () => {
    const rows = rowsOf(chunk("10", "section"), chunk("1", "passage", { parent_id: "10" }));
    expect(buildEvidence(["1", "10"], rows).map((b) => b.chunkId)).toEqual(["10"]);
  });

  it("skips a neighbour that an earlier block already holds", () => {
    const rows = rowsOf(
      chunk("1", "passage", { next_id: "2" }),
      chunk("2", "passage", { prev_id: "1", next_id: "3" }),
      chunk("3", "passage", { prev_id: "2" }),
    );
    const blocks = buildEvidence(["1", "3"], rows);
    expect(blocks.map((b) => b.chunkIds)).toEqual([["1", "2"], ["3"]]);
  });

  it("stops at the character cap and keeps fusion order", () => {
    const big = "x".repeat(MAX_CONTEXT_CHARS - 10);
    const rows = rowsOf(
      chunk("1", "passage"),
      chunk("2", "passage", { text: big }),
      chunk("3", "passage"),
    );
    const blocks = buildEvidence(["1", "2", "3"], rows);
    expect(blocks.map((b) => [b.evidence, b.chunkId])).toEqual([
      [1, "1"],
      [2, "3"],
    ]);
    expect(blocks.reduce((n, b) => n + blockChars(b), 0)).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("keeps at most twelve blocks", () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const blocks = buildEvidence(ids, rowsOf(...ids.map((id) => chunk(id, "passage"))), {
      maxHits: 20,
    });
    expect(blocks).toHaveLength(12);
    expect(blocks.at(-1).evidence).toBe(12);
  });

  it("throws on a hit that was not loaded or has no locator", () => {
    expect(() => buildEvidence(["9"], rowsOf())).toThrow(/not loaded/);
    expect(() => buildEvidence(["1"], rowsOf(chunk("1", "passage", { locator: null })))).toThrow(
      /no locator/,
    );
  });

  it("names the neighbours and parents still to load", () => {
    const hit = chunk("2", "passage", { prev_id: "1", next_id: "3", parent_id: "10" });
    expect(neighbourIds([hit], rowsOf(hit, chunk("1", "passage")))).toEqual(["3", "10"]);
  });
});

describe("loadDocuments", () => {
  const dbOf = (rows) => ({ query: async () => ({ rows }) });

  it("reads title, witness, role, date, type and pages", async () => {
    const docs = await loadDocuments(
      dbOf([
        {
          id: "doc1",
          title: "Statement",
          witness_id: "IWS1",
          role: null,
          witness_role: "Resident",
          statement_date: new Date("2018-02-14T00:00:00Z"),
          format: "pdf",
          page_count: 9,
          cipher_only: false,
        },
      ]),
      ["doc1", "doc1"],
    );
    expect(docs.get("doc1")).toEqual({
      title: "Statement",
      witnessId: "IWS1",
      cipherOnly: false,
      role: "Resident",
      statementDate: "2018-02-14",
      type: "pdf",
      pages: 9,
    });
  });

  it("gives a cipher-only witness its cipher and no title", async () => {
    const docs = await loadDocuments(
      dbOf([
        {
          id: "doc2",
          title: "A name in a title",
          witness_id: "A7",
          role: "Commander",
          cipher_only: true,
          format: "pdf",
          page_count: null,
        },
      ]),
      ["doc2"],
    );
    expect(docs.get("doc2")).toMatchObject({
      title: null,
      witnessId: "A7",
      cipherOnly: true,
      role: null,
    });
  });

  it("asks the database for nothing when no block cites a document", async () => {
    const docs = await loadDocuments({ query: () => Promise.reject(new Error("asked")) }, []);
    expect(docs.size).toBe(0);
  });

  it("throws when a block's document row is missing", () => {
    expect(() => withDocuments([{ documentId: "gone" }], new Map())).toThrow(/not loaded/);
  });
});

describe("checkAnswer", () => {
  const blocks = [
    { evidence: 1, documentId: "doc1", locator: { paragraph: 11, page: 3, line: 4 } },
    { evidence: 2, documentId: "doc2", locator: { page: 7 } },
  ];

  it("resolves tags to document, page and paragraph in that key order", () => {
    const { citations } = checkAnswer(
      "The stairs were dark [E1]. Smoke filled them [E2][E1].",
      blocks,
    );
    expect(citations).toEqual([
      { evidence: 1, locator: { document: "doc1", page: 3, paragraph: 11 } },
      { evidence: 2, locator: { document: "doc2", page: 7, paragraph: null } },
    ]);
    expect(JSON.stringify(citations[0].locator)).toBe(
      '{"document":"doc1","page":3,"paragraph":11}',
    );
  });

  it("drops a tag with no block and does not count it as support", () => {
    const { citations, checks } = checkAnswer("One [E1]. Two [E9]. Three.", blocks);
    expect(citations.map((c) => c.evidence)).toEqual([1]);
    expect(checks).toMatchObject({
      sentences: 3,
      supported: 1,
      droppedCitations: 1,
      warning: true,
    });
    expect(checks.marks.map((m) => m.supported)).toEqual([true, false, false]);
  });

  it("reads the locator from the block without deriving one", () => {
    expect(citationLocator({ documentId: "d", locator: {} })).toEqual({
      document: "d",
      page: null,
      paragraph: null,
    });
  });
});

describe("abstention and prompt", () => {
  it("abstains on the closed-world phrase or on no evidence", () => {
    expect(isAbstention("The corpus does not say.", [{}])).toBe(true);
    expect(
      isAbstention("The corpus does not say about floor 17. One resident saw smoke [E1].", [{}]),
    ).toBe(false);
    expect(isAbstention("The corpus does not say about floor 17.", [{}])).toBe(true);
    expect(isAbstention("It was dark [E1].", [])).toBe(true);
    expect(isAbstention("It was dark [E1].", [{}])).toBe(false);
  });

  it("numbers evidence blocks with their header", () => {
    expect(evidencePrompt([{ header: "[h]", text: "t" }])).toBe("[E1] [h]\nt");
    expect(evidencePrompt([])).toBe("Evidence blocks: none.");
  });
});

describe("runQuery", () => {
  const row = {
    id: "1",
    document_id: "doc1",
    level: "passage",
    text: "The stairs were dark.",
    header: "[h]",
    locator: { page: 3, paragraph: 11 },
    prev_id: null,
    next_id: null,
    parent_id: null,
  };
  const db = {
    query: async (text) => {
      if (/FROM documents/.test(text)) {
        return {
          rows: [{ id: "doc1", title: "T", witness_id: "W1", format: "pdf", page_count: 9 }],
        };
      }
      return { rows: /SELECT id FROM/.test(text) ? [{ id: "1" }] : [row] };
    },
  };
  const providerOf = (reply) => ({
    name: "p",
    embedModel: "m",
    embedDim: 1024,
    embed: async () => [new Array(1024).fill(0.5)],
    chat: async () => reply,
  });

  it("returns every stage time and passes the usage through", async () => {
    const usage = { inputTokens: 12, outputTokens: 5 };
    const result = await runQuery({
      question: "q",
      db,
      provider: providerOf({ text: "Dark [E1].", model: "m", promptVersion: "v", usage }),
    });
    expect(Object.keys(result.checks.timings)).toEqual([
      "rewriting",
      "retrieving",
      "answering",
      "checking",
    ]);
    for (const ms of Object.values(result.checks.timings)) expect(ms).toBeGreaterThanOrEqual(0);
    expect(result.checks.usage).toEqual(usage);
    expect(result.checks).toMatchObject({ sentences: 1, supported: 1 });
  });

  it("scores no sentence and cites nothing on an abstention", async () => {
    const result = await runQuery({
      question: "q",
      db,
      provider: providerOf({
        text: "The corpus does not say.",
        model: "m",
        promptVersion: "v",
        usage: null,
      }),
    });
    expect(result.abstained).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.checks).toMatchObject({
      abstained: true,
      sentences: 0,
      supported: 0,
      warning: false,
      marks: [],
      usage: null,
    });
  });
});

describe("retrieval guards", () => {
  it("rejects an embedding of the wrong length", () => {
    expect(() => halfvecLiteral([1, 2, 3])).toThrow(/3 dimensions/);
    expect(halfvecLiteral(new Array(1024).fill(0.5))).toMatch(/^\[0\.5,0\.5,/);
  });

  it("rejects a provider that embeds another dimension", async () => {
    const db = { query: async () => ({ rows: [] }) };
    await expect(
      retrieve({ question: "q", provider: { name: "p", embedModel: "m", embedDim: 4 }, db }),
    ).rejects.toThrow(/4 dimensions/);
  });

  it("needs a database", async () => {
    await expect(runQuery({ question: "q", provider: {} })).rejects.toThrow(/needs a database/);
  });
});
