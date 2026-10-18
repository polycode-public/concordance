// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// Ingest on AWS: a Standard state machine that reads the budget, lists a corpus manifest from
// the corpus bucket and maps over its rows, at most four documents at once. Each row is one
// Lambda run that extracts the PDF text with pdf.js, calls Bedrock and writes to Aurora over
// the Data API. A failed document is recorded in the result and the map goes on. Nothing runs
// or costs money until an execution starts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AWS_DIR = path.join(ROOT, "packages", "aws");

export const MAX_CONCURRENT_DOCUMENTS = 4;

// The bundle is ESM; pg and other CommonJS dependencies call require().
const REQUIRE_BANNER =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

export class IngestStack extends Stack {
  /**
   * @param {import('constructs').Construct} scope
   * @param {string} id
   * @param {import('aws-cdk-lib').StackProps & { corpusBucket: import('aws-cdk-lib/aws-s3').IBucket,
   *   dbResourceArn: string, dbSecretArn: string, dbName: string, budgetName: string,
   *   corpora?: string[] }} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    const {
      corpusBucket,
      dbResourceArn,
      dbSecretArn,
      dbName,
      budgetName,
      corpora = ["grenfell"],
    } = props;
    if (!corpusBucket || !dbResourceArn || !dbSecretArn || !dbName || !budgetName) {
      throw new Error(
        "IngestStack needs corpusBucket, dbResourceArn, dbSecretArn, dbName and budgetName",
      );
    }

    const fn = (name, { timeout = Duration.seconds(30), memorySize = 256, environment }) =>
      new NodejsFunction(this, `${name[0].toUpperCase()}${name.slice(1)}Function`, {
        entry: path.join(AWS_DIR, `${name}.mjs`),
        handler: "handler",
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout,
        memorySize,
        environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: OutputFormat.ESM,
          target: "node24",
          banner: REQUIRE_BANNER,
          minify: true,
          sourceMap: true,
          externalModules: ["@aws-sdk/*", "pg-native"],
        },
      });

    const checkBudgetFn = fn("checkBudget", {
      environment: { BUDGET_NAME: budgetName, BUDGET_ACCOUNT_ID: this.account },
    });
    const listManifestFn = fn("listManifest", {
      environment: { CORPUS_BUCKET: corpusBucket.bucketName },
    });
    const ingestDocumentFn = fn("ingestDocument", {
      timeout: Duration.minutes(15),
      memorySize: 2048,
      environment: {
        MODEL_PROVIDER: "bedrock",
        DB_RESOURCE_ARN: dbResourceArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
        CORPUS_BUCKET: corpusBucket.bucketName,
      },
    });

    checkBudgetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["budgets:ViewBudget"],
        resources: [`arn:aws:budgets::${this.account}:budget/${budgetName}`],
      }),
    );
    for (const f of [listManifestFn, ingestDocumentFn]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject"],
          resources: corpora.map((corpus) => corpusBucket.arnForObjects(`${corpus}/*`)),
        }),
      );
      // Without ListBucket a missing key answers AccessDenied, not NoSuchKey.
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: [corpusBucket.bucketArn],
        }),
      );
    }
    ingestDocumentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ],
        resources: [dbResourceArn],
      }),
    );
    ingestDocumentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [dbSecretArn],
      }),
    );
    ingestDocumentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );

    const checkBudget = new tasks.LambdaInvoke(this, "CheckBudget", {
      lambdaFunction: checkBudgetFn,
      payloadResponseOnly: true,
      resultPath: "$.budget",
    });
    const listManifest = new tasks.LambdaInvoke(this, "ListManifest", {
      lambdaFunction: listManifestFn,
      payload: sfn.TaskInput.fromObject({ corpus: sfn.JsonPath.stringAt("$.corpus") }),
      payloadResponseOnly: true,
    });

    const ingestDocument = new tasks.LambdaInvoke(this, "IngestDocument", {
      lambdaFunction: ingestDocumentFn,
      payloadResponseOnly: true,
    });
    ingestDocument.addRetry({
      errors: ["ThrottlingException"],
      interval: Duration.seconds(30),
      maxAttempts: 2,
      backoffRate: 2,
    });
    // The cause holds the stack trace; the state keeps a bounded part of it.
    const recordFailure = sfn.Pass.jsonata(this, "RecordFailure", {
      outputs: {
        evidenceId: "{% $states.input.row.evidence_id %}",
        error: "{% $states.input.error.Error %}",
        cause: "{% $substring($states.input.error.Cause, 0, 300) %}",
      },
    });
    ingestDocument.addCatch(recordFailure, { resultPath: "$.error" });

    const documents = new sfn.Map(this, "IngestDocuments", {
      itemsPath: "$.items",
      maxConcurrency: MAX_CONCURRENT_DOCUMENTS,
      itemSelector: {
        corpus: sfn.JsonPath.stringAt("$.corpus"),
        row: sfn.JsonPath.objectAt("$$.Map.Item.Value"),
      },
      resultPath: "$.results",
    });
    documents.itemProcessor(ingestDocument);

    const definition = checkBudget
      .next(listManifest)
      .next(documents)
      .next(new sfn.Succeed(this, "Done"));

    this.stateMachine = new sfn.StateMachine(this, "IngestStateMachine", {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      logs: {
        destination: new logs.LogGroup(this, "IngestStateMachineLogs", {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: false,
      },
    });
    this.stateMachine.applyRemovalPolicy(RemovalPolicy.DESTROY);

    new CfnOutput(this, "StateMachineArn", { value: this.stateMachine.stateMachineArn });
    new CfnOutput(this, "CheckBudgetFunctionName", { value: checkBudgetFn.functionName });
    new CfnOutput(this, "ListManifestFunctionName", { value: listManifestFn.functionName });
    new CfnOutput(this, "IngestDocumentFunctionName", { value: ingestDocumentFn.functionName });
  }
}
