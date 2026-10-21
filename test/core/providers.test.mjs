// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createOllamaProvider } from "../../packages/core/providers/ollamaProvider.mjs";
import { providerFromEnv } from "../../packages/core/providers/index.mjs";
import { assertProvider } from "../../packages/core/providers/modelProvider.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import {
  RERANK_SCHEMA,
  batchScores,
  modelReranker,
} from "../../packages/core/providers/rerank.mjs";
import { RERANK_PASSAGE_CHARS } from "../../packages/core/prompt.mjs";

function ndjsonResponse(lines, { delayMs = 0 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const line of lines) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("providerFromEnv", () => {
  it("selects the laptop provider by default", () => {
    const p = providerFromEnv({});
    expect(p.name).toBe("laptop");
    expect(p.embedModel).toBe("bge-m3");
    expect(p.embedDim).toBe(1024);
  });

  it("reads model names from the environment", () => {
    const p = providerFromEnv({ EMBED_MODEL: "nomic-embed-text", EMBED_DIM: "768" });
    expect(p.embedModel).toBe("nomic-embed-text");
    expect(p.embedDim).toBe(768);
  });

  it("rejects an unknown provider", () => {
    expect(() => providerFromEnv({ MODEL_PROVIDER: "other" })).toThrow(/unknown MODEL_PROVIDER/);
  });

  it("adds the model reranker only with RERANK=model", () => {
    expect(providerFromEnv({}).rerank).toBeUndefined();
    expect(providerFromEnv({ RERANK: "off" }).rerank).toBeUndefined();
    expect(providerFromEnv({ RERANK: "model" }).rerank).toBeTypeOf("function");
    expect(providerFromEnv({ MODEL_PROVIDER: "bedrock", RERANK: "model" }).rerank).toBeTypeOf(
      "function",
    );
    expect(() => providerFromEnv({ RERANK: "cohere" })).toThrow(/unknown RERANK cohere/);
  });
});

describe("modelReranker", () => {
  const passages = Array.from({ length: 25 }, (_, i) => ({
    id: String(100 + i),
    header: `[h ${i}]`,
    text: `passage ${i} ${"x".repeat(2000)}`,
  }));

  it("scores ten passages to one extraction call and keeps passage order", async () => {
    const prompts = [];
    const reranker = modelReranker({
      async extractJson({ prompt, schema }) {
        prompts.push({ prompt, schema });
        const count = (prompt.match(/^\[P\d+\]/gm) ?? []).length;
        return {
          scores: Array.from({ length: count }, (_, i) => ({ passage: count - i, score: i % 4 })),
        };
      },
    });
    const scored = await reranker("Were the stairs dark?", passages);
    expect(prompts).toHaveLength(3);
    expect(prompts.map((p) => (p.prompt.match(/^\[P\d+\]/gm) ?? []).length)).toEqual([10, 10, 5]);
    expect(prompts[0].schema).toBe(RERANK_SCHEMA);
    expect(prompts[0].prompt).toContain("Question: Were the stairs dark?");
    expect(prompts[0].prompt).toContain("[P1] [h 0]\npassage 0 ");
    expect(prompts[0].prompt).not.toContain("x".repeat(RERANK_PASSAGE_CHARS));
    expect(scored).toHaveLength(25);
    expect(scored.map((s) => s.id)).toEqual(passages.map((p) => p.id));
    expect(scored[9]).toEqual({ id: "109", score: 0 });
    expect(scored[0]).toEqual({ id: "100", score: 1 });
  });

  it("throws when a passage has no score, two scores or one out of range", () => {
    expect(() => batchScores({ scores: [{ passage: 1, score: 2 }] }, 2)).toThrow(/passage 2/);
    expect(() =>
      batchScores(
        {
          scores: [
            { passage: 1, score: 2 },
            { passage: 1, score: 3 },
          ],
        },
        2,
      ),
    ).toThrow(/named passage 1/);
    expect(() => batchScores({ scores: [{ passage: 1, score: 4 }] }, 1)).toThrow(/score 4/);
    expect(() => batchScores({}, 1)).toThrow(/no score/);
    expect(
      batchScores(
        {
          scores: [
            { passage: 2, score: 0 },
            { passage: 1, score: 3 },
          ],
        },
        2,
      ),
    ).toEqual([3, 0]);
  });
});

describe("assertProvider", () => {
  it("rejects an object without the provider methods", () => {
    expect(() => assertProvider({ name: "x", embed() {} })).toThrow(/chat/);
  });
});

describe("ollama provider", () => {
  it("embeds through /api/embed", async () => {
    const requests = [];
    const p = createOllamaProvider({
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return Response.json({
          embeddings: [
            [1, 2],
            [3, 4],
          ],
        });
      },
    });
    expect(await p.embed(["a", "b"])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(requests[0].url).toBe("http://localhost:11434/api/embed");
    expect(requests[0].body).toEqual({ model: "bge-m3", input: ["a", "b"] });
  });

  it("streams chat tokens from NDJSON and returns the full text", async () => {
    let sent;
    const p = createOllamaProvider({
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return ndjsonResponse([
          { model: "qwen2.5:7b-instruct", message: { content: "Hello " }, done: false },
          { model: "qwen2.5:7b-instruct", message: { content: "there." }, done: false },
          { model: "qwen2.5:7b-instruct", message: { content: "" }, done: true },
        ]);
      },
    });
    const tokens = [];
    const result = await p.chat({
      messages: [{ role: "user", content: "hi" }],
      onToken: (t) => tokens.push(t),
      promptVersion: "v1",
    });
    expect(sent).toMatchObject({ stream: true, options: { temperature: 0 } });
    expect(tokens).toEqual(["Hello ", "there."]);
    expect(result).toEqual({
      text: "Hello there.",
      model: "qwen2.5:7b-instruct",
      promptVersion: "v1",
      usage: null,
    });
  });

  it("returns the token counts of the final message", async () => {
    const p = createOllamaProvider({
      fetchImpl: async () =>
        ndjsonResponse([
          { message: { content: "Hi" }, done: false },
          { message: { content: "" }, done: true, prompt_eval_count: 1204, eval_count: 310 },
        ]),
    });
    const result = await p.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.usage).toEqual({ inputTokens: 1204, outputTokens: 310 });
  });

  it("stops the chat stream when the signal aborts", async () => {
    const p = createOllamaProvider({
      fetchImpl: async () =>
        ndjsonResponse(
          Array.from({ length: 20 }, (_, i) => ({ message: { content: `t${i} ` }, done: false })),
          { delayMs: 10 },
        ),
    });
    const controller = new AbortController();
    const tokens = [];
    const pending = p.chat({
      messages: [],
      signal: controller.signal,
      onToken: (t) => {
        tokens.push(t);
        if (tokens.length === 2) controller.abort();
      },
    });
    await expect(pending).rejects.toThrow();
    expect(tokens.length).toBe(2);
  });

  it("requests JSON format for extraction and parses the result", async () => {
    let sent;
    const p = createOllamaProvider({
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return Response.json({ message: { content: '{"predicate":"saw"}' } });
      },
    });
    expect(await p.extractJson({ prompt: "extract" })).toEqual({ predicate: "saw" });
    expect(sent).toMatchObject({ format: "json", stream: false });
  });

  it("throws ReplyTruncatedError when Ollama stopped at its length limit", async () => {
    const p = createOllamaProvider({
      fetchImpl: async () =>
        Response.json({ message: { content: '{"assertions":[' }, done_reason: "length" }),
    });
    await expect(p.extractJson({ prompt: "extract" })).rejects.toMatchObject({
      name: "ReplyTruncatedError",
      replyLength: 15,
    });
  });

  it("reports a non-OK response with its status", async () => {
    const p = createOllamaProvider({
      fetchImpl: async () => new Response("model not found", { status: 404 }),
    });
    await expect(p.embed(["a"])).rejects.toThrow(/404/);
  });
});

describe("fake provider", () => {
  it("embeds unit vectors of embedDim and defaults to 4", async () => {
    expect(await createFakeProvider({ tokens: [] }).embed(["a"])).toEqual([[0, 0, 0, 1]]);
    const p = createFakeProvider({ tokens: [], embedDim: 1024 });
    const [vector] = await p.embed(["a"]);
    expect(p.embedDim).toBe(1024);
    expect(vector).toHaveLength(1024);
    expect(vector.at(-1)).toBe(1);
    expect(vector.slice(0, -1).every((x) => x === 0)).toBe(true);
  });

  it("uses embedFor and extractJson when given", async () => {
    const p = createFakeProvider({
      tokens: [],
      embedFor: (text) => [text.length],
      extractJson: ({ prompt }) => ({ echo: prompt }),
    });
    expect(await p.embed(["ab", "abc"])).toEqual([[2], [3]]);
    expect(await p.extractJson({ prompt: "x" })).toEqual({ echo: "x" });
    expect(await createFakeProvider({ tokens: [] }).extractJson({ prompt: "x" })).toEqual({});
  });
});
