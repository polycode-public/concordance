// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../../packages/aws/spend.mjs";

const NOW = new Date("2026-10-19T09:30:00.000Z");

const handlerFor = (describeBudget, overrides = {}) => {
  const calls = [];
  const handler = createHandler({
    describeBudget: async (input) => {
      calls.push(input);
      return describeBudget(input);
    },
    accountId: "111111111111",
    budgetName: "concordance-sandbox-monthly",
    now: () => NOW,
    ...overrides,
  });
  return { handler, calls };
};

describe("spend handler", () => {
  it("answers the spend, the limit, the unit and the time of the read", async () => {
    const { handler, calls } = handlerFor(async () => ({
      Budget: {
        BudgetLimit: { Amount: "25.0", Unit: "USD" },
        CalculatedSpend: { ActualSpend: { Amount: "3.42", Unit: "USD" } },
      },
    }));
    const res = await handler({});
    expect(calls).toEqual([
      { AccountId: "111111111111", BudgetName: "concordance-sandbox-monthly" },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({
      actual: 3.42,
      limit: 25,
      unit: "USD",
      asOf: "2026-10-19T09:30:00.000Z",
    });
  });

  it("answers 500 with a message when the call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = handlerFor(async () => {
      throw new Error("AccessDeniedException");
    });
    const res = await handler({});
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).message).toMatch(/AccessDeniedException/);
  });

  it("answers 500 when the budget has no amounts or the names are missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const empty = handlerFor(async () => ({ Budget: {} }));
    expect((await empty.handler({})).statusCode).toBe(500);
    const unnamed = handlerFor(async () => ({}), { budgetName: undefined });
    const res = await unnamed.handler({});
    expect(res.statusCode).toBe(500);
    expect(unnamed.calls).toEqual([]);
  });
});
