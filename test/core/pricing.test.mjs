// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { CURRENCY, LIST_PRICES, costOf, priceFor } from "../../packages/core/pricing.mjs";

describe("the list prices", () => {
  it("prices the models the providers name, by family", () => {
    expect(CURRENCY).toBe("USD");
    expect(priceFor("eu.anthropic.claude-sonnet-4-5-20250929-v1:0")).toMatchObject({
      input: 3,
      output: 15,
    });
    expect(priceFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toMatchObject({
      input: 1,
      output: 5,
    });
    expect(priceFor("amazon.titan-embed-text-v2:0")).toMatchObject({ input: 0.02, output: 0 });
    for (const price of LIST_PRICES) expect(Object.isFrozen(price)).toBe(true);
  });

  it("has no price for an unknown or missing model", () => {
    expect(priceFor("qwen3:8b")).toBeNull();
    expect(priceFor(null)).toBeNull();
    expect(costOf({ model: "qwen3:8b", inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("costs tokens per million at the input and output prices", () => {
    const cost = costOf({
      model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
    });
    expect(cost).toBeCloseTo(3 + 3, 10);
    expect(
      costOf({ model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 1000 }),
    ).toBeCloseTo(0.002 + 0.005, 10);
  });
});
