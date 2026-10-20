// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createBedrockProvider } from "../../packages/core/providers/bedrockProvider.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { createOllamaProvider } from "../../packages/core/providers/ollamaProvider.mjs";
import {
  LAST_ROUND_TEXT,
  MAX_TOOL_ROUNDS,
  ROUND_SEPARATOR,
  addUsage,
} from "../../packages/core/providers/toolLoop.mjs";

class BedrockRuntimeClient {}
class Recorded {
  constructor(input) {
    this.input = input;
  }
}
class ConverseStreamCommand extends Recorded {}
const sdk = { BedrockRuntimeClient, ConverseStreamCommand };

function scriptedClient(replies) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(structuredClone(command.input));
      const next = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { stream: next() };
    },
  };
}

const toolUseReply = (
  name,
  inputJson,
  { text = "", usage = { inputTokens: 10, outputTokens: 2 } } = {},
) =>
  async function* () {
    let index = 0;
    if (text) yield { contentBlockDelta: { contentBlockIndex: index++, delta: { text } } };
    yield {
      contentBlockStart: {
        contentBlockIndex: index,
        start: { toolUse: { toolUseId: `use-${name}`, name } },
      },
    };
    const half = Math.ceil(inputJson.length / 2);
    for (const piece of [inputJson.slice(0, half), inputJson.slice(half)]) {
      yield {
        contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: piece } } },
      };
    }
    yield { contentBlockStop: { contentBlockIndex: index } };
    yield { messageStop: { stopReason: "tool_use" } };
    yield { metadata: { usage } };
  };

const textReply = (pieces, usage = { inputTokens: 20, outputTokens: 3 }) =>
  async function* () {
    for (const text of pieces)
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
    yield { messageStop: { stopReason: "end_turn" } };
    yield { metadata: { usage } };
  };

function countingTool(name = "count_assertions") {
  const inputs = [];
  return {
    inputs,
    tool: {
      name,
      description: "Counts.",
      inputSchema: { type: "object", properties: { groupBy: { type: "string" } } },
      async run(input) {
        inputs.push(input);
        return { content: '{"rows":[{"count":2,"evidence":"E3"}]}', rows: 1 };
      },
    },
  };
}

describe("the bedrock tool loop", () => {
  it("runs a requested tool, sends its result back and streams the answer", async () => {
    const client = scriptedClient([
      toolUseReply("count_assertions", '{"groupBy":"witness"}'),
      textReply(["Two ", "[E3]."]),
    ]);
    const p = createBedrockProvider({}, { sdk, client });
    const { tool, inputs } = countingTool();
    const tokens = [];
    const result = await p.chat({
      messages: [
        { role: "system", content: "Answer." },
        { role: "user", content: "How many?" },
      ],
      onToken: (t) => tokens.push(t),
      promptVersion: "v",
      tools: [tool],
    });
    expect(inputs).toEqual([{ groupBy: "witness" }]);
    expect(tokens).toEqual(["Two ", "[E3]."]);
    expect(result).toMatchObject({
      text: "Two [E3].",
      promptVersion: "v",
      usage: { inputTokens: 30, outputTokens: 5 },
      toolCalls: [{ name: "count_assertions", input: { groupBy: "witness" }, rows: 1 }],
    });
    expect(result.toolCalls[0].ms).toBeGreaterThanOrEqual(0);
    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(call.toolConfig.tools).toEqual([
        {
          toolSpec: {
            name: "count_assertions",
            description: "Counts.",
            inputSchema: { json: tool.inputSchema },
          },
        },
      ]);
    }
    expect(client.calls[1].messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "use-count_assertions",
              name: "count_assertions",
              input: { groupBy: "witness" },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "use-count_assertions",
              content: [{ text: '{"rows":[{"count":2,"evidence":"E3"}]}' }],
            },
          },
        ],
      },
    ]);
  });

  it("joins the text of two replies with a paragraph break", async () => {
    const client = scriptedClient([
      toolUseReply("count_assertions", "{}", { text: "Counting." }),
      textReply(["Two [E3]."]),
    ]);
    const p = createBedrockProvider({}, { sdk, client });
    const tokens = [];
    const result = await p.chat({
      messages: [{ role: "user", content: "How many?" }],
      onToken: (t) => tokens.push(t),
      tools: [countingTool().tool],
    });
    expect(result.text).toBe(`Counting.${ROUND_SEPARATOR}Two [E3].`);
    expect(tokens.join("")).toBe(result.text);
    expect(client.calls[1].messages[1].content[0]).toEqual({ text: "Counting." });
  });

  it("tells the model the limit after the last tool round and fails a tool request after it", async () => {
    const client = scriptedClient([toolUseReply("count_assertions", "{}")]);
    const p = createBedrockProvider({}, { sdk, client });
    const { tool, inputs } = countingTool();
    await expect(
      p.chat({ messages: [{ role: "user", content: "q" }], tools: [tool] }),
    ).rejects.toThrow(`after ${MAX_TOOL_ROUNDS} tool rounds`);
    expect(inputs).toHaveLength(MAX_TOOL_ROUNDS);
    expect(client.calls).toHaveLength(MAX_TOOL_ROUNDS + 1);
    const last = client.calls.at(-1).messages.at(-1);
    expect(last.content.at(-1)).toEqual({ text: LAST_ROUND_TEXT });
    expect(client.calls[1].messages.at(-1).content.some((b) => b.text)).toBe(false);
  });

  it("answers after the last tool round when the model stops asking", async () => {
    const replies = Array.from({ length: MAX_TOOL_ROUNDS }, () =>
      toolUseReply("count_assertions", "{}"),
    );
    const client = scriptedClient([...replies, textReply(["Done [E1]."])]);
    const p = createBedrockProvider({}, { sdk, client });
    const result = await p.chat({
      messages: [{ role: "user", content: "q" }],
      tools: [countingTool().tool],
    });
    expect(result.text).toBe("Done [E1].");
    expect(result.toolCalls).toHaveLength(MAX_TOOL_ROUNDS);
  });

  it("fails the chat when a tool throws", async () => {
    const client = scriptedClient([toolUseReply("count_assertions", "{}"), textReply(["x"])]);
    const p = createBedrockProvider({}, { sdk, client });
    const tool = { ...countingTool().tool, run: async () => Promise.reject(new Error("bad SQL")) };
    await expect(
      p.chat({ messages: [{ role: "user", content: "q" }], tools: [tool] }),
    ).rejects.toThrow("bad SQL");
    expect(client.calls).toHaveLength(1);
  });

  it("fails the chat when the model names a tool it was not offered", async () => {
    const client = scriptedClient([toolUseReply("drop_tables", "{}")]);
    const p = createBedrockProvider({}, { sdk, client });
    await expect(
      p.chat({ messages: [{ role: "user", content: "q" }], tools: [countingTool().tool] }),
    ).rejects.toThrow(/"drop_tables", which is not a tool/);
  });

  it("sends no tool config and returns no tool calls for a chat without tools", async () => {
    const client = scriptedClient([textReply(["Hi."])]);
    const p = createBedrockProvider({}, { sdk, client });
    const result = await p.chat({ messages: [{ role: "user", content: "q" }], promptVersion: "v" });
    expect(client.calls[0]).not.toHaveProperty("toolConfig");
    expect(result).toEqual({
      text: "Hi.",
      model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      promptVersion: "v",
      usage: { inputTokens: 20, outputTokens: 3 },
    });
  });
});

