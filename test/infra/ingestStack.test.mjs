// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { IngestStack } from "../../infra/lib/ingestStack.mjs";

const env = { account: "111111111111", region: "eu-west-2" };
const CLUSTER = "arn:aws:rds:eu-west-2:111111111111:cluster:concordance";
const SECRET = "arn:aws:secretsmanager:eu-west-2:111111111111:secret:concordance-db-AbCdEf";

let template;
let definition;
beforeAll(() => {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const data = new Stack(app, "Data", { env });
  const corpusBucket = new s3.Bucket(data, "CorpusBucket");
  const stack = new IngestStack(app, "Ingest", {
    env,
    corpusBucket,
    dbResourceArn: CLUSTER,
    dbSecretArn: SECRET,
    dbName: "concordance",
    budgetName: "concordance-sandbox-monthly",
  });
  template = Template.fromStack(stack);
  const [machine] = Object.values(template.findResources("AWS::StepFunctions::StateMachine"));
  const parts = machine.Properties.DefinitionString["Fn::Join"][1];
  definition = JSON.parse(parts.map((p) => (typeof p === "string" ? p : "ARN")).join(""));
});

const statements = () =>
  Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );

describe("IngestStack", () => {
  it("runs CheckBudget, ListManifest and a Map of IngestDocument at most four at once", () => {
    expect(definition.StartAt).toBe("CheckBudget");
    expect(definition.States.CheckBudget.Next).toBe("ListManifest");
    expect(definition.States.ListManifest.Next).toBe("IngestDocuments");
    const map = definition.States.IngestDocuments;
    expect(map).toMatchObject({ Type: "Map", MaxConcurrency: 4, ItemsPath: "$.items" });
    expect(map.ItemSelector).toEqual({ "corpus.$": "$.corpus", "row.$": "$$.Map.Item.Value" });
    expect(map.ItemProcessor.StartAt).toBe("IngestDocument");
    expect(map.ItemProcessor.States.IngestDocument.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordFailure" },
    ]);
    expect(map.ItemProcessor.States.RecordFailure.Output.evidenceId).toBe(
      "{% $states.input.row.evidence_id %}",
    );
    expect(definition.States[map.Next].Type).toBe("Succeed");
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
    });
  });

  it("has three Node 24 arm64 functions; the ingest one runs 15 minutes in 2048 MB", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function")).map(
      (f) => f.Properties,
    );
    expect(fns).toHaveLength(3);
    for (const f of fns) {
      expect(f.Runtime).toBe("nodejs24.x");
      expect(f.Architectures).toEqual(["arm64"]);
    }
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 900,
      MemorySize: 2048,
      Environment: {
        Variables: Match.objectLike({
          MODEL_PROVIDER: "bedrock",
          DB_RESOURCE_ARN: CLUSTER,
          DB_SECRET_ARN: SECRET,
          DB_NAME: "concordance",
        }),
      },
    });
  });

  it("lets the budget function view the one budget", () => {
    expect(statements()).toContainEqual(
      expect.objectContaining({
        Action: "budgets:ViewBudget",
        Resource: "arn:aws:budgets::111111111111:budget/concordance-sandbox-monthly",
      }),
    );
  });

  it("grants the Data API, the secret and Bedrock to the ingest function", () => {
    const all = statements();
    expect(all).toContainEqual(
      expect.objectContaining({
        Action: expect.arrayContaining(["rds-data:ExecuteStatement", "rds-data:BeginTransaction"]),
        Resource: CLUSTER,
      }),
    );
    expect(all).toContainEqual(
      expect.objectContaining({ Action: "secretsmanager:GetSecretValue", Resource: SECRET }),
    );
    expect(all).toContainEqual(
      expect.objectContaining({
        Action: "bedrock:InvokeModel",
        Resource: [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:eu-west-2:111111111111:inference-profile/*",
        ],
      }),
    );
  });

  it("keeps logs for one month and outputs the state machine and function names", () => {
    const groups = Object.values(template.findResources("AWS::Logs::LogGroup"));
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(g.Properties.RetentionInDays).toBe(30);
      expect(g.DeletionPolicy).toBe("Delete");
    }
    const outputs = Object.keys(template.findOutputs("*"));
    expect(outputs).toEqual(
      expect.arrayContaining([
        "StateMachineArn",
        "CheckBudgetFunctionName",
        "ListManifestFunctionName",
        "IngestDocumentFunctionName",
      ]),
    );
  });
});
