// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createBedrockProvider } from "../../packages/core/providers/bedrockProvider.mjs";
import { providerFromEnv } from "../../packages/core/providers/index.mjs";
import { assertProvider } from "../../packages/core/providers/modelProvider.mjs";

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
    expect(input.inferenceConfig).toEqual({ temperature: 0 });
    const text = input.messages[0].content[0].text;
    expect(text.startsWith("extract")).toBe(true);
    expect(text).toContain(JSON.stringify(schema));
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
});
