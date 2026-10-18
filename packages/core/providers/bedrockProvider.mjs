// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The AWS model provider over Bedrock Runtime: Titan embeddings, Converse streaming for chat,
// Converse for extraction. The SDK loads on the first model call so the laptop path and the
// offline suite never import it.

const EMBED_CONCURRENCY = 8;

let sdkPromise;
function loadSdk() {
  sdkPromise ??= import("@aws-sdk/client-bedrock-runtime");
  return sdkPromise;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {object} [injected]
 * @param {object} [injected.sdk]     The module exports of @aws-sdk/client-bedrock-runtime.
 * @param {object} [injected.client]  A ready client with send(command, options).
 * @returns {import('./modelProvider.mjs').ModelProvider}
 */
export function createBedrockProvider(env = process.env, { sdk, client } = {}) {
  const region = env.AWS_REGION || "eu-west-2";
  const embedModel = env.BEDROCK_EMBED_MODEL || "amazon.titan-embed-text-v2:0";
  const embedDim = env.BEDROCK_EMBED_DIM ? Number(env.BEDROCK_EMBED_DIM) : 1024;
  const chatModel = env.BEDROCK_CHAT_MODEL || "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const extractModel = env.BEDROCK_EXTRACT_MODEL || "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

  let ready;
  function connect() {
    ready ??= (async () => {
      const mod = sdk ?? (await loadSdk());
      return { mod, runtime: client ?? new mod.BedrockRuntimeClient({ region }) };
    })();
    return ready;
  }

  async function embedOne(text, { mod, runtime }) {
    const command = new mod.InvokeModelCommand({
      modelId: embedModel,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: embedDim, normalize: true }),
    });
    const response = await runtime.send(command);
    const { embedding } = JSON.parse(new TextDecoder().decode(response.body));
    if (!Array.isArray(embedding) || embedding.length !== embedDim) {
      throw new Error(
        `${embedModel} returned ${embedding?.length ?? "no"} dimensions, expected ${embedDim}`,
      );
    }
    return embedding;
  }

  return {
    name: "bedrock",
    embedModel,
    embedDim,
    extractModel,

    async embed(texts) {
      const connection = await connect();
      const vectors = new Array(texts.length);
      let next = 0;
      async function worker() {
        while (next < texts.length) {
          const index = next++;
          vectors[index] = await embedOne(texts[index], connection);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(EMBED_CONCURRENCY, texts.length) }, () => worker()),
      );
      return vectors;
    },

    async chat({ messages, signal, temperature = 0, onToken, promptVersion = "unversioned" }) {
      signal?.throwIfAborted();
      const { mod, runtime } = await connect();
      const system = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
      const command = new mod.ConverseStreamCommand({
        modelId: chatModel,
        ...(system.length ? { system } : {}),
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: [{ text: m.content }] })),
        inferenceConfig: { temperature },
      });
      const response = await runtime.send(command, { abortSignal: signal });
      let text = "";
      let usage = null;
      for await (const event of response.stream) {
        signal?.throwIfAborted();
        if (event.metadata?.usage) {
          const { inputTokens, outputTokens } = event.metadata.usage;
          usage = { inputTokens, outputTokens };
        }
        const piece = event.contentBlockDelta?.delta?.text;
        if (piece) {
          text += piece;
          onToken?.(piece);
        }
      }
      signal?.throwIfAborted();
      return { text, model: chatModel, promptVersion, usage };
    },

    async extractJson({ prompt, schema, signal }) {
      signal?.throwIfAborted();
      const { mod, runtime } = await connect();
      const instruction = schema
        ? `Answer with exactly one JSON object matching this schema:\n${JSON.stringify(schema)}`
        : "Answer with exactly one JSON object.";
      const command = new mod.ConverseCommand({
        modelId: extractModel,
        messages: [{ role: "user", content: [{ text: `${prompt}\n\n${instruction}` }] }],
        inferenceConfig: { temperature: 0 },
      });
      const response = await runtime.send(command, { abortSignal: signal });
      const content = response.output?.message?.content?.[0]?.text ?? "";
      const json = content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      try {
        return JSON.parse(json);
      } catch {
        throw new Error(`${extractModel} returned invalid JSON: ${content.slice(0, 200)}`);
      }
    },
  };
}
