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
    expect(cost).toBeCloseTo((3 + 3) * 1.1, 10);
    expect(
      costOf({ model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 1000 }),
    ).toBeCloseTo(0.002 + 0.005, 10);
  });

  it("prices cache reads and writes apart from the uncached input", () => {
    const sonnet = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
    expect(
      costOf({
        model: sonnet,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBeCloseTo((0.3 * 3 + 0.6 * 0.3 + 0.1 * 3.75) * 1.1, 10);
    expect(
      costOf({
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.1, 10);
  });

  it("adds the regional premium to a geography profile and not to a global or bare id", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const base = costOf({ model: "anthropic.claude-sonnet-4-5-20250929-v1:0", ...tokens });
    expect(base).toBeCloseTo(18, 10);
    expect(costOf({ model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0", ...tokens })).toBe(
      base,
    );
    expect(
      costOf({ model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", ...tokens }),
    ).toBeCloseTo(18 * 1.1, 10);
    expect(costOf({ model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", ...tokens })).toBeCloseTo(
      6 * 1.1,
      10,
    );
    expect(costOf({ model: "eu.amazon.titan-embed-text-v2:0", ...tokens })).toBeCloseTo(0.02, 10);
  });

  it("has no cost for cache tokens on a model with no cache price", () => {
    expect(
      costOf({
        model: "amazon.titan-embed-text-v2:0",
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 5,
      }),
    ).toBeNull();
  });
});
