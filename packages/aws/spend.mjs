// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// GET /spend on the HTTP API: the project budget's month-to-date spend and its limit, for the
// spend strip under the page header. AWS refreshes a budget's spend up to three times a day,
// so one DescribeBudget call per page load is enough; the call is free. GET /spend/history: the
// store's model use by corpus and day at list prices, an estimate the budget cannot split.

import { SpendInputError, historyDays, readSpendHistory } from "../core/spend.mjs";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/**
 * @param {{ describeBudget: (input: { AccountId: string, BudgetName: string }) => Promise<object>,
 *   accountId: string, budgetName: string,
 *   openDb: () => Promise<{ query: Function, close?: Function }>, now?: () => Date }} deps
 */
export function createHandler({
  describeBudget,
  accountId,
  budgetName,
  openDb,
  now = () => new Date(),
}) {
  async function history(event) {
    let days;
    try {
      days = historyDays(event.queryStringParameters?.days);
    } catch (err) {
      if (err instanceof SpendInputError) return json(400, { message: err.message });
      throw err;
    }
    let db;
    try {
      db = await openDb();
      return json(200, await readSpendHistory(db, { days, today: now() }));
    } catch (err) {
      console.error("spend: the history read failed", err);
      return json(500, { message: `The spend history could not be read: ${err.message}` });
    } finally {
      await db?.close?.();
    }
  }

  return async (event = {}) => {
    const path = event.rawPath ?? event.routeKey?.split(" ")[1] ?? "/spend";
    if (path.replace(/\/+$/, "") === "/spend/history") return history(event);
    try {
      if (!accountId || !budgetName) throw new Error("the account id and budget name are required");
      const { Budget } = await describeBudget({ AccountId: accountId, BudgetName: budgetName });
      const actual = Number(Budget?.CalculatedSpend?.ActualSpend?.Amount);
      const limit = Number(Budget?.BudgetLimit?.Amount);
      if (!Number.isFinite(actual) || !Number.isFinite(limit)) {
        throw new Error(`budget ${budgetName} has no actual spend or limit amount`);
      }
      const unit = Budget.BudgetLimit.Unit;
      if (!unit) throw new Error(`budget ${budgetName} has no limit unit`);
      return json(200, { actual, limit, unit, asOf: now().toISOString() });
    } catch (err) {
      console.error("spend: DescribeBudget failed", err);
      return json(500, { message: `The spend could not be read: ${err.message}` });
    }
  };
}

let client;
export const handler = createHandler({
  describeBudget: async (input) => {
    const sdk = await import("@aws-sdk/client-budgets");
    client ??= new sdk.BudgetsClient({});
    return client.send(new sdk.DescribeBudgetCommand(input));
  },
  accountId: process.env.BUDGET_ACCOUNT_ID,
  budgetName: process.env.BUDGET_NAME,
  openDb: async () => (await import("./clients.mjs")).openDatabase(),
});
