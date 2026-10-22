// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTRACT_PROFILE, IngestStack } from "../../infra/lib/ingestStack.mjs";

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
    budgetNames: ["concordance-sandbox-monthly", "concordance-sandbox-models"],
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
    expect(definition.States.ListManifest.ResultPath).toBe("$.manifest");
    const map = definition.States.IngestDocuments;
    expect(map).toMatchObject({ Type: "Map", MaxConcurrency: 1, ItemsPath: "$.manifest.items" });
    expect(map.ItemSelector).toEqual({ "corpus.$": "$.corpus", "row.$": "$$.Map.Item.Value" });
    expect(map.ItemProcessor.StartAt).toBe("IngestDocument");
    expect(map.ItemProcessor.States.IngestDocument.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordFailure" },
    ]);
    expect(map.ItemProcessor.States.RecordFailure.Output.evidenceId).toBe(
      "{% $states.input.row.evidence_id %}",
    );
    const choice = map.ItemProcessor.States.DocumentComplete;
    expect(map.ItemProcessor.States.IngestDocument.ResultPath).toBe("$.result");
    expect(map.ItemProcessor.States.IngestDocument.Next).toBe("DocumentComplete");
    expect(choice.Choices).toEqual([
      { Variable: "$.result.status", StringEquals: "partial", Next: "IngestDocument" },
    ]);
    expect(choice.Default).toBe("DocumentResult");
    expect(map.Next).toBe("CheckBudgetBeforeExtraction");
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
    });
  });

  it("checks the budget again, then maps ExtractDocumentAssertions over the same rows on demand", () => {
    const check = definition.States.CheckBudgetBeforeExtraction;
    expect(check).toMatchObject({ Type: "Task", ResultPath: "$.extractionBudget" });
    expect(check.Next).toBe("StartExtractionBatch");
    expect(definition.States.StartExtractionBatch.Next).toBe("ExtractionMode");
    expect(definition.States.ExtractionMode.Default).toBe("ExtractAssertions");
    const map = definition.States.ExtractAssertions;
    expect(map).toMatchObject({
      Type: "Map",
      MaxConcurrency: 1,
      ItemsPath: "$.manifest.items",
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

  it("has seven Node 24 arm64 functions; the ingest one runs 15 minutes in 2048 MB", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function")).map(
      (f) => f.Properties,
    );
    expect(fns).toHaveLength(7);
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

  it("lets the budget function view both budgets", () => {
    expect(statements()).toContainEqual(
      expect.objectContaining({
        Action: "budgets:ViewBudget",
        Resource: [
          "arn:aws:budgets::111111111111:budget/concordance-sandbox-monthly",
          "arn:aws:budgets::111111111111:budget/concordance-sandbox-models",
        ],
      }),
    );
  });

  it("gives the budget function both budget names and the store environment", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          BUDGET_NAMES: "concordance-sandbox-monthly,concordance-sandbox-models",
          BUDGET_ACCOUNT_ID: "111111111111",
          DB_RESOURCE_ARN: CLUSTER,
          DB_SECRET_ARN: SECRET,
          DB_NAME: "concordance",
        },
      },
    });
  });

  it("lets the budget function read the store and keeps model invocation off it", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const budgetPolicy = policies.find((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes("budgets:ViewBudget"),
    );
    const actions = budgetPolicy.Properties.PolicyDocument.Statement.flatMap((st) =>
      [st.Action].flat(),
    );
    expect(actions).toContain("rds-data:ExecuteStatement");
    expect(actions).toContain("secretsmanager:GetSecretValue");
    expect(actions).not.toContain("bedrock:InvokeModel");
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
    expect(groups).toHaveLength(8);
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
        "StartExtractionBatchFunctionName",
        "LoadExtractionBatchFunctionName",
        "ExtractionBatchRoleArn",
      ]),
    );
  });

  it("starts a batch job, polls it every five minutes and maps the load over its documents", () => {
    const start = definition.States.StartExtractionBatch;
    expect(start).toMatchObject({ Type: "Task", ResultPath: "$.batch" });
    expect(start.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordBatchFailure" },
    ]);
    expect(definition.States.ExtractionMode.Choices).toEqual([
      { Variable: "$.batch.mode", StringEquals: "batch", Next: "WaitForExtractionBatch" },
    ]);
    expect(definition.States.WaitForExtractionBatch).toEqual({
      Type: "Wait",
      Seconds: 300,
      Next: "GetExtractionBatch",
    });
    const get = definition.States.GetExtractionBatch;
    expect(get.Retry).toContainEqual(
      expect.objectContaining({ ErrorEquals: ["ThrottlingException", "InternalServerException"] }),
    );
    expect(get.Parameters).toEqual({
      batch: { "jobArn.$": "$.batch.jobArn", "startedAt.$": "$.batch.startedAt" },
    });
    expect(get).toMatchObject({ ResultPath: "$.batchStatus", Next: "ExtractionBatchDone" });
    expect(get.Catch[0].Next).toBe("RecordBatchFailure");
    expect(definition.States.ExtractionBatchDone).toMatchObject({
      Choices: [
        { Variable: "$.batchStatus.done", BooleanEquals: true, Next: "LoadExtractionBatch" },
      ],
      Default: "WaitForExtractionBatch",
    });
    expect(definition.States.RecordBatchFailure.Next).toBe("ExtractionBatchFailed");
    const failure = definition.States.RecordBatchFailure.Output;
    expect(failure.jobArn).toBe(
      "{% $exists($states.input.batch.jobArn) ? $states.input.batch.jobArn : null %}",
    );
    expect(failure.error).toBe("{% $states.input.error.Error %}");
    expect(failure.cause).toBe("{% $substring($states.input.error.Cause, 0, 300) %}");
    expect(definition.States.ExtractionBatchFailed).toEqual({
      Type: "Fail",
      ErrorPath: "$.error",
      CausePath: "$.cause",
    });

    const map = definition.States.LoadExtractionBatch;
    expect(map).toMatchObject({
      Type: "Map",
      MaxConcurrency: 1,
      ItemsPath: "$.batch.documents",
      ResultPath: "$.extractions",
      Next: "Done",
    });
    expect(map.ItemSelector).toEqual({
      "corpus.$": "$.corpus",
      batch: {
        "jobArn.$": "$.batch.jobArn",
        "prefix.$": "$.batch.prefix",
        "replace.$": "$.batch.replace",
      },
      "document.$": "$$.Map.Item.Value",
    });
    const states = map.ItemProcessor.States;
    expect(map.ItemProcessor.StartAt).toBe("LoadDocumentAssertions");
    expect(states.LoadDocumentAssertions.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordBatchLoadFailure" },
    ]);
    expect(states.RecordBatchLoadFailure.Output.evidenceId).toBe(
      "{% $states.input.document.evidenceId %}",
    );
    expect(states.LoadComplete.Choices).toEqual([
      { Variable: "$.result.status", StringEquals: "partial", Next: "LoadDocumentAssertions" },
    ]);
    expect(definition.States.ExtractAssertions.Next).toBe("Done");
  });

  it("gives Bedrock a batch role scoped to this account's jobs, the batch prefix and the model", () => {
    const roles = Object.entries(template.findResources("AWS::IAM::Role")).filter(([, r]) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes("bedrock.amazonaws.com"),
    );
    expect(roles).toHaveLength(1);
    const [roleId, role] = roles[0];
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: "bedrock.amazonaws.com" },
        Condition: {
          StringEquals: { "aws:SourceAccount": "111111111111" },
          ArnLike: {
            "aws:SourceArn": "arn:aws:bedrock:eu-west-2:111111111111:model-invocation-job/*",
          },
        },
      },
    ]);
    const policy = Object.values(template.findResources("AWS::IAM::Policy")).find((p) =>
      p.Properties.Roles.some((r) => r.Ref === roleId),
    );
    const byAction = Object.fromEntries(
      policy.Properties.PolicyDocument.Statement.map((st) => [[st.Action].flat().join(","), st]),
    );
    expect(JSON.stringify(byAction["s3:GetObject,s3:PutObject"].Resource)).toContain(
      "/extraction-batch/*",
    );
    expect(byAction["bedrock:InvokeModel"].Resource).toEqual([
      `arn:aws:bedrock:eu-west-2:111111111111:inference-profile/${EXTRACT_PROFILE}`,
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
    ]);
  });

  it("lets the start function create the job and pass only the batch role to Bedrock", () => {
    const all = statements();
    expect(all).toContainEqual(
      expect.objectContaining({
        Action: "bedrock:CreateModelInvocationJob",
        Resource: [
          "arn:aws:bedrock:eu-west-2:111111111111:model-invocation-job/*",
          `arn:aws:bedrock:eu-west-2:111111111111:inference-profile/${EXTRACT_PROFILE}`,
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        ],
      }),
    );
    const pass = all.find((st) => st.Action === "iam:PassRole");
    expect(pass.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "bedrock.amazonaws.com" },
    });
    expect(pass.Resource["Fn::GetAtt"][1]).toBe("Arn");
    expect(all).toContainEqual(
      expect.objectContaining({
        Action: "bedrock:GetModelInvocationJob",
        Resource: "arn:aws:bedrock:eu-west-2:111111111111:model-invocation-job/*",
      }),
    );
    const listing = all.find((st) => st.Action === "s3:ListBucket" && st.Condition?.StringLike);
    expect(listing.Condition).toEqual({ StringLike: { "s3:prefix": ["extraction-batch/*"] } });
    const puts = all.filter((st) => st.Action === "s3:PutObject");
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0].Resource)).toContain("/extraction-batch/*");
  });

  it("runs the start and load functions on the extraction profile with the bucket and the role", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 300,
      MemorySize: 1024,
      Environment: {
        Variables: Match.objectLike({
          MODEL_PROVIDER: "bedrock",
          BEDROCK_EXTRACT_MODEL: EXTRACT_PROFILE,
          CORPUS_BUCKET: Match.anyValue(),
          BATCH_ROLE_ARN: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 900,
      MemorySize: 1024,
      Environment: {
        Variables: Match.objectLike({ BEDROCK_EXTRACT_MODEL: EXTRACT_PROFILE }),
      },
    });
  });
});
