// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The AWS model provider over Bedrock Runtime: Titan embeddings, Converse streaming for chat,
// Converse for extraction. The SDK loads on the first model call so the laptop path and the
// offline suite never import it.

import { parseJsonReply } from "./jsonReply.mjs";
import { ReplyTruncatedError } from "./modelProvider.mjs";
import {
  LAST_ROUND_TEXT,
  MAX_TOOL_ROUNDS,
  addUsage,
  answerStream,
  runToolCall,
} from "./toolLoop.mjs";

const EMBED_CONCURRENCY = 4;
const MAX_EMBED_CHARS = 45000;
const MAX_EMBED_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;
const RETRY_ATTEMPTS = 8;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 60000;
/** An embedding call that keeps being throttled waits this long in all before it gives up. */
export const EMBED_RETRY_BUDGET_MS = 60000;
const EMBED_RETRY_BASE_MS = 1000;
const EMBED_RETRY_CAP_MS = 20000;
const EXTRACT_INTERVAL_MS = 1500;
const EXTRACT_MAX_TOKENS = 8192;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottle(error) {
  return (
    error?.name === "ThrottlingException" ||
    error?.name === "TooManyRequestsException" ||
    error?.$metadata?.httpStatusCode === 429
  );
}

/**
 * Reads one ConverseStream reply: streams its text through onText and returns its content blocks
 * in order, with each toolUse input parsed, and the usage it reported.
 */
async function readReply(stream, signal, onText) {
  const blocks = new Map();
  let usage = null;
  for await (const event of stream) {
    signal?.throwIfAborted();
    if (event.metadata?.usage) {
      const { inputTokens, outputTokens } = event.metadata.usage;
      usage = { inputTokens, outputTokens };
    }
    const index =
      event.contentBlockStart?.contentBlockIndex ?? event.contentBlockDelta?.contentBlockIndex ?? 0;
    const started = event.contentBlockStart?.start?.toolUse;
    if (started) {
      blocks.set(index, { toolUseId: started.toolUseId, name: started.name, input: "" });
    }
    const delta = event.contentBlockDelta?.delta;
    if (delta?.text) {
      const block = blocks.get(index) ?? { text: "" };
      block.text += delta.text;
      blocks.set(index, block);
      onText(delta.text);
    }
    if (delta?.toolUse) blocks.get(index).input += delta.toolUse.input ?? "";
  }
  const content = [...blocks.keys()]
    .sort((x, y) => x - y)
    .map((k) => blocks.get(k))
    .filter((b) => b.toolUseId || b.text)
    .map((b) =>
      b.toolUseId
        ? {
            toolUse: {
              toolUseId: b.toolUseId,
              name: b.name,
              input: b.input ? JSON.parse(b.input) : {},
            },
          }
        : { text: b.text },
    );
  return { content, usage };
}

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
 * @param {(ms: number) => Promise<void>} [injected.sleep]  The wait between throttling retries and between extraction calls.
 * @param {() => number} [injected.now]  The clock, in milliseconds, that paces extraction calls.
 * @returns {import('./modelProvider.mjs').ModelProvider}
 */
