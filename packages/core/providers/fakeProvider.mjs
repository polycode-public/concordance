// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { runToolCall } from "./toolLoop.mjs";

/**
 * A deterministic provider for tests. It streams fixed tokens with a delay per token and
 * honours the abort signal. embed() returns a vector of embedDim zeros with a 1 in the last
 * position, or embedFor(text) when given. extractJson() returns extractJson(args) when given,
 * else an empty object. When a chat offers tools, chat() first runs each round of toolRounds
 * in order, then streams the tokens.
 * @param {{ tokens: string[], delayMs?: number, embedDim?: number,
 *   embedFor?: (text: string) => number[],
 *   extractJson?: (args: { prompt: string, schema?: object }) => object,
 *   toolRounds?: { name: string, input: object }[][] }} options
 */
export function createFakeProvider({
  tokens,
  delayMs = 20,
  embedDim = 4,
  embedFor,
  extractJson,
  toolRounds = [],
}) {
  const calls = [];
  const unitVector = Array.from({ length: embedDim }, (_, i) => (i === embedDim - 1 ? 1 : 0));
  return {
    name: "fake",
    embedModel: "fake-embed",
    embedDim,
    extractModel: "fake-extract",
    calls,
    async embed(texts) {
      return texts.map((text) => (embedFor ? embedFor(text) : [...unitVector]));
    },
    async extractJson(args) {
      return extractJson ? extractJson(args) : {};
    },
    async chat({ messages, signal, onToken, promptVersion = "unversioned", tools }) {
      calls.push({ messages, tools });
      const toolCalls = [];
      const toolResults = [];
      if (tools?.length) {
        for (const round of toolRounds) {
          for (const { name, input } of round) {
            const { content, call } = await runToolCall(tools, name, input);
            toolCalls.push(call);
            toolResults.push(content);
          }
        }
      }
      let text = "";
      for (const token of tokens) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        signal?.throwIfAborted();
        text += token;
        onToken?.(token);
      }
      const result = {
        text,
        model: "fake-chat",
        promptVersion,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      if (!tools?.length) return result;
      calls.at(-1).toolResults = toolResults;
      return { ...result, toolCalls };
    },
  };
}
