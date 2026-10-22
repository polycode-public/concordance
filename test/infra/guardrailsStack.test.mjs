// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  GuardrailsStack,
  MODEL_SERVICES,
  budgetNamesFor,
} from "../../infra/lib/guardrailsStack.mjs";

const env = { account: "111111111111", region: "eu-west-2" };
let budgets;
beforeAll(() => {
  const app = new App();
  const stack = new GuardrailsStack(app, "Guardrails", {
    env,
    envName: "sandbox",
    project: "concordance",
    budgetEmail: "ops@example.com",
  });
  budgets = Object.values(Template.fromStack(stack).findResources("AWS::Budgets::Budget")).map(
    (r) => r.Properties,
  );
}, 120_000);

const named = (name) => budgets.find((b) => b.Budget.BudgetName === name);

describe("GuardrailsStack", () => {
  it("names the two budgets the ingest guard reads", () => {
    const names = budgetNamesFor({ project: "concordance", envName: "sandbox" });
    expect(names).toEqual(["concordance-sandbox-monthly", "concordance-sandbox-models"]);
    expect(budgets.map((b) => b.Budget.BudgetName).sort()).toEqual([...names].sort());
  });

  it("filters the first budget on the project tag", () => {
    expect(named("concordance-sandbox-monthly").Budget.CostFilters).toEqual({
      TagKeyValue: ["user:project$concordance"],
    });
  });

  it("filters the models budget on the Bedrock services alone", () => {
    const { Budget } = named("concordance-sandbox-models");
    expect(Budget.CostFilters).toEqual({ Service: [...MODEL_SERVICES] });
    expect(MODEL_SERVICES).toContain("Amazon Bedrock");
  });

  it("gives both budgets the same limit and the same email subscriber at 80 and 100 percent", () => {
    for (const b of budgets) {
      expect(b.Budget.BudgetLimit).toEqual({ Amount: 175, Unit: "USD" });
      expect(
        b.NotificationsWithSubscribers.map((n) => [
          n.Notification.Threshold,
          n.Subscribers[0].Address,
        ]),
      ).toEqual([
        [80, "ops@example.com"],
        [100, "ops@example.com"],
      ]);
    }
  });
});
