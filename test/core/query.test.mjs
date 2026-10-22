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
import {
  halfvecLiteral,
  namedWitnessScope,
  namedWitnesses,
  residentFlats,
  quotedPhrases,
  retrieve,
} from "../../packages/core/retrieval/hybrid.mjs";
import {
  PROMPT_VERSION,
  RERANK_PROMPT_VERSION,
  REWRITE_PROMPT_VERSION,
  evidencePrompt,
} from "../../packages/core/prompt.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";

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
          statement_date: new Date(2018, 1, 14),
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
      corpus: "grenfell",
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
      corpus: "grenfell",
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

describe("query rewrite", () => {
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
  const recordingDb = () => {
    const calls = [];
    return {
      calls,
      query: async (text, params) => {
        calls.push({ text, params });
        if (/FROM documents/.test(text)) {
          return {
            rows: [{ id: "doc1", title: "T", witness_id: "W1", format: "pdf", page_count: 9 }],
          };
        }
        return { rows: /SELECT id FROM/.test(text) ? [{ id: "1" }] : [row] };
      },
    };
  };
  const rewritingProvider = (rewriteText) => {
    const chats = [];
    const embedded = [];
    return {
      chats,
      embedded,
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async (texts) => {
        embedded.push(texts);
        return texts.map(() => new Array(1024).fill(0.5));
      },
      chat: async (args) => {
        chats.push(args);
        if (args.promptVersion === REWRITE_PROMPT_VERSION) {
          return {
            text: rewriteText,
            model: "m",
            promptVersion: args.promptVersion,
            usage: { inputTokens: 40, outputTokens: 8 },
          };
        }
        return {
          text: "Dark [E1].",
          model: "m",
          promptVersion: args.promptVersion,
          usage: { inputTokens: 100, outputTokens: 5 },
        };
      },
    };
  };
  const history = [
    { question: "Who was on floor 2?", answer: "Nobody [E1]." },
    { question: "Who lived on floor 4?", answer: "Witness IWS9 lived there [E2]." },
    { question: "Was the lift working?", answer: "It was not [E1][E3]." },
    { question: "Where did she go?", answer: "She went to the stairs [E4]." },
  ];

  it("makes no rewrite call for a question with no earlier turn", async () => {
    const provider = rewritingProvider("{}");
    const result = await runQuery({
      question: "q",
      corpus: "grenfell",
      db: recordingDb(),
      provider,
    });
    expect(provider.chats.map((c) => c.promptVersion)).toEqual([PROMPT_VERSION]);
    expect(provider.embedded).toEqual([["q"]]);
    expect(result.queryRewrites).toEqual([]);
    expect(result.checks.rewritePromptVersion).toBeNull();
  });

  it("rewrites the question and the last three turns into queries and retrieves each", async () => {
    const provider = rewritingProvider(
      '{"queries": ["where IWS9 went from floor 4", "IWS9 stairs floor 4"]}',
    );
    const db = recordingDb();
    const stages = [];
    const result = await runQuery({
      question: "And after that?",
      corpus: "grenfell",
      db,
      provider,
      history,
      onStage: (s) => stages.push(s),
    });
    const [rewrite, answer] = provider.chats;
    expect(rewrite).toMatchObject({ temperature: 0, promptVersion: REWRITE_PROMPT_VERSION });
    expect(rewrite.onToken).toBeUndefined();
    expect(rewrite.tools).toBeUndefined();
    const prompt = rewrite.messages.at(-1).content;
    expect(prompt).not.toContain("floor 2");
    expect(prompt).toContain("Turn 1 question: Who lived on floor 4?");
    expect(prompt).toContain("Turn 3 answer: She went to the stairs.");
    expect(prompt).not.toMatch(/\[E\d\]/);
    expect(prompt).toMatch(/Last question: And after that\?$/);
    expect(answer.promptVersion).toBe(PROMPT_VERSION);
    expect(answer.messages.at(-1).content).toMatch(/Question: And after that\?$/);
    expect(provider.embedded).toEqual([["where IWS9 went from floor 4", "IWS9 stairs floor 4"]]);
    const lexical = db.calls.filter((c) => /tsv @@/.test(c.text));
    expect(lexical).toHaveLength(4);
    expect(new Set(lexical.map((c) => c.params.find((p) => /iws9/.test(p))))).toEqual(
      new Set(["where or iws9 or went or from or floor or 4", "iws9 or stairs or floor or 4"]),
    );
    expect(stages.slice(0, 2)).toEqual(["rewriting", "retrieving"]);
    expect(result.queryRewrites).toEqual(["where IWS9 went from floor 4", "IWS9 stairs floor 4"]);
    expect(result.checks.rewritePromptVersion).toBe(REWRITE_PROMPT_VERSION);
    expect(result.checks.usage).toEqual({ inputTokens: 140, outputTokens: 13 });
  });

  it("fuses the rankings of every query, so a chunk found by two queries comes first", async () => {
    const provider = rewritingProvider('{"queries": ["alpha", "beta"]}');
    const db = {
      query: async (text, params) => {
        if (/SELECT id FROM chunks/.test(text)) {
          const query = params.find((p) => p === "alpha" || p === "beta");
          if (query === "alpha") return { rows: [{ id: "5" }, { id: "1" }] };
          if (query === "beta") return { rows: [{ id: "6" }, { id: "1" }] };
          return { rows: [] };
        }
        if (/FROM chunks WHERE id = ANY/.test(text)) {
          return { rows: params[0].map((id) => ({ ...row, id })) };
        }
        return recordingDb().query(text, params);
      },
    };
    const result = await runQuery({ question: "q", corpus: "grenfell", db, provider, history });
    expect(result.retrievedIds[0]).toBe("1");
    expect(result.retrievedIds).toEqual(expect.arrayContaining(["5", "6"]));
  });

  it("throws on a rewrite reply with no queries or too many", async () => {
    for (const text of ['{"queries": []}', '{"queries": ["a", "b", "c", "d"]}', "no json"]) {
      await expect(
        runQuery({
          question: "q",
          corpus: "grenfell",
          db: recordingDb(),
          provider: rewritingProvider(text),
          history,
        }),
      ).rejects.toThrow(/queries|invalid JSON/);
    }
  });
});

