// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The AWS model provider. It sits behind the same interface as the laptop
// provider; until it is built, selecting it fails at startup.

/** @returns {import('./modelProvider.mjs').ModelProvider} */
export function createBedrockProvider() {
  throw new Error("bedrock provider is not built yet; set MODEL_PROVIDER=laptop");
}
