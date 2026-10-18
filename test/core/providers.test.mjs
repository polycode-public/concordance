// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createOllamaProvider } from "../../packages/core/providers/ollamaProvider.mjs";
import { providerFromEnv } from "../../packages/core/providers/index.mjs";
import { assertProvider } from "../../packages/core/providers/modelProvider.mjs";

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

  it("fails clearly for bedrock", () => {
    expect(() => providerFromEnv({ MODEL_PROVIDER: "bedrock" })).toThrow(
      "bedrock provider is not built yet; set MODEL_PROVIDER=laptop",
    );
  });

  it("rejects an unknown provider", () => {
    expect(() => providerFromEnv({ MODEL_PROVIDER: "other" })).toThrow(/unknown MODEL_PROVIDER/);
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
    });
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

  it("reports a non-OK response with its status", async () => {
    const p = createOllamaProvider({
      fetchImpl: async () => new Response("model not found", { status: 404 }),
    });
    await expect(p.embed(["a"])).rejects.toThrow(/404/);
  });
});