describe("reranking", () => {
  const rowOf = (id) => ({
    id,
    document_id: "doc1",
    level: "passage",
    text: `text of ${id}`,
    header: `[h ${id}]`,
    locator: { page: Number(id), paragraph: Number(id) },
    prev_id: null,
    next_id: null,
    parent_id: null,
  });
  const fusedIds = Array.from({ length: 45 }, (_, i) => String(i + 1));
  const db = {
    query: async (text, params) => {
      if (/FROM documents/.test(text)) {
        return {
          rows: [{ id: "doc1", title: "T", witness_id: "W1", format: "pdf", page_count: 9 }],
        };
      }
      if (/SELECT id FROM chunks/.test(text)) return { rows: fusedIds.map((id) => ({ id })) };
      if (/FROM chunks WHERE id = ANY/.test(text)) return { rows: params[0].map(rowOf) };
      return { rows: [] };
    },
  };
  const provider = (rerank) =>
    createFakeProvider({ tokens: ["Dark [E1]."], delayMs: 0, embedDim: 1024, rerank });

  it("orders the top 40 fused candidates by score before expansion and stores the scores", async () => {
    const p = provider((question, passages) =>
      passages.map(({ id }) => ({ id, score: id === "7" ? 3 : id === "30" ? 2 : 0 })),
    );
    const result = await runQuery({
      question: "Were the stairs dark?",
      corpus: "grenfell",
      db,
      provider: p,
    });
    expect(p.rerankCalls).toHaveLength(1);
    expect(p.rerankCalls[0].question).toBe("Were the stairs dark?");
    expect(p.rerankCalls[0].passages.map((x) => x.id)).toEqual(fusedIds.slice(0, 40));
    expect(p.rerankCalls[0].passages[0]).toEqual({ id: "1", header: "[h 1]", text: "text of 1" });
    expect(result.evidenceBlocks.slice(0, 3).map((b) => b.chunkId)).toEqual(["7", "30", "1"]);
    expect(result.rerankerScores).toMatchObject({ 7: 3, 30: 2, 1: 0 });
    expect(Object.keys(result.rerankerScores)).toHaveLength(40);
    expect(result.checks.rerankPromptVersion).toBe(RERANK_PROMPT_VERSION);
  });

  it("keeps the fused order and stores no scores when the provider has no reranker", async () => {
    const result = await runQuery({ question: "q", corpus: "grenfell", db, provider: provider() });
    expect(result.evidenceBlocks.slice(0, 2).map((b) => b.chunkId)).toEqual(["1", "2"]);
    expect(result.rerankerScores).toEqual({});
    expect(result.checks.rerankPromptVersion).toBeNull();
  });

  it("throws when the reranker scores another list of passages", async () => {
    const p = provider((question, passages) =>
      passages.slice(1).map(({ id }) => ({ id, score: 1 })),
    );
    await expect(runQuery({ question: "q", corpus: "grenfell", db, provider: p })).rejects.toThrow(
      /scored 39 of 40/,
    );
  });
});

