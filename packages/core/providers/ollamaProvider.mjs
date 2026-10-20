// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The laptop model provider over the Ollama HTTP API.

import { parseJsonReply } from "./jsonReply.mjs";
import { ReplyTruncatedError } from "./modelProvider.mjs";
import {
  LAST_ROUND_TEXT,
  MAX_TOOL_ROUNDS,
  addUsage,
  answerStream,
  runToolCall,
} from "./toolLoop.mjs";

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.embedModel]
 * @param {number} [options.embedDim]
 * @param {string} [options.chatModel]
 * @param {string} [options.extractModel]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {import('./modelProvider.mjs').ModelProvider}
 */
export function createOllamaProvider({
  baseUrl = "http://localhost:11434",
  embedModel = "bge-m3",
  embedDim = 1024,
  chatModel = "qwen2.5:7b-instruct",
  extractModel = chatModel,
  fetchImpl = fetch,
} = {}) {
  const url = (p) => new URL(p, baseUrl).toString();

  async function post(p, body, signal) {
    const res = await fetchImpl(url(p), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ollama ${p} returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res;
  }

  return {
    name: "laptop",
    embedModel,
    embedDim,
    extractModel,

    async embed(texts) {
      const res = await post("/api/embed", { model: embedModel, input: texts });
      const { embeddings } = await res.json();
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error("ollama /api/embed returned the wrong number of vectors");
      }
      return embeddings;
    },

    async chat({
      messages,
      signal,
      temperature = 0,
      onToken,
      promptVersion = "unversioned",
      tools,
    }) {
      const offered = tools?.length
        ? tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }))
        : null;
      const history = [...messages];
      const answer = answerStream(onToken);
      const toolCalls = [];
      let model = chatModel;
      let usage = null;
      for (let round = 0; ; round++) {
        const lastRound = round === MAX_TOOL_ROUNDS;
        const res = await post(
          "/api/chat",
          {
            model: chatModel,
            messages: [...history],
            stream: true,
            options: { temperature },
            ...(offered && !lastRound ? { tools: offered } : {}),
          },
          signal,
        );
        answer.startRound();
        let content = "";
        const calls = [];
        for await (const message of readNdjson(res.body, signal)) {
          if (message.error) throw new Error(`ollama /api/chat: ${message.error}`);
          if (message.model) model = message.model;
          const piece = message.message?.content ?? "";
          if (piece) {
            content += piece;
            answer.push(piece);
          }
          calls.push(...(message.message?.tool_calls ?? []));
          if (message.done) {
            if (Number.isFinite(message.prompt_eval_count) && Number.isFinite(message.eval_count)) {
              usage = addUsage(usage, {
                inputTokens: message.prompt_eval_count,
                outputTokens: message.eval_count,
              });
            }
            break;
          }
        }
        if (!calls.length) break;
        if (!offered) throw new Error(`${model} asked for a tool, and the chat offered none`);
        if (lastRound) {
          throw new Error(`${model} asked for a tool after ${MAX_TOOL_ROUNDS} tool rounds`);
        }
        history.push({ role: "assistant", content, tool_calls: calls });
        for (const { function: fn } of calls) {
          const { content: result, call } = await runToolCall(tools, fn?.name, fn?.arguments);
          signal?.throwIfAborted();
          toolCalls.push(call);
          history.push({ role: "tool", tool_name: call.name, content: result });
        }
        if (round + 1 === MAX_TOOL_ROUNDS) history.push({ role: "user", content: LAST_ROUND_TEXT });
      }
      const result = { text: answer.text, model, promptVersion, usage };
      return offered ? { ...result, toolCalls } : result;
    },

    async extractJson({ prompt, schema, signal }) {
      const res = await post(
        "/api/chat",
        {
          model: extractModel,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          format: schema ?? "json",
          options: { temperature: 0 },
        },
        signal,
      );
      const body = await res.json();
      const content = body.message?.content ?? "";
      if (body.done_reason === "length") {
        throw new ReplyTruncatedError(extractModel, content.length);
      }
      return parseJsonReply(content, "extraction model");
    },
  };
}

/**
 * Yields one parsed object per line of an NDJSON byte stream.
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} [signal]
 */
export async function* readNdjson(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer.trim());
  } finally {
    reader.releaseLock?.();
  }
}
