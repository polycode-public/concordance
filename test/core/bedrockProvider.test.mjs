// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_RETRY_BUDGET_MS,
  createBedrockProvider,
} from "../../packages/core/providers/bedrockProvider.mjs";
import { providerFromEnv } from "../../packages/core/providers/index.mjs";
import {
  ReplyTruncatedError,
  assertProvider,
} from "../../packages/core/providers/modelProvider.mjs";

class BedrockRuntimeClient {}
class Recorded {
  constructor(input) {
    this.input = input;
  }
}
class InvokeModelCommand extends Recorded {}
class ConverseStreamCommand extends Recorded {}
class ConverseCommand extends Recorded {}
const sdk = { BedrockRuntimeClient, InvokeModelCommand, ConverseStreamCommand, ConverseCommand };

function fakeClient(responders) {
  const calls = [];
  return {
    calls,
    async send(command, options) {
      calls.push({ name: command.constructor.name, input: command.input, options });
      return responders[command.constructor.name](command);
    },
  };
}

const titan = (dim) => (command) => {
  const { inputText } = JSON.parse(command.input.body);
  const vector = Array.from({ length: dim }, () => 0);
  vector[0] = inputText.length;
  return { body: new TextEncoder().encode(JSON.stringify({ embedding: vector })) };
};

async function* deltas(pieces) {
  yield { messageStart: { role: "assistant" } };
  for (const text of pieces) yield { contentBlockDelta: { delta: { text } } };
  yield { messageStop: { stopReason: "end_turn" } };
}

const converseReply = (text) => () => ({ output: { message: { content: [{ text }] } } });