describe("witness names and quoted phrases", () => {
  const witnesses = [
    { id: "IWS9", names: ["IWS9", "Ada Lovelace", "Lovelace"] },
    { id: "IWS10", names: ["IWS10", "Ada"] },
  ];

  it("finds a witness by any alias, the longest name first, and takes it out of the query", () => {
    expect(namedWitnesses("What did Ada Lovelace see?", witnesses)).toEqual({
      rest: "what did see",
      nameGroups: [["IWS9", "Ada Lovelace", "Lovelace"]],
      witnessIds: ["IWS9"],
    });
    expect(namedWitnesses("Did ada and LOVELACE meet?", witnesses)).toEqual({
      rest: "did and meet",
      nameGroups: [
        ["IWS9", "Ada Lovelace", "Lovelace"],
        ["IWS10", "Ada"],
      ],
      witnessIds: ["IWS9", "IWS10"],
    });
    expect(namedWitnesses("smoke in the lobby", witnesses)).toEqual({
      rest: "smoke in the lobby",
      nameGroups: [],
      witnessIds: [],
    });
  });

  it("finds a witness by the surname or by the first and last words of an alias", () => {
    const people = [
      { id: "IWS1", names: ["IWS1", "Hime Haymanot Gashaw"] },
      { id: "IWS2", names: ["IWS2", "Walid Wahbi"] },
      { id: "IWS3", names: ["IWS3", "Hamid Wahbi"] },
      { id: "IWS4", names: ["IWS4", "Gashaw"] },
    ];
    expect(namedWitnesses("Why did Hime Gashaw leave?", people)).toEqual({
      rest: "why did leave",
      nameGroups: [["IWS1", "Hime Haymanot Gashaw"]],
      witnessIds: ["IWS1"],
    });
    expect(namedWitnesses("What did Firefighter Wahbi see?", people)).toEqual({
      rest: "what did firefighter see",
      nameGroups: [
        ["IWS2", "Walid Wahbi"],
        ["IWS3", "Hamid Wahbi"],
      ],
      witnessIds: ["IWS2", "IWS3"],
    });
    expect(namedWitnesses("Did Hamid Wahbi see Gashaw?", people)).toEqual({
      rest: "did see",
      nameGroups: [
        ["IWS3", "Hamid Wahbi"],
        ["IWS4", "Gashaw"],
      ],
      witnessIds: ["IWS3", "IWS4"],
    });
  });

  it("names the witnesses whose role names the flat that the query names", () => {
    const people = [
      { id: "IWS1", names: ["IWS1", "Richard Fletcher"], role: "resident, floor 16, flat 131" },
      { id: "IWS2", names: ["IWS2", "Hime Haymanot Gashaw"], role: "resident, Flat 131" },
      { id: "IWS3", names: ["IWS3"], role: null },
      { id: "IWS4", names: ["IWS4", "Ann Other"], role: "resident, floor 16, flat 1311" },
    ];
    expect(namedWitnesses("What happened at FLAT 131?", people)).toEqual({
      rest: "what happened at flat 131",
      nameGroups: [["IWS1", "Richard Fletcher", "IWS2", "Hime Haymanot Gashaw"]],
      witnessIds: ["IWS1", "IWS2"],
    });
    expect(namedWitnesses("Did Richard Fletcher leave flat 131?", people)).toEqual({
      rest: "did leave flat 131",
      nameGroups: [
        ["IWS1", "Richard Fletcher"],
        ["IWS1", "Richard Fletcher", "IWS2", "Hime Haymanot Gashaw"],
      ],
      witnessIds: ["IWS1", "IWS2"],
    });
    expect(namedWitnesses("flat 999 and flatmates 131", people).witnessIds).toEqual([]);
  });

  it("reads the flats of a resident's role and none of another role that names a flat", () => {
    expect(residentFlats("resident, floor 16, flat 133, floor 16")).toEqual(["133"]);
    expect(residentFlats("Resident of Flat 136")).toEqual(["136"]);
    expect(residentFlats("London Fire Brigade, firefighter; Flat 133")).toEqual([]);
    expect(
      residentFlats(
        "London Fire Brigade, control room officer; took Sener Macit's call from Flat 133, floor 16",
      ),
    ).toEqual([]);
    expect(residentFlats("relative of the Flat 175 household, floor 20, floor 20")).toEqual([]);
    expect(residentFlats(null)).toEqual([]);
  });

  it("names the residents of a flat and not a firefighter whose role names it", () => {
    const people = [
      {
        id: "IWS1",
        names: ["IWS1", "Sener Macit"],
        role: "resident, floor 16, flat 133, floor 16",
      },
      {
        id: "MET1",
        names: ["MET1", "Dean Nelson"],
        role: "London Fire Brigade, firefighter; Flat 133",
      },
      {
        id: "MET2",
        names: ["MET2", "Aldo Diana"],
        role: "London Fire Brigade, crew manager; Flat 133",
      },
    ];
    expect(namedWitnesses("Why did Crew Manager Diana's crew not reach Flat 133?", people)).toEqual(
      {
        rest: "why did crew manager s crew not reach flat 133",
        nameGroups: [
          ["MET2", "Aldo Diana"],
          ["IWS1", "Sener Macit"],
        ],
        witnessIds: ["MET2", "IWS1"],
      },
    );
  });

  it("reads straight and curly quoted phrases", () => {
    expect(quotedPhrases('the "fire door" and \u201cstay put\u201d policy, ""')).toEqual([
      "fire door",
      "stay put",
    ]);
    expect(quotedPhrases("no quotes")).toEqual([]);
  });

  it("expands a named witness in the lexical query and adds a phrase ranking", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        if (/FROM witnesses/.test(text)) {
          return { rows: [{ id: "IWS9", aliases: ["Ada Lovelace"] }] };
        }
        return { rows: [] };
      },
    };
    const provider = {
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async (texts) => texts.map(() => new Array(1024).fill(0.5)),
    };
    const { rankings } = await retrieve({
      queries: ['Did Ada Lovelace see the "fire door"?'],
      corpus: "grenfell",
      provider,
      db,
    });
    expect(Object.keys(rankings[0])).toEqual([
      "lexicalPassage",
      "lexicalSection",
      "namedLexicalPassage",
      "namedLexicalSection",
      "phrasePassage",
      "phraseSection",
      "vectorPassage",
      "vectorSection",
      "namedPassage",
      "namedSection",
    ]);
    const corpusWide = calls.filter(
      (c) => /websearch_to_tsquery/.test(c.text) && !/plainto_tsquery/.test(c.text),
    );
    expect(corpusWide).toHaveLength(2);
    expect(corpusWide[0].text).toContain("(SELECT websearch_to_tsquery('english', $2) AS q)");
    expect(corpusWide[0].params.slice(0, 2)).toEqual([
      "grenfell",
      "did or ada or lovelace or see or the or fire or door",
    ]);
    const lexical = calls.filter((c) => /plainto_tsquery/.test(c.text));
    expect(lexical).toHaveLength(2);
    expect(lexical[0].text).toContain(
      "websearch_to_tsquery('english', $2) && (plainto_tsquery('english', $3) || plainto_tsquery('english', $4))",
    );
    expect(lexical[0].params.slice(0, 4)).toEqual([
      "grenfell",
      "did or see or the or fire or door",
      "IWS9",
      "Ada Lovelace",
    ]);
    const phrase = calls.filter((c) => /phraseto_tsquery/.test(c.text));
    expect(phrase).toHaveLength(2);
    expect(phrase[0].text).toContain("(SELECT phraseto_tsquery('english', $2) AS q)");
    expect(phrase[0].params.slice(0, 2)).toEqual(["grenfell", "fire door"]);
  });
});

