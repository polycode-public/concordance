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

describe("spend history route", () => {
  const SONNET = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const historyFor = (rows, fail) => {
    const db = {
      calls: [],
      closed: 0,
      query: async (text, params) => {
        db.calls.push({ text, params });
        if (fail) throw new Error(fail);
        return { rows };
      },
      close: async () => {
        db.closed += 1;
      },
    };
    const { handler, calls } = handlerFor(async () => ({}), { openDb: async () => db });
    return { handler, calls, db };
  };
  const get = (handler, days) =>
    handler({
      rawPath: "/spend/history",
      routeKey: "GET /spend/history",
      queryStringParameters: days === undefined ? undefined : { days },
    });

  it("answers the store's tokens by corpus and day at list prices, without the budget", async () => {
    const { handler, calls, db } = historyFor([
      {
        corpus: "grenfell",
        day: "2026-10-19",
        model: SONNET,
        source: "turn",
        requests: 1,
        input_tokens: 1_000_000,
        output_tokens: 0,
      },
      {
        corpus: "ucpi",
        day: "2026-10-18",
        model: SONNET,
        source: "report",
        requests: 1,
        input_tokens: 0,
        output_tokens: 1_000_000,
      },
    ]);
    const res = await get(handler, "2");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res.body);
    expect(body.days).toEqual(["2026-10-18", "2026-10-19"]);
    expect(body.series.map((s) => [s.corpus, s.points.map((p) => p.cost)])).toEqual([
      ["grenfell", [0, 3]],
      ["ucpi", [15, 0]],
    ]);
    expect(db.calls[0].params).toEqual([2]);
    expect(db.closed).toBe(1);
    expect(calls).toEqual([]);
  });

  it("defaults to 30 days, answers 400 to a bad count and 500 when the store fails", async () => {
    const { handler, db } = historyFor([]);
    expect(JSON.parse((await get(handler)).body).days).toHaveLength(30);
    expect((await get(handler, "0")).statusCode).toBe(400);
    expect(db.calls).toHaveLength(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = historyFor([], "paused");
    const res = await get(failing.handler, "7");
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).message).toMatch(/paused/);
    expect(failing.db.closed).toBe(1);
  });
});
