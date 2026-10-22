#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The CDK app. One account today (polycode-sandbox, 687443513271), workloads in eu-west-2.
// Context (same shape as the-mechanical-code-talker's app):
//   -c env=<name>       default sandbox; every stack is named concordance-<env>-<name>
//   -c account=<id>     default CDK_DEFAULT_ACCOUNT (the credentials in use)
//   -c region=<region>  default eu-west-2
//   -c domainName=<host> -c certificateArn=<arn>
//                       optional, together: the site's own name and its us-east-1 certificate
//   -c corpora=<json>   optional: the page's drop list, [{"id":"grenfell","name":"..."}, ...]
// The account record is AWS_ACCOUNT.md.

import { App, Tags } from "aws-cdk-lib";
import { DataStack } from "../lib/dataStack.mjs";
import { GuardrailsStack, budgetNamesFor } from "../lib/guardrailsStack.mjs";
import { StoreStack } from "../lib/storeStack.mjs";
import { AppStack, DEFAULT_CORPORA } from "../lib/appStack.mjs";
import { IngestStack } from "../lib/ingestStack.mjs";
import { ModelProfilesStack } from "../lib/modelProfilesStack.mjs";

export const WORKLOAD_REGION = "eu-west-2";
export const PROJECT = "concordance";
export const BUDGET_EMAIL = "polycodelimited+aws-polycode-sandbox@gmail.com";

const app = new App();
const envName = app.node.tryGetContext("env") ?? "sandbox";
const account = app.node.tryGetContext("account") ?? process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext("region") ?? WORKLOAD_REGION;
const env = { account, region };
// An empty value counts as absent, so the deploy can pass unset repository variables through.
const optionalContext = (key) => app.node.tryGetContext(key) || undefined;
// A value from the command line is a JSON string; one from cdk.json is already parsed.
const corporaContext = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const stackName = (name) => `${PROJECT}-${envName}-${name}`;

const dataStack = new DataStack(app, stackName("data"), {
  env,
  description: `${PROJECT} ${envName}: the private bucket for off-site copies of corpus files`,
});

const storeStack = new StoreStack(app, stackName("store"), {
  env,
  description: `${PROJECT} ${envName}: the Aurora Serverless v2 Postgres store behind the RDS Data API`,
});

const modelProfilesStack = new ModelProfilesStack(app, stackName("model-profiles"), {
  env,
  envName,
  project: PROJECT,
  description: `${PROJECT} ${envName}: one tagged Bedrock application inference profile per model`,
});

const corpora = corporaContext(optionalContext("corpora")) ?? DEFAULT_CORPORA;

const appStack = new AppStack(app, stackName("app"), {
  env,
  corpusBucket: dataStack.bucket,
  dbResourceArn: storeStack.cluster.clusterArn,
  dbSecretArn: storeStack.secret.secretArn,
  dbName: "concordance",
  budgetNames: budgetNamesFor({ project: PROJECT, envName }),
  modelProfiles: modelProfilesStack,
  corpora,
  domainName: optionalContext("domainName"),
  certificateArn: optionalContext("certificateArn"),
  description: `${PROJECT} ${envName}: the chat WebSocket, the document route and the page on CloudFront`,
});

const ingestStack = new IngestStack(app, stackName("ingest"), {
  env,
  corpusBucket: dataStack.bucket,
  corpora: corpora.map((corpus) => corpus.id),
  dbResourceArn: storeStack.cluster.clusterArn,
  dbSecretArn: storeStack.secret.secretArn,
  dbName: "concordance",
  budgetNames: budgetNamesFor({ project: PROJECT, envName }),
  modelProfiles: modelProfilesStack,
  description: `${PROJECT} ${envName}: the ingest state machine over a corpus manifest, one Lambda per document`,
});

const guardrailsStack = new GuardrailsStack(app, stackName("guardrails"), {
  env,
  envName,
  project: PROJECT,
  budgetEmail: BUDGET_EMAIL,
  description: `${PROJECT} ${envName}: the project cost budget and the agent kill switch`,
});
appStack.addDependency(guardrailsStack);
ingestStack.addDependency(guardrailsStack);

Tags.of(app).add("project", PROJECT);
Tags.of(app).add("env", envName);

app.synth();