function ndjsonResponse(lines) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const ollamaToolCall = (name, args) => [
  {
    model: "qwen",
    message: { content: "", tool_calls: [{ function: { name, arguments: args } }] },
    done: false,
  },
  { model: "qwen", message: { content: "" }, done: true, prompt_eval_count: 7, eval_count: 1 },
];
const ollamaText = (text) => [
  { model: "qwen", message: { content: text }, done: false },
  { model: "qwen", message: { content: "" }, done: true, prompt_eval_count: 9, eval_count: 4 },
];

describe("the ollama tool loop", () => {
  it("offers the tools, runs a tool call and sends a tool message back", async () => {
    const bodies = [];
    const replies = [
      ollamaToolCall("count_assertions", { groupBy: "event" }),
      ollamaText("One [E2]."),
    ];
    const p = createOllamaProvider({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return ndjsonResponse(replies[bodies.length - 1]);
      },
    });
    const { tool, inputs } = countingTool();
    const result = await p.chat({ messages: [{ role: "user", content: "q" }], tools: [tool] });
    expect(inputs).toEqual([{ groupBy: "event" }]);
    expect(result).toMatchObject({
      text: "One [E2].",
      usage: { inputTokens: 16, outputTokens: 5 },
      toolCalls: [{ name: "count_assertions", input: { groupBy: "event" }, rows: 1 }],
    });
    expect(bodies[0].tools).toEqual([
      {
        type: "function",
        function: {
          name: "count_assertions",
          description: "Counts.",
          parameters: tool.inputSchema,
        },
      },
    ]);
    expect(bodies[1].messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "count_assertions", arguments: { groupBy: "event" } } }],
      },
      {
        role: "tool",
        tool_name: "count_assertions",
        content: '{"rows":[{"count":2,"evidence":"E3"}]}',
      },
    ]);
  });

  it("drops the tools from the call after the last tool round", async () => {
    const bodies = [];
    const p = createOllamaProvider({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return ndjsonResponse(
          bodies.length <= MAX_TOOL_ROUNDS
            ? ollamaToolCall("count_assertions", {})
            : ollamaText("Done [E1]."),
        );
      },
    });
    const result = await p.chat({
      messages: [{ role: "user", content: "q" }],
      tools: [countingTool().tool],
    });
    expect(result.text).toBe("Done [E1].");
    expect(bodies).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(bodies.at(-1)).not.toHaveProperty("tools");
    expect(bodies.at(-1).messages.at(-1)).toEqual({ role: "user", content: LAST_ROUND_TEXT });
  });

  it("sends no tools and returns no tool calls for a chat without tools", async () => {
    let body;
    const p = createOllamaProvider({
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return ndjsonResponse(ollamaText("Hi."));
      },
    });
    const result = await p.chat({ messages: [{ role: "user", content: "q" }] });
    expect(body).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("toolCalls");
  });
});

describe("the fake provider's tool rounds", () => {
  it("runs each planned call through the offered tools before it streams", async () => {
    const { tool, inputs } = countingTool();
    const p = createFakeProvider({
      tokens: ["A [E1]."],
      delayMs: 0,
      toolRounds: [[{ name: "count_assertions", input: { groupBy: "witness" } }]],
    });
    const result = await p.chat({ messages: [], tools: [tool] });
    expect(inputs).toEqual([{ groupBy: "witness" }]);
    expect(result.toolCalls).toMatchObject([{ name: "count_assertions", rows: 1 }]);
    expect(p.calls[0].toolResults).toEqual(['{"rows":[{"count":2,"evidence":"E3"}]}']);
  });
});

describe("addUsage", () => {
  it("sums two records and keeps null when neither has one", () => {
    expect(addUsage(null, null)).toBeNull();
    expect(addUsage(null, { inputTokens: 1, outputTokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(
      addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toEqual({ inputTokens: 4, outputTokens: 6 });
  });
});
