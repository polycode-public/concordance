// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/checkBudget.mjs";

const budget = (actual, limit) => ({
  Budget: {
    BudgetName: "concordance-sandbox-monthly",
    BudgetLimit: { Amount: limit, Unit: "USD" },
    CalculatedSpend: { ActualSpend: { Amount: actual, Unit: "USD" } },
  },
});

const handlerFor = (response) => {
  const calls = [];
  const handler = createHandler({
    describeBudget: async (input) => {
      calls.push(input);
      return response;
    },
    accountId: "111111111111",
    budgetName: "concordance-sandbox-monthly",
  });
  return { handler, calls };
};

describe("checkBudget handler", () => {
  it("returns the spend and the limit when the spend is under the limit", async () => {
    const { handler, calls } = handlerFor(budget("3.21", "25.0"));
    expect(await handler({ corpus: "grenfell" })).toEqual({ actual: 3.21, limit: 25, unit: "USD" });
    expect(calls).toEqual([
      { AccountId: "111111111111", BudgetName: "concordance-sandbox-monthly" },
    ]);
  });

  it("throws when the spend has reached the limit", async () => {
    await expect(handlerFor(budget("25.0", "25.0")).handler()).rejects.toThrow(
      "budget concordance-sandbox-monthly: spend 25 USD has reached the limit 25",
    );
    await expect(handlerFor(budget("30.5", "25.0")).handler()).rejects.toThrow(/reached the limit/);
  });

  it("throws when the budget has no amounts", async () => {
    await expect(handlerFor({ Budget: {} }).handler()).rejects.toThrow(/no actual spend/);
  });

  it("throws without an account id or a budget name", async () => {
    const handler = createHandler({
      describeBudget: async () => budget("0", "1"),
      budgetName: "b",
    });
    await expect(handler()).rejects.toThrow(/account id and budget name/);
  });
});