export function createBedrockProvider(
  env = process.env,
  { sdk, client, sleep = defaultSleep, now = Date.now } = {},
) {
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

  // The extraction model's quota is shared by every concurrent caller, so each call takes the next free slot.
  let nextExtractSlot = 0;
  async function paceExtraction(signal) {
    const slot = Math.max(now(), nextExtractSlot);
    nextExtractSlot = slot + EXTRACT_INTERVAL_MS;
    const wait = slot - now();
    if (wait > 0) {
      signal?.throwIfAborted();
      await sleep(wait);
      signal?.throwIfAborted();
    }
  }

  /** Runs call(); on throttling waits with full-jitter backoff and tries again. */
  async function withRetry(call, signal) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!isThrottle(error)) throw error;
        if (attempt >= RETRY_ATTEMPTS) {
          throw new Error(`throttled after ${attempt} attempts: ${error.message}`, {
            cause: error,
          });
        }
        signal?.throwIfAborted();
        await sleep(Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)));
        signal?.throwIfAborted();
      }
    }
  }

  /**
   * Runs call(); on throttling waits between half and all of a doubling delay, so concurrent
   * callers sharing the quota are spread out, until the waits add up to EMBED_RETRY_BUDGET_MS.
   */
  async function withEmbedRetry(call) {
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!isThrottle(error)) throw error;
        if (waited >= EMBED_RETRY_BUDGET_MS) {
          throw new Error(`throttled after ${attempt} attempts: ${error.message}`, {
            cause: error,
          });
        }
        const ceiling = Math.min(EMBED_RETRY_CAP_MS, EMBED_RETRY_BASE_MS * 2 ** (attempt - 1));
        const wait = Math.min(
          ceiling / 2 + (Math.random() * ceiling) / 2,
          EMBED_RETRY_BUDGET_MS - waited,
        );
        waited += wait;
        await sleep(wait);
      }
    }
  }

  async function embedOne(text, { mod, runtime }) {
    const command = new mod.InvokeModelCommand({
      modelId: embedModel,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: embedDim, normalize: true }),
    });
    const response = await withEmbedRetry(() => runtime.send(command));
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
      texts.forEach((text, index) => {
        if (text.length > MAX_EMBED_CHARS || text.length / CHARS_PER_TOKEN > MAX_EMBED_TOKENS) {
          throw new Error(
            `embed input ${index} is ${text.length} characters; the limit is ${MAX_EMBED_CHARS} characters or ${MAX_EMBED_TOKENS} tokens`,
          );
        }
      });
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

    async chat({
      messages,
      signal,
      temperature = 0,
      onToken,
      promptVersion = "unversioned",
      tools,
    }) {
      signal?.throwIfAborted();
      const { mod, runtime } = await connect();
      const system = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
      const history = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: [{ text: m.content }] }));
      const toolConfig = tools?.length
        ? {
            tools: tools.map((t) => ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: { json: t.inputSchema },
              },
            })),
          }
        : null;
      const answer = answerStream(onToken);
      const toolCalls = [];
      let usage = null;
      for (let round = 0; ; round++) {
        const command = new mod.ConverseStreamCommand({
          modelId: chatModel,
          ...(system.length ? { system } : {}),
          messages: [...history],
          inferenceConfig: { temperature },
          ...(toolConfig ? { toolConfig } : {}),
        });
        const response = await withRetry(
          () => runtime.send(command, { abortSignal: signal }),
          signal,
        );
        answer.startRound();
        const reply = await readReply(response.stream, signal, (piece) => answer.push(piece));
        usage = addUsage(usage, reply.usage);
        const uses = reply.content.filter((block) => block.toolUse);
        if (!uses.length) break;
        if (!toolConfig)
          throw new Error(`${chatModel} asked for a tool, and the chat offered none`);
        if (round === MAX_TOOL_ROUNDS) {
          throw new Error(`${chatModel} asked for a tool after ${MAX_TOOL_ROUNDS} tool rounds`);
        }
        history.push({ role: "assistant", content: reply.content });
        const results = [];
        for (const { toolUse } of uses) {
          const { content, call } = await runToolCall(tools, toolUse.name, toolUse.input);
          signal?.throwIfAborted();
          toolCalls.push(call);
          results.push({
            toolResult: { toolUseId: toolUse.toolUseId, content: [{ text: content }] },
          });
        }
        if (round + 1 === MAX_TOOL_ROUNDS) results.push({ text: LAST_ROUND_TEXT });
        history.push({ role: "user", content: results });
      }
      signal?.throwIfAborted();
      const result = { text: answer.text, model: chatModel, promptVersion, usage };
      return toolConfig ? { ...result, toolCalls } : result;
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
        inferenceConfig: { temperature: 0, maxTokens: EXTRACT_MAX_TOKENS },
      });
      const response = await withRetry(async () => {
        await paceExtraction(signal);
        return runtime.send(command, { abortSignal: signal });
      }, signal);
      const content = response.output?.message?.content?.[0]?.text ?? "";
      if (response.stopReason === "max_tokens") {
        throw new ReplyTruncatedError(extractModel, content.length);
      }
      return parseJsonReply(content, extractModel);
    },
  };
}
