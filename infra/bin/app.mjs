#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The CDK app. One account today (polycode-sandbox, 687443513271), workloads in eu-west-2.
// Context (same shape as the-mechanical-code-talker's app):
//   -c env=<name>       default sandbox; every stack is named concordance-<env>-<name>
//   -c account=<id>     default CDK_DEFAULT_ACCOUNT (the credentials in use)
//   -c region=<region>  default eu-west-2
// The account record is AWS_ACCOUNT.md.

import { App, Tags } from "aws-cdk-lib";
import { DataStack } from "../lib/dataStack.mjs";
import { GuardrailsStack } from "../lib/guardrailsStack.mjs";

export const WORKLOAD_REGION = "eu-west-2";
export const PROJECT = "concordance";
export const BUDGET_EMAIL = "polycodelimited+aws-polycode-sandbox@gmail.com";

const app = new App();
const envName = app.node.tryGetContext("env") ?? "sandbox";
const account = app.node.tryGetContext("account") ?? process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext("region") ?? WORKLOAD_REGION;
const env = { account, region };
const stackName = (name) => `${PROJECT}-${envName}-${name}`;

new DataStack(app, stackName("data"), {
  env,
  description: `${PROJECT} ${envName}: the private bucket for off-site copies of corpus files`,
});

new GuardrailsStack(app, stackName("guardrails"), {
  env,
  envName,
  project: PROJECT,
  budgetEmail: BUDGET_EMAIL,
  description: `${PROJECT} ${envName}: the project cost budget and the agent kill switch`,
});

Tags.of(app).add("project", PROJECT);
Tags.of(app).add("env", envName);

app.synth();
