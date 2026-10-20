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
    corpora: ["grenfell", "ucpi"],
  });
  template = Template.fromStack(stack);
  const [machine] = Object.values(template.findResources("AWS::StepFunctions::StateMachine"));
  const parts = machine.Properties.DefinitionString["Fn::Join"][1];
  definition = JSON.parse(parts.map((p) => (typeof p === "string" ? p : "ARN")).join(""));
}, 120_000);

const statements = () =>
  Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );

describe("IngestStack", () => {
  it("runs CheckBudget, ListManifest and a Map of IngestDocument one at a time", () => {
    expect(definition.StartAt).toBe("CheckBudget");
    expect(definition.States.CheckBudget.Next).toBe("ListManifest");
    expect(definition.States.ListManifest.Next).toBe("IngestDocuments");
    const map = definition.States.IngestDocuments;
    expect(map).toMatchObject({ Type: "Map", MaxConcurrency: 1, ItemsPath: "$.items" });
    expect(map.ItemSelector).toEqual({ "corpus.$": "$.corpus", "row.$": "$$.Map.Item.Value" });
    expect(map.ItemProcessor.StartAt).toBe("IngestDocument");
    expect(map.ItemProcessor.States.IngestDocument.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordFailure" },
    ]);
    expect(map.ItemProcessor.States.RecordFailure.Output.evidenceId).toBe(
      "{% $states.input.row.evidence_id %}",
    );
    expect(map.Next).toBe("CheckBudgetBeforeExtraction");
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
    });
  });

  it("checks the budget again, then maps ExtractDocumentAssertions over the same rows", () => {
    const check = definition.States.CheckBudgetBeforeExtraction;
    expect(check).toMatchObject({ Type: "Task", ResultPath: "$.extractionBudget" });
    expect(check.Next).toBe("ExtractAssertions");
    const map = definition.States.ExtractAssertions;
    expect(map).toMatchObject({
      Type: "Map",
      MaxConcurrency: 1,
      ItemsPath: "$.items",
      ResultPath: "$.extractions",
    });
    expect(map.ItemSelector).toEqual({ "corpus.$": "$.corpus", "row.$": "$$.Map.Item.Value" });
    const task = map.ItemProcessor.States.ExtractDocumentAssertions;
    expect(map.ItemProcessor.StartAt).toBe("ExtractDocumentAssertions");
    expect(task.Retry).toContainEqual(
      expect.objectContaining({
        ErrorEquals: ["ThrottlingException"],
        IntervalSeconds: 30,
        MaxAttempts: 2,
        BackoffRate: 2,
      }),
    );
    expect(task.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordExtractionFailure" },
    ]);
    expect(map.ItemProcessor.States.RecordExtractionFailure.Output.evidenceId).toBe(
      "{% $states.input.row.evidence_id %}",
    );
    expect(definition.States[map.Next].Type).toBe("Succeed");
  });

  it("has four Node 24 arm64 functions; the ingest one runs 15 minutes in 2048 MB", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function")).map(
      (f) => f.Properties,
    );
    expect(fns).toHaveLength(4);
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

  it("runs the extraction function 15 minutes in 512 MB with the store and Bedrock", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Timeout: 900,
      MemorySize: 512,
      Environment: {
        Variables: {
          MODEL_PROVIDER: "bedrock",
          DB_RESOURCE_ARN: CLUSTER,
          DB_SECRET_ARN: SECRET,
          DB_NAME: "concordance",
        },
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

  it("lets the manifest and ingest functions read every corpus's objects in the bucket", () => {
    const resources = statements()
      .filter((st) => [st.Action].flat().includes("s3:GetObject"))
      .flatMap((st) => [st.Resource].flat())
      .map((r) => JSON.stringify(r));
    for (const corpus of ["grenfell", "ucpi"]) {
      expect(
        resources.some((r) => r.includes(`/${corpus}/*`)),
        corpus,
      ).toBe(true);
    }
  });

  it("grants the Data API, the secret and Bedrock to the ingest and extraction functions", () => {
    const fnRole = (memory) => {
      const [fn] = Object.values(template.findResources("AWS::Lambda::Function")).filter(
        (f) => f.Properties.MemorySize === memory,
      );
      return fn.Properties.Role["Fn::GetAtt"][0];
    };
    const policyFor = (role) =>
      Object.values(template.findResources("AWS::IAM::Policy"))
        .filter((p) => p.Properties.Roles.some((r) => r.Ref === role))
        .flatMap((p) => p.Properties.PolicyDocument.Statement);
    for (const memory of [2048, 512]) {
      const actions = policyFor(fnRole(memory)).flatMap((st) => [st.Action].flat());
      expect(actions).toEqual(
        expect.arrayContaining([
          "rds-data:ExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
          "secretsmanager:GetSecretValue",
          "bedrock:InvokeModel",
        ]),
      );
    }
    expect(
      policyFor(fnRole(512))
        .flatMap((st) => [st.Action].flat())
        .some((a) => a.startsWith("s3:")),
    ).toBe(false);
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
    expect(groups).toHaveLength(5);
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
        "ExtractAssertionsFunctionName",
      ]),
    );
  });
});
