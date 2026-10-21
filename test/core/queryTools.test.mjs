// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../../packages/core/prompt.mjs";
import { citeRows, evidenceRegistry, runQuery } from "../../packages/core/query.mjs";
import { DOCUMENT_FACTS_SQL } from "../../packages/core/tools/documentFacts.mjs";

const chunkRow = (id, page, paragraph, text) => ({
  id,
  document_id: "doc1",
  level: "passage",
  text,
  header: `[h ${id}]`,
  locator: { page, paragraph },
  prev_id: null,
  next_id: null,
  parent_id: null,
});
const CHUNKS = [
  chunkRow("1", 3, 11, "The stairs were dark."),
  chunkRow("2", 1, 2, "Witness statement dated 1 June 2018."),
];

/** A store with one retrieved passage and document_facts naming firstChunk. */
function storeWith({ firstChunk = "2", failFacts = false } = {}) {
  return {
    async query(text, params) {
      if (text === DOCUMENT_FACTS_SQL) {
        if (failFacts) throw new Error("relation documents does not exist");
        return { rows: [{ id: "doc1", first_chunk: firstChunk }] };
      }
      if (/FROM documents d LEFT JOIN witnesses w/.test(text)) {
        return {
          rows: [
            {
              id: "doc1",
              title: "T",
              witness_id: "W1",
              statement_date: "2018-06-01",
              format: "pdf",
              page_count: 9,
            },
          ],
        };
      }
      if (/SELECT id FROM chunks/.test(text)) return { rows: [{ id: "1" }] };
      if (/FROM chunks WHERE id = ANY/.test(text)) {
        return { rows: CHUNKS.filter((c) => params[0].includes(c.id)) };
      }
      if (/SELECT w.id, w.aliases, w.role, w.cipher_only FROM witnesses w/.test(text))
        return { rows: [] };
      throw new Error(`unexpected statement: ${text}`);
    },
  };
}

const providerWith = (tokens) =>
  createFakeProvider({
    tokens,
    delayMs: 0,
    embedDim: 1024,
    toolRounds: [[{ name: "document_facts", input: {} }]],
  });

async function ask(db, provider) {
  const stages = [];
  const evidence = [];
  const result = await runQuery({
    question: "When is the statement dated, and were the stairs dark?",
    corpus: "grenfell",
    provider,
    db,
    onStage: (...args) => stages.push(args.length > 1 ? args : args[0]),
    onEvidence: (blocks) => evidence.push(blocks.map((b) => b.evidence)),
  });
  return { result, stages, evidence };
}

describe("a turn with tools", () => {
  it("numbers tool evidence after the retrieved blocks and resolves its citations", async () => {
    const provider = providerWith(["Dark [E1].", " Dated 1 June 2018 [E2]."]);
    const { result, stages, evidence } = await ask(storeWith(), provider);
    expect(stages).toEqual([
      "rewriting",
      "retrieving",
      "answering",
      ["tool", { name: "document_facts", rows: 1 }],
      "checking",
    ]);
    expect(evidence).toEqual([[1], [1, 2]]);
    expect(result.evidenceBlocks[1]).toMatchObject({
      evidence: 2,
      chunkId: "2",
      document: { title: "T", witnessId: "W1" },
    });
    expect(result.citations).toEqual([
      { evidence: 1, locator: { document: "doc1", page: 3, paragraph: 11 } },
      { evidence: 2, locator: { document: "doc1", page: 1, paragraph: 2 } },
    ]);
    expect(result.checks).toMatchObject({
      sentences: 2,
      supported: 2,
      promptVersion: PROMPT_VERSION,
      tools: [{ name: "document_facts", input: {}, rows: 1 }],
    });
    expect(result.abstained).toBe(false);
  });

  it("offers every store tool and gives the model rows by evidence number with no locator", async () => {
    const provider = providerWith(["Dated [E2]."]);
    await ask(storeWith(), provider);
    const [call] = provider.calls;
    expect(call.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(call.tools).toHaveLength(8);
    const [content] = call.toolResults;
    const [json, blocks] = content.split("\n\n");
    expect(JSON.parse(json)).toEqual({
      rows: [
        {
          documentId: "doc1",
          title: "T",
          witnessId: "W1",
          cipherOnly: false,
          role: null,
          statementDate: "2018-06-01",
          type: "pdf",
          pages: 9,
          evidence: "E2",
        },
      ],
      truncated: false,
    });
    expect(blocks).toBe("[E2] [h 2]\nWitness statement dated 1 June 2018.");
    expect(content).not.toMatch(/chunkId|locator|paragraph/);
  });

  it("keeps the number of a chunk that retrieval already holds", async () => {
    const provider = providerWith(["Dark [E1]."]);
    const { result, evidence } = await ask(storeWith({ firstChunk: "1" }), provider);
    expect(evidence).toEqual([[1]]);
    expect(result.evidenceBlocks).toHaveLength(1);
    expect(provider.calls[0].toolResults[0]).toContain('"evidence":"E1"');
  });

  it("fails the turn when a tool throws", async () => {
    const provider = providerWith(["x"]);
    await expect(ask(storeWith({ failFacts: true }), provider)).rejects.toThrow(
      "relation documents does not exist",
    );
  });
});

describe("the evidence registry", () => {
  it("adds each new chunk once under the next number", () => {
    const registry = evidenceRegistry([{ evidence: 1, chunkId: "a" }]);
    const first = registry.add([{ chunkId: "b" }, { chunkId: "a" }, { chunkId: "b" }]);
    expect(registry.blocks.map((b) => [b.evidence, b.chunkId])).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(first.named.map((b) => b.evidence)).toEqual([1, 2]);
    registry.add([{ chunkId: "c" }]);
    expect(registry.blocks.at(-1)).toEqual({ chunkId: "c", evidence: 3 });
  });

  it("turns nested chunk ids into evidence numbers and refuses a chunk with no block", () => {
    const numbers = new Map([
      ["a", 4],
      ["b", 5],
    ]);
    expect(
      citeRows(
        [{ label: "contradict", a: { chunkId: "a", locator: { page: 1 } }, b: { chunkId: "b" } }],
        numbers,
      ),
    ).toEqual([{ label: "contradict", a: { evidence: "E4" }, b: { evidence: "E5" } }]);
    expect(() => citeRows([{ chunkId: "z" }], numbers)).toThrow(/chunk z/);
  });
});
