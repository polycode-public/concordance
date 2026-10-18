// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Needs a running Ollama with the models pulled: CONCORDANCE_OLLAMA_TESTS=1 npm test.
import { describe, expect, it } from "vitest";
import { providerFromEnv } from "../../packages/core/providers/index.mjs";

const enabled = process.env.CONCORDANCE_OLLAMA_TESTS === "1";
if (!enabled) console.log("ollama tier skipped: set CONCORDANCE_OLLAMA_TESTS=1 to run it");

describe.skipIf(!enabled)(
  "ollama provider against a live server (CONCORDANCE_OLLAMA_TESTS=1)",
  () => {
    const provider = enabled ? providerFromEnv({ ...process.env, MODEL_PROVIDER: "laptop" }) : null;

    it("returns one vector per text at the configured dimension", async () => {
      const vectors = await provider.embed(["smoke on the stairs", "the lift"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(provider.embedDim);
    }, 120_000);

    it("streams a chat answer", async () => {
      const tokens = [];
      const result = await provider.chat({
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        onToken: (t) => tokens.push(t),
      });
      expect(tokens.length).toBeGreaterThan(0);
      expect(result.text.toLowerCase()).toContain("ready");
    }, 300_000);
  },
);
