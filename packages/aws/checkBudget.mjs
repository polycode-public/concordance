// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The first state of the ingest state machine: a throw when the month's spend has reached the
// budget limit, so the execution fails before any model call.

/**
 * @param {{ describeBudget: (input: { AccountId: string, BudgetName: string }) => Promise<object>,
 *   accountId: string, budgetName: string }} deps
 */
export function createHandler({ describeBudget, accountId, budgetName }) {
  return async () => {
    if (!accountId || !budgetName) throw new Error("the account id and budget name are required");
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
    return { actual, limit, unit };
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
});
