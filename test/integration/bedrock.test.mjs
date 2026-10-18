// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Needs AWS credentials with Bedrock access: CONCORDANCE_BEDROCK_TESTS=1 AWS_PROFILE=polycode-sandbox npm test.
import { describe, expect, it } from "vitest";
import { providerFromEnv } from "../../packages/core/providers/index.mjs";

const enabled = process.env.CONCORDANCE_BEDROCK_TESTS === "1";
if (!enabled) console.log("bedrock tier skipped: set CONCORDANCE_BEDROCK_TESTS=1 to run it");

describe.skipIf(!enabled)(
  "bedrock provider against live models (CONCORDANCE_BEDROCK_TESTS=1)",
  () => {
    const provider = enabled
      ? providerFromEnv({ ...process.env, MODEL_PROVIDER: "bedrock" })
      : null;

    it("returns one vector per text at the configured dimension (1 model call per text)", async () => {
      const vectors = await provider.embed(["smoke on the stairs", "the lift"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(1024);
      expect(vectors[1]).toHaveLength(1024);
    }, 60_000);

    it("streams a chat answer (1 model call)", async () => {
      const tokens = [];
      const result = await provider.chat({
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        onToken: (t) => tokens.push(t),
      });
      expect(tokens.length).toBeGreaterThan(0);
      expect(result.text.toLowerCase()).toContain("ready");
    }, 60_000);

    it("extracts a JSON object (1 model call)", async () => {
      const schema = {
        type: "object",
        properties: { subject: { type: "string" }, floor: { type: "number" } },
        required: ["subject", "floor"],
      };
      const result = await provider.extractJson({
        prompt: "Extract the subject and floor from: Maria saw smoke on floor 12.",
        schema,
      });
      expect(typeof result.subject).toBe("string");
      expect(typeof result.floor).toBe("number");
    }, 60_000);
  },
);
