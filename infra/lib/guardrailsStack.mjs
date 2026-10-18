// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The project's own guardrails, inside the account's guardrails (the management account's
// polycode-sandbox-daily alert and polycode-sandbox-monthly-cap freeze):
//
// - A monthly cost budget for the resources tagged project=<project>. The tag filter reads
//   only what Cost Explorer knows as a cost allocation tag, so the operator activates the
//   `project` tag in the management account first (AWS_ACCOUNT.md, operator steps).
// - The agent kill switch, /<project>/<env>/agents/kill-switch. Every agent workflow reads it
//   through .github/actions/agent-kill-switch and stops when it is on. This stack creates it
//   with the value off; agent-kill-switch.yml only overwrites it.

import { CfnOutput, Stack } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ssm from "aws-cdk-lib/aws-ssm";

const MONTHLY_LIMIT_USD = 25;
const ALERT_PERCENTAGES = [80, 100];

export class GuardrailsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { envName, project, budgetEmail } = props;
    if (!envName || !project || !budgetEmail) {
      throw new Error("GuardrailsStack needs envName, project and budgetEmail");
    }

    const budgetName = `${project}-${envName}-monthly`;
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: MONTHLY_LIMIT_USD, unit: "USD" },
        costFilters: { TagKeyValue: [`user:project$${project}`] },
      },
      notificationsWithSubscribers: ALERT_PERCENTAGES.map((threshold) => ({
        notification: {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          threshold,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }],
      })),
    });

    this.killSwitch = new ssm.StringParameter(this, "AgentKillSwitch", {
      parameterName: `/${project}/${envName}/agents/kill-switch`,
      stringValue: "off",
      description: "on stops every unattended agent workflow; set by agent-kill-switch.yml",
    });

    new CfnOutput(this, "BudgetName", { value: budgetName });
    new CfnOutput(this, "AgentKillSwitchParameter", { value: this.killSwitch.parameterName });
  }
}
