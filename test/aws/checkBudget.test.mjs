// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/checkBudget.mjs";

const budget = (name, actual, limit) => ({
  Budget: {
    BudgetName: name,
    BudgetLimit: { Amount: limit, Unit: "USD" },
    CalculatedSpend: { ActualSpend: { Amount: actual, Unit: "USD" } },
  },
});

const NAMES = ["concordance-sandbox-monthly", "concordance-sandbox-models"];

const handlerFor = (actuals, estimate = 0) => {
  const calls = [];
  const handler = createHandler({
    describeBudget: async (input) => {
      calls.push(input);
      return typeof actuals[input.BudgetName] === "object"
        ? actuals[input.BudgetName]
        : budget(input.BudgetName, actuals[input.BudgetName], "25.0");
    },
    readEstimate: async () => estimate,
    accountId: "111111111111",
    budgetNames: NAMES,
  });
  return { handler, calls };
};

describe("checkBudget handler", () => {
  it("reads both budgets and returns the highest spend with the estimate", async () => {
    const { handler, calls } = handlerFor({ [NAMES[0]]: "3.21", [NAMES[1]]: "10.5" }, 12.25);
    expect(await handler({ corpus: "grenfell" })).toEqual({
      actual: 10.5,
      limit: 25,
      unit: "USD",
      estimate: 12.25,
    });
    expect(calls).toEqual(NAMES.map((BudgetName) => ({ AccountId: "111111111111", BudgetName })));
  });

  it("throws when either budget has reached the limit", async () => {
    await expect(handlerFor({ [NAMES[0]]: "25.0", [NAMES[1]]: "1" }).handler()).rejects.toThrow(
      "budget concordance-sandbox-monthly: spend 25 USD has reached the limit 25",
    );
    await expect(handlerFor({ [NAMES[0]]: "1", [NAMES[1]]: "30.5" }).handler()).rejects.toThrow(
      "budget concordance-sandbox-models: spend 30.5 USD has reached the limit 25",
    );
  });

  it("throws when the store's estimate has reached the limit", async () => {
    await expect(handlerFor({ [NAMES[0]]: "1", [NAMES[1]]: "1" }, 26.4).handler()).rejects.toThrow(
      /estimate of the month's model spend, 26.40 USD, has reached the limit 25/,
    );
  });

  it("throws when a budget has no amounts", async () => {
    await expect(
      handlerFor({ [NAMES[0]]: { Budget: {} }, [NAMES[1]]: "1" }).handler(),
    ).rejects.toThrow(/no actual spend/);
  });

  it("throws without an account id or budget names", async () => {
    const handler = createHandler({
      describeBudget: async () => budget("b", "0", "1"),
      readEstimate: async () => 0,
      budgetNames: ["b"],
    });
    await expect(handler()).rejects.toThrow(/account id and budget names/);
  });
});
