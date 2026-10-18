// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The laptop model provider over the Ollama HTTP API.

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

    async chat({ messages, signal, temperature = 0, onToken, promptVersion = "unversioned" }) {
      const res = await post(
        "/api/chat",
        { model: chatModel, messages, stream: true, options: { temperature } },
        signal,
      );
      let text = "";
      let model = chatModel;
      for await (const message of readNdjson(res.body, signal)) {
        if (message.error) throw new Error(`ollama /api/chat: ${message.error}`);
        if (message.model) model = message.model;
        const piece = message.message?.content ?? "";
        if (piece) {
          text += piece;
          onToken?.(piece);
        }
        if (message.done) break;
      }
      return { text, model, promptVersion };
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
      try {
        return JSON.parse(content);
      } catch {
        throw new Error(`extraction model returned invalid JSON: ${content.slice(0, 200)}`);
      }
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