describe("named witness scope", () => {
  const witnessRows = [
    { id: "IWS9", aliases: ["Ada Lovelace"] },
    { id: "IWS10", aliases: ["Bob Example"] },
  ];
  const run = async (queries, filters = null) => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        if (/FROM witnesses/.test(text)) return { rows: witnessRows };
        return { rows: [] };
      },
    };
    const provider = {
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async (texts) => texts.map(() => new Array(1024).fill(0.5)),
    };
    const result = await retrieve({ queries, corpus: "grenfell", provider, db, filters });
    const vector = calls.filter((c) => /embedding <=>/.test(c.text));
    const lexical = calls.filter((c) => /websearch_to_tsquery/.test(c.text));
    return { result, vector, lexical };
  };

  it("adds vector rankings over the documents of a witness that any query names beside the corpus-wide ones", async () => {
    const { result, vector, lexical } = await run([
      "What did Ada Lovelace see?",
      "smoke in the lobby",
    ]);
    expect(vector).toHaveLength(8);
    const scoped = vector.filter(({ text }) => text.includes("d.witness_id"));
    const corpusWide = vector.filter(({ text }) => !text.includes("d.witness_id"));
    expect(scoped).toHaveLength(4);
    expect(corpusWide).toHaveLength(4);
    for (const { text, params } of scoped) {
      expect(text).toMatch(/d\.witness_id = ANY\(\$\d+::text\[\]\)/);
      expect(text).toMatch(/ORDER BY \(embedding <=> \$\d+::halfvec\) \+ 0/);
      expect(params).toContainEqual(["IWS9"]);
    }
    for (const { text } of corpusWide) {
      expect(text).toMatch(/ORDER BY embedding <=> \$\d+::halfvec\n/);
    }
    for (const { text } of lexical) expect(text).not.toContain("d.witness_id");
    expect(Object.keys(result.rankings[0])).toEqual([
      "lexicalPassage",
      "lexicalSection",
      "namedLexicalPassage",
      "namedLexicalSection",
      "vectorPassage",
      "vectorSection",
      "namedPassage",
      "namedSection",
    ]);
    expect(Object.keys(result.rankings[1])).toEqual([
      "lexicalPassage",
      "lexicalSection",
      "vectorPassage",
      "vectorSection",
      "namedPassage",
      "namedSection",
    ]);
  });

  it("leaves the rankings of a query that names no witness as they are", async () => {
    const { result, vector, lexical } = await run(["smoke in the lobby"]);
    expect(Object.keys(result.rankings[0])).toEqual([
      "lexicalPassage",
      "lexicalSection",
      "vectorPassage",
      "vectorSection",
    ]);
    expect(vector).toHaveLength(2);
    for (const { text } of [...vector, ...lexical]) {
      expect(text).not.toContain("document_id IN");
      expect(text).toMatch(/ORDER BY (embedding <=> \$\d+::halfvec|ts_rank)/);
    }
  });

  it("keeps only the named witnesses that the page's witness filter keeps", async () => {
    const both = await run(["Did Ada Lovelace meet Bob Example?"], {
      witnesses: ["IWS10", "IWS1"],
    });
    expect(both.vector).toHaveLength(4);
    const holding = (ids) =>
      both.vector.filter(({ params }) => JSON.stringify(params).includes(ids));
    expect(holding('["IWS10"]')).toHaveLength(2);
    expect(holding('["IWS10","IWS1"]')).toHaveLength(2);
    const none = await run(["What did Ada Lovelace see?"], { witnesses: ["IWS1"] });
    expect(none.vector).toHaveLength(2);
    for (const { params } of none.vector) expect(params).toContainEqual(["IWS1"]);
    expect(none.result.rankings[0].namedPassage).toEqual([]);
    expect(none.result.rankings[0].namedSection).toEqual([]);
  });

  it("names the residents of a flat by their role and never a cipher-only witness", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        if (/FROM witnesses/.test(text)) {
          return {
            rows: [
              {
                id: "IWS9",
                aliases: ["Ada Lovelace"],
                role: "resident, flat 131",
                cipher_only: false,
              },
              { id: "C1", aliases: [], role: "resident, flat 131", cipher_only: true },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const provider = {
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async (texts) => texts.map(() => new Array(1024).fill(0.5)),
    };
    await retrieve({ queries: ["Who lived in Flat 131?"], corpus: "grenfell", provider, db });
    expect(calls[0].text).toContain("w.role, w.cipher_only");
    const scoped = calls.filter(
      (c) => /embedding <=>/.test(c.text) && c.text.includes("d.witness_id"),
    );
    expect(scoped).toHaveLength(2);
    for (const { params } of scoped) expect(params).toContainEqual(["IWS9"]);
    const lexical = calls.filter((c) => /plainto_tsquery/.test(c.text));
    expect(lexical).toHaveLength(2);
    for (const { params } of lexical) {
      expect(params).toContain("IWS9");
      expect(params).not.toContain("C1");
    }
  });

  it("fuses a lexical match that never names the named witness", async () => {
    const db = {
      query: async (text) => {
        if (/FROM witnesses/.test(text)) return { rows: witnessRows };
        if (/websearch_to_tsquery/.test(text) && !/plainto_tsquery/.test(text)) {
          return { rows: [{ id: 7 }] };
        }
        return { rows: [] };
      },
    };
    const provider = {
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async (texts) => texts.map(() => new Array(1024).fill(0.5)),
    };
    const { fused, rankings } = await retrieve({
      queries: ["What did Ada Lovelace see?"],
      corpus: "grenfell",
      provider,
      db,
    });
    expect(rankings[0].lexicalPassage).toEqual(["7"]);
    expect(rankings[0].namedLexicalPassage).toEqual([]);
    expect(fused.map(({ id }) => id)).toEqual(["7"]);
  });

  it("keeps the other filters and the scope when it names witnesses", () => {
    const scope = { corpus: "grenfell", documentIds: ["d1"], filters: { role: "Fire" } };
    expect(namedWitnessScope(scope, [])).toBe(scope);
    expect(namedWitnessScope(scope, ["IWS9"])).toEqual({
      corpus: "grenfell",
      documentIds: ["d1"],
      filters: { role: "Fire", witnesses: ["IWS9"] },
    });
    expect(namedWitnessScope({ corpus: "grenfell" }, ["IWS9"])).toEqual({
      corpus: "grenfell",
      filters: { witnesses: ["IWS9"] },
    });
  });
});

