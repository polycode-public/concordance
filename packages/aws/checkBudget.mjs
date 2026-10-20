// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The first state of the ingest state machine: a throw when the month's spend has reached the
// limit, so the execution fails before any model call. Two readings stop it. The budgets'
// actual spend lags Cost Explorer by about a day. The store's estimate prices the tokens of
// every turn, report and run at the list prices, and has no lag.

/**
 * @param {{ describeBudget: (input: { AccountId: string, BudgetName: string }) => Promise<object>,
 *   readEstimate: () => Promise<number>, accountId: string, budgetNames: string[] }} deps
 */
export function createHandler({ describeBudget, readEstimate, accountId, budgetNames }) {
  return async () => {
    if (!accountId || !budgetNames?.length) {
      throw new Error("the account id and budget names are required");
    }
    const readings = [];
    for (const budgetName of budgetNames) {
      const { Budget } = await describeBudget({ AccountId: accountId, BudgetName: budgetName });
      const actual = Number(Budget?.CalculatedSpend?.ActualSpend?.Amount);
      const limit = Number(Budget?.BudgetLimit?.Amount);
      if (!Number.isFinite(actual) || !Number.isFinite(limit)) {
        throw new Error(`budget ${budgetName} has no actual spend or limit amount`);
      }
      const unit = Budget.BudgetLimit.Unit ?? "USD";
      if (actual >= limit) {
        throw new Error(
          `budget ${budgetName}: spend ${actual} ${unit} has reached the limit ${limit}`,
        );
      }
      readings.push({ actual, limit, unit });
    }
    const worst = readings.reduce((a, b) => (b.actual / b.limit > a.actual / a.limit ? b : a));
    const estimate = await readEstimate();
    if (estimate >= worst.limit) {
      throw new Error(
        `the store's estimate of the month's model spend, ${estimate.toFixed(2)} ${worst.unit}, has reached the limit ${worst.limit}`,
      );
    }
    return { ...worst, estimate };
  };
}

let client;
export const handler = createHandler({
  describeBudget: async (input) => {
    const sdk = await import("@aws-sdk/client-budgets");
    client ??= new sdk.BudgetsClient({});
    return client.send(new sdk.DescribeBudgetCommand(input));
  },
  readEstimate: async () => {
    const db = await (await import("../core/db.mjs")).openDbFromEnv();
    try {
      return await (await import("../core/spend.mjs")).readMonthEstimate(db);
    } finally {
      await db.close();
    }
  },
  accountId: process.env.BUDGET_ACCOUNT_ID,
  budgetNames: (process.env.BUDGET_NAMES ?? "").split(",").filter(Boolean),
});
