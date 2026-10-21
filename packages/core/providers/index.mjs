// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { assertProvider } from "./modelProvider.mjs";
import { createOllamaProvider } from "./ollamaProvider.mjs";
import { createBedrockProvider } from "./bedrockProvider.mjs";
import { modelReranker } from "./rerank.mjs";

export const RERANK_MODES = Object.freeze(["off", "model"]);

/**
 * Selects the model provider from MODEL_PROVIDER: 'laptop' (the default) or 'bedrock'. With
 * RERANK=model the provider also has rerank(), which scores passages on its extraction model;
 * RERANK=off (the default) leaves it out, so retrieval keeps the fused order.
 * @param {Record<string, string | undefined>} [env]
 * @returns {import('./modelProvider.mjs').ModelProvider}
 */
export function providerFromEnv(env = process.env) {
  const rerank = env.RERANK || "off";
  if (!RERANK_MODES.includes(rerank)) {
    throw new Error(`unknown RERANK ${rerank}; use ${RERANK_MODES.join(" or ")}`);
  }
  const provider = modelProviderFromEnv(env);
  if (rerank === "model") provider.rerank = modelReranker(provider);
  return provider;
}

function modelProviderFromEnv(env) {
  const kind = env.MODEL_PROVIDER || "laptop";
  switch (kind) {
    case "laptop":
    case "local":
      return assertProvider(
        createOllamaProvider({
          baseUrl: env.OLLAMA_URL || undefined,
          embedModel: env.EMBED_MODEL || undefined,
          embedDim: env.EMBED_DIM ? Number(env.EMBED_DIM) : undefined,
          chatModel: env.CHAT_MODEL || undefined,
          extractModel: env.EXTRACT_MODEL || env.CHAT_MODEL || undefined,
        }),
      );
    case "bedrock":
      return assertProvider(createBedrockProvider(env));
    default:
      throw new Error(`unknown MODEL_PROVIDER ${kind}; use laptop or bedrock`);
  }
}