describe("retrieval filters", () => {
  it("holds every ranking to the documents that pass the filters, with an exact vector scan", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    const provider = {
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async (texts) => texts.map(() => new Array(1024).fill(0.5)),
    };
    const filters = { witnesses: ["IWS1"], role: "Fire", from: "2017-06-14", to: "2018-01-01" };
    await retrieve({ queries: ["q"], corpus: "grenfell", provider, db, filters });
    const ranked = calls.filter((c) => /SELECT id FROM chunks/.test(c.text));
    expect(ranked).toHaveLength(4);
    for (const { text, params } of ranked) {
      expect(text).toContain(
        "document_id IN (SELECT d.id FROM documents d LEFT JOIN witnesses w ON w.id = d.witness_id",
      );
      expect(text).toMatch(/d\.witness_id = ANY\(\$\d+::text\[\]\)/);
      expect(text).toContain("NOT coalesce(w.cipher_only, false)");
      expect(text).toMatch(
        /strpos\(lower\(coalesce\(d\.role, w\.role, ''\)\), lower\(\$\d+\)\) > 0/,
      );
      expect(text).toMatch(/d\.statement_date >= \$\d+::date AND d\.statement_date <= \$\d+::date/);
      expect(params).toEqual(
        expect.arrayContaining([["IWS1"], "Fire", "2017-06-14", "2018-01-01"]),
      );
    }
    for (const { text } of ranked.filter((c) => /embedding <=>/.test(c.text))) {
      expect(text).toMatch(/ORDER BY \(embedding <=> \$\d+::halfvec\) \+ 0/);
    }
  });

  it("passes the turn's filters from runQuery to retrieval", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    const provider = createFakeProvider({ tokens: [], delayMs: 0, embedDim: 1024 });
    await runQuery({
      question: "q",
      corpus: "grenfell",
      db,
      provider,
      filters: { role: "Resident" },
    });
    const ranked = calls.filter((c) => /SELECT id FROM chunks/.test(c.text));
    expect(ranked).toHaveLength(4);
    for (const { params } of ranked) expect(params).toContain("Resident");
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
      retrieve({
        queries: ["q"],
        corpus: "grenfell",
        provider: { name: "p", embedModel: "m", embedDim: 4 },
        db,
      }),
    ).rejects.toThrow(/4 dimensions/);
  });

  it("needs a corpus", async () => {
    const db = { query: async () => ({ rows: [] }) };
    const provider = { name: "p", embedModel: "m", embedDim: 1024 };
    await expect(retrieve({ queries: ["q"], provider, db })).rejects.toThrow(/needs a corpus/);
    await expect(runQuery({ question: "q", provider, db })).rejects.toThrow(/needs a corpus/);
  });

  it("reads every ranking from the one corpus, with and without named documents", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    const provider = {
      name: "p",
      embedModel: "m",
      embedDim: 1024,
      embed: async () => [new Array(1024).fill(0.5)],
    };
    await retrieve({ queries: ["q"], corpus: "ucpi", provider, db });
    await retrieve({ queries: ["q"], corpus: "ucpi", provider, db, documentIds: ["UCPI1"] });
    expect(calls.filter((c) => /FROM witnesses/.test(c.text))).toHaveLength(2);
    expect(calls).toHaveLength(10);
    for (const { text, params } of calls) {
      const at = Number(/corpus = \$(\d)/.exec(text)[1]);
      expect(params[at - 1]).toBe("ucpi");
    }
    const unscoped = calls.filter((c) => /embedding <=>/.test(c.text) && c.params.length === 5);
    expect(unscoped).toHaveLength(2);
    for (const { text } of unscoped) {
      expect(text).toMatch(/ORDER BY embedding <=> \$2::halfvec\n/);
    }
  });

  it("needs a database", async () => {
    await expect(runQuery({ question: "q", provider: {} })).rejects.toThrow(/needs a database/);
  });
});