describe("bedrock provider", () => {
  it("sends one Titan request per text and returns vectors in input order", async () => {
    const client = fakeClient({ InvokeModelCommand: titan(1024) });
    const p = createBedrockProvider({}, { sdk, client });
    const texts = ["a", "bb", "ccc"];
    const vectors = await p.embed(texts);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(p.name).toBe("bedrock");
    expect(p.embedModel).toBe("amazon.titan-embed-text-v2:0");
    expect(p.embedDim).toBe(1024);
    const { input } = client.calls[0];
    expect(input.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(JSON.parse(input.body)).toEqual({ inputText: "a", dimensions: 1024, normalize: true });
  });

  it("throws when a vector has the wrong dimension", async () => {
    const client = fakeClient({ InvokeModelCommand: titan(512) });
    const p = createBedrockProvider({}, { sdk, client });
    await expect(p.embed(["a"])).rejects.toThrow(/512 dimensions, expected 1024/);
  });

  it("streams deltas to onToken in order and concatenates the text", async () => {
    const client = fakeClient({
      ConverseStreamCommand: () => ({ stream: deltas(["Hello ", "there."]) }),
    });
    const p = createBedrockProvider({}, { sdk, client });
    const tokens = [];
    const result = await p.chat({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "yes?" },
        { role: "user", content: "go" },
      ],
      onToken: (t) => tokens.push(t),
      promptVersion: "v1",
    });
    expect(tokens).toEqual(["Hello ", "there."]);
    expect(result).toEqual({
      text: "Hello there.",
      model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      promptVersion: "v1",
      usage: null,
    });
    const { input, options } = client.calls[0];
    expect(input.system).toEqual([{ text: "Be brief." }]);
    expect(input.messages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
      { role: "assistant", content: [{ text: "yes?" }] },
      { role: "user", content: [{ text: "go" }] },
    ]);
    expect(input.inferenceConfig).toEqual({ temperature: 0 });
    expect(options.abortSignal).toBeUndefined();
  });

  it("returns the token counts of the stream metadata event", async () => {
    async function* withMetadata() {
      yield { contentBlockDelta: { delta: { text: "Hi" } } };
      yield { metadata: { usage: { inputTokens: 1204, outputTokens: 310, totalTokens: 1514 } } };
    }
    const client = fakeClient({ ConverseStreamCommand: () => ({ stream: withMetadata() }) });
    const p = createBedrockProvider({}, { sdk, client });
    const result = await p.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.usage).toEqual({
      inputTokens: 1204,
      outputTokens: 310,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  describe("prompt caching", () => {
    const longSystem = "Answer from the evidence. ".repeat(200);
    const tool = {
      name: "count",
      description: "Counts rows. ".repeat(500),
      inputSchema: { type: "object", properties: {} },
      run: async () => ({ content: "0", rows: 0 }),
    };
    const turn = (client, extra = {}, env = {}) =>
      createBedrockProvider(env, { sdk, client }).chat({
        messages: [
          { role: "system", content: longSystem },
          { role: "user", content: "[E1] evidence\n\nQuestion: who?" },
        ],
        ...extra,
      });
    const streamClient = () =>
      fakeClient({ ConverseStreamCommand: () => ({ stream: deltas(["Hi"]) }) });

    it("puts one cache point after the system text and before the evidence", async () => {
      const client = streamClient();
      await turn(client, { tools: [tool] });
      const { system, messages } = client.calls[0].input;
      expect(system).toEqual([{ text: longSystem }, { cachePoint: { type: "default" } }]);
      expect(JSON.stringify(messages)).not.toContain("cachePoint");
    });

    it("counts the tool definitions toward the cache minimum", async () => {
      const short = "Answer from the evidence.";
      const client = streamClient();
      const p = createBedrockProvider({}, { sdk, client });
      const messages = [
        { role: "system", content: short },
        { role: "user", content: "q" },
      ];
      await p.chat({ messages });
      await p.chat({ messages, tools: [tool] });
      expect(client.calls[0].input.system).toEqual([{ text: short }]);
      expect(client.calls[1].input.system).toEqual([
        { text: short },
        { cachePoint: { type: "default" } },
      ]);
    });

    it("sets no cache point under the model's minimum", async () => {
      const client = streamClient();
      await turn(client, {}, { BEDROCK_CHAT_MODEL: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" });
      expect(client.calls[0].input.system).toEqual([{ text: longSystem }]);
    });

    it("sets no cache point for a model with no known minimum", async () => {
      const client = streamClient();
      await turn(client, {}, { BEDROCK_CHAT_MODEL: "eu.amazon.nova-pro-v1:0" });
      expect(client.calls[0].input.system).toEqual([{ text: longSystem }]);
    });

    it("reports the cache tokens inside inputTokens and beside it", async () => {
      async function* withCache() {
        yield { contentBlockDelta: { delta: { text: "Hi" } } };
        yield {
          metadata: {
            usage: {
              inputTokens: 50,
              outputTokens: 10,
              cacheReadInputTokens: 2000,
              cacheWriteInputTokens: 300,
            },
          },
        };
      }
      const client = fakeClient({ ConverseStreamCommand: () => ({ stream: withCache() }) });
      const result = await turn(client);
      expect(result.usage).toEqual({
        inputTokens: 2350,
        outputTokens: 10,
        cacheReadTokens: 2000,
        cacheWriteTokens: 300,
      });
    });
  });

  it("rejects with AbortError when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const client = fakeClient({
      ConverseStreamCommand: () => ({ stream: deltas(["a", "b", "c", "d"]) }),
    });
    const p = createBedrockProvider({}, { sdk, client });
    const tokens = [];
    const run = p.chat({
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
      onToken: (t) => {
        tokens.push(t);
        if (tokens.length === 2) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(tokens).toEqual(["a", "b"]);
  });

  it("rejects with AbortError when the signal is already aborted", async () => {
    const client = fakeClient({});
    const p = createBedrockProvider({}, { sdk, client });
    const run = p.chat({ messages: [], signal: AbortSignal.abort() });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(client.calls).toHaveLength(0);
  });

  it("parses a fenced JSON reply and sends the schema", async () => {
    const client = fakeClient({
      ConverseCommand: converseReply('```json\n{"predicate":"saw"}\n```'),
    });
    const p = createBedrockProvider({}, { sdk, client });
    const schema = { type: "object", properties: { predicate: { type: "string" } } };
    expect(await p.extractJson({ prompt: "extract", schema })).toEqual({ predicate: "saw" });
    const { input } = client.calls[0];
    expect(input.modelId).toBe(p.extractModel);
    expect(input.inferenceConfig).toEqual({ temperature: 0, maxTokens: 8192 });
    const text = input.messages[0].content[0].text;
    expect(text.startsWith("extract")).toBe(true);
    expect(text).toContain(JSON.stringify(schema));
  });

  it("throws ReplyTruncatedError when the model stopped at its output limit", async () => {
    const client = fakeClient({
      ConverseCommand: () => ({
        stopReason: "max_tokens",
        output: { message: { content: [{ text: '```json\n{"assertions":[{"sentence":1' }] } },
      }),
    });
    const p = createBedrockProvider({}, { sdk, client });
    const error = await p.extractJson({ prompt: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(ReplyTruncatedError);
    expect(error).toMatchObject({ model: p.extractModel, replyLength: 36 });
  });

  it("keeps the head and the tail of a long invalid reply in the error", async () => {
    const reply = `HEAD${"x".repeat(500)}TAIL`;
    const client = fakeClient({ ConverseCommand: converseReply(reply) });
    const p = createBedrockProvider({}, { sdk, client });
    const error = await p.extractJson({ prompt: "x" }).catch((e) => e);
    expect(error.message).toContain("HEAD");
    expect(error.message).toContain("TAIL");
    expect(error.message).not.toContain("x".repeat(300));
  });

  it("throws naming the model when the reply is not JSON", async () => {
    const client = fakeClient({ ConverseCommand: converseReply("I cannot say.") });
    const p = createBedrockProvider({}, { sdk, client });
    await expect(p.extractJson({ prompt: "x" })).rejects.toThrow(
      /claude-haiku.*invalid JSON: I cannot say\./,
    );
  });

  it("reads model ids and dimension from the environment", () => {
    const p = createBedrockProvider(
      { BEDROCK_EMBED_DIM: "512", BEDROCK_CHAT_MODEL: "c", BEDROCK_EXTRACT_MODEL: "e" },
      { sdk, client: fakeClient({}) },
    );
    expect(p.embedDim).toBe(512);
    expect(p.extractModel).toBe("e");
  });

  it("is selected by providerFromEnv without loading the SDK", () => {
    const p = createBedrockProvider({ MODEL_PROVIDER: "bedrock" }, { sdk });
    expect(assertProvider(p).name).toBe("bedrock");
    expect(providerFromEnv({ MODEL_PROVIDER: "bedrock" }).name).toBe("bedrock");
  });

  it("refuses an input over 45,000 characters before any call", async () => {
    const client = fakeClient({ InvokeModelCommand: titan(1024) });
    const p = createBedrockProvider({}, { sdk, client });
    await expect(p.embed(["ok", "x".repeat(46000)])).rejects.toThrow(/input 1 is 46000 characters/);
    expect(client.calls).toHaveLength(0);
  });

  function throttlingClient(failures, responders) {
    const inner = fakeClient(responders);
    let thrown = 0;
    return {
      calls: inner.calls,
      async send(command, options) {
        inner.calls.push({ name: command.constructor.name });
        if (thrown < failures) {
          thrown++;
          throw Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
        }
        return responders[command.constructor.name](command, options);
      },
    };
  }

  it("retries throttling with jittered backoff and returns the vector", async () => {
    const client = throttlingClient(2, { InvokeModelCommand: titan(1024) });
    const waits = [];
    const sleep = async (ms) => void waits.push(ms);
    const p = createBedrockProvider({}, { sdk, client, sleep });
    const [vector] = await p.embed(["abc"]);
    expect(vector[0]).toBe(3);
    expect(client.calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(500);
    expect(waits[0]).toBeLessThanOrEqual(1000);
    expect(waits[1]).toBeGreaterThanOrEqual(1000);
    expect(waits[1]).toBeLessThanOrEqual(2000);
  });

  it("keeps retrying an embedding until its waits add up to the budget, then names the attempts", async () => {
    const client = throttlingClient(99, { InvokeModelCommand: titan(1024) });
    const waits = [];
    const sleep = async (ms) => void waits.push(ms);
    const p = createBedrockProvider({}, { sdk, client, sleep });
    await expect(p.embed(["abc"])).rejects.toThrow(/throttled after \d+ attempts/);
    expect(waits.reduce((a, b) => a + b, 0)).toBeCloseTo(EMBED_RETRY_BUDGET_MS, 5);
    expect(client.calls).toHaveLength(waits.length + 1);
    // The ceilings 1, 2, 4, 8, 16 and 20 seconds add up to 51, so the seventh wait reaches the
    // budget at the latest; a lower draw of the jitter takes more waits, never fewer.
    expect(waits.length).toBeGreaterThanOrEqual(7);
    waits.forEach((ms) => expect(ms).toBeLessThanOrEqual(20000));
  });

  function clockedClient(responders) {
    vi.useFakeTimers();
    const state = { stamps: [] };
    const client = {
      async send(command) {
        state.stamps.push(Date.now());
        return responders[command.constructor.name](command);
      },
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    return { state, client, sleep, now: () => Date.now() };
  }
  afterEach(() => vi.useRealTimers());

  it("spaces concurrent extraction calls at least 1.5 seconds apart", async () => {
    const { state, client, sleep, now } = clockedClient({ ConverseCommand: converseReply("{}") });
    const p = createBedrockProvider({}, { sdk, client, sleep, now });
    const all = Promise.all(Array.from({ length: 10 }, () => p.extractJson({ prompt: "x" })));
    await vi.advanceTimersByTimeAsync(60000);
    await all;
    expect(state.stamps).toHaveLength(10);
    state.stamps
      .slice(1)
      .forEach((t, i) => expect(t - state.stamps[i]).toBeGreaterThanOrEqual(1500));
    const perMinute = state.stamps.filter((t) => t < 60000).length;
    expect(perMinute).toBeLessThanOrEqual(40);
    expect(state.stamps.at(-1) - state.stamps[0]).toBe(9 * 1500);
  });

  it("paces the retry of a throttled extraction call too", async () => {
    const { state, sleep, now } = clockedClient({});
    let thrown = 0;
    const client = {
      async send() {
        state.stamps.push(Date.now());
        if (thrown++ < 2)
          throw Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
        return converseReply("{}")();
      },
    };
    const p = createBedrockProvider({}, { sdk, client, sleep, now });
    const done = p.extractJson({ prompt: "x" });
    await vi.advanceTimersByTimeAsync(120000);
    await done;
    expect(state.stamps).toHaveLength(3);
    state.stamps
      .slice(1)
      .forEach((t, i) => expect(t - state.stamps[i]).toBeGreaterThanOrEqual(1500));
  });

  it("does not pace embeds", async () => {
    const { state, client, sleep, now } = clockedClient({ InvokeModelCommand: titan(1024) });
    const p = createBedrockProvider({}, { sdk, client, sleep, now });
    await p.embed(["a", "b", "c", "d", "e", "f"]);
    expect(new Set(state.stamps).size).toBe(1);
  });

  it("retries an HTTP 429 and does not retry other errors", async () => {
    let calls = 0;
    const client = {
      async send() {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error("slow"), { $metadata: { httpStatusCode: 429 } });
        throw new Error("denied");
      },
    };
    const p = createBedrockProvider({}, { sdk, client, sleep: async () => {} });
    await expect(p.extractJson({ prompt: "x" })).rejects.toThrow("denied");
    expect(calls).toBe(2);
  });

  it("retries chat before the stream starts and rethrows a throttle mid-stream", async () => {
    const before = throttlingClient(1, {
      ConverseStreamCommand: () => ({ stream: deltas(["Hi"]) }),
    });
    const p = createBedrockProvider({}, { sdk, client: before, sleep: async () => {} });
    expect((await p.chat({ messages: [{ role: "user", content: "x" }] })).text).toBe("Hi");
    expect(before.calls).toHaveLength(2);

    async function* broken() {
      yield { contentBlockDelta: { delta: { text: "a" } } };
      throw Object.assign(new Error("mid"), { name: "ThrottlingException" });
    }
    const mid = fakeClient({ ConverseStreamCommand: () => ({ stream: broken() }) });
    const q = createBedrockProvider({}, { sdk, client: mid, sleep: async () => {} });
    await expect(q.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow("mid");
    expect(mid.calls).toHaveLength(1);
  });

  it("stops waiting when the signal aborts between attempts", async () => {
    const controller = new AbortController();
    const client = throttlingClient(99, { ConverseCommand: converseReply("{}") });
    const sleep = async () => controller.abort();
    const p = createBedrockProvider({}, { sdk, client, sleep });
    await expect(p.extractJson({ prompt: "x", signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(client.calls).toHaveLength(1);
  });
});
