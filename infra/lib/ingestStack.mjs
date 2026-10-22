// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// Ingest on AWS: a Standard state machine that reads the budget, lists a corpus manifest from
// the corpus bucket and maps over its rows one document at a time. Each row is one Lambda run
// that extracts the PDF text with pdf.js, calls Bedrock and writes to Aurora over the Data API.
// A second map, after a second budget check, runs assertion extraction over the same rows, one
// Lambda run a document. A failed document is recorded in the result and the map goes on. A
// document whose context lines outlast one run is invoked again until it finishes.
//
// The extraction runs in one of two modes. A run whose input says "extraction": "batch" (the
// Bedrock minimum is 100 records, one a window of ten sentences) writes one JSONL file a document under the corpus bucket's batch prefix and starts a Bedrock
// batch inference job, which bills half the on-demand price. The state machine polls the job,
// then maps a load over the documents through the same checks and writer as the on-demand path.
// Any other run maps the on-demand extraction over the rows. A job that fails, or outlasts its deadline, ends the execution failed.
// Nothing runs or costs money until an execution starts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { EXTRACTION_BATCH_PREFIX } from "./dataStack.mjs";
import {
  EXTRACT_MODEL,
  profileEnvironment,
  profileInvokeResources,
} from "./modelProfilesStack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AWS_DIR = path.join(ROOT, "packages", "aws");

export const MAX_CONCURRENT_DOCUMENTS = 1;
/** The wait between two status polls of the batch job. */
export const BATCH_POLL_INTERVAL = Duration.minutes(5);

// The bundle is ESM; pg and other CommonJS dependencies call require().
const REQUIRE_BANNER =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

export class IngestStack extends Stack {
  /**
   * @param {import('constructs').Construct} scope
   * @param {string} id
   * @param {import('aws-cdk-lib').StackProps & { corpusBucket: import('aws-cdk-lib/aws-s3').IBucket,
   *   dbResourceArn: string, dbSecretArn: string, dbName: string, budgetNames: string[],
   *   modelProfiles: import('./modelProfilesStack.mjs').ModelProfilesStack,
   *   corpora?: string[] }} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    const {
      corpusBucket,
      dbResourceArn,
      dbSecretArn,
      dbName,
      budgetNames,
      modelProfiles,
      corpora = ["grenfell"],
    } = props;
    if (!modelProfiles?.extract?.arn) {
      throw new Error("IngestStack needs the modelProfiles of the ModelProfilesStack");
    }
    if (!corpusBucket || !dbResourceArn || !dbSecretArn || !dbName || !budgetNames?.length) {
      throw new Error(
        "IngestStack needs corpusBucket, dbResourceArn, dbSecretArn, dbName and budgetNames",
      );
    }

    const allModels = { chat: true, extract: true, embed: true };
    const modelEnv = profileEnvironment(modelProfiles, allModels);
    const invokeResources = profileInvokeResources(this, modelProfiles, allModels);
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
      environment: {
        BUDGET_NAMES: budgetNames.join(","),
        BUDGET_ACCOUNT_ID: this.account,
        DB_RESOURCE_ARN: dbResourceArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      },
    });
    const listManifestFn = fn("listManifest", {
      environment: { CORPUS_BUCKET: corpusBucket.bucketName },
    });
    const ingestDocumentFn = fn("ingestDocument", {
      timeout: Duration.minutes(15),
      memorySize: 2048,
      environment: {
        MODEL_PROVIDER: "bedrock",
        ...modelEnv,
        DB_RESOURCE_ARN: dbResourceArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
        CORPUS_BUCKET: corpusBucket.bucketName,
      },
    });

    const extractAssertionsFn = fn("extractAssertions", {
      timeout: Duration.minutes(15),
      memorySize: 512,
      environment: {
        MODEL_PROVIDER: "bedrock",
        ...modelEnv,
        DB_RESOURCE_ARN: dbResourceArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      },
    });

    // The batch job and its service role call through the tagged extract profile.
    const extractModelArns = profileInvokeResources(this, modelProfiles, { extract: true });
    const batchObjects = corpusBucket.arnForObjects(`${EXTRACTION_BATCH_PREFIX}*`);
    const jobArns = `arn:aws:bedrock:${this.region}:${this.account}:model-invocation-job/*`;

    // Bedrock assumes this role to read the batch records and write the results.
    const batchRole = new iam.Role(this, "ExtractionBatchRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": jobArns },
        },
      }),
      description: "Bedrock batch inference for the assertion extraction",
    });
    batchRole.applyRemovalPolicy(RemovalPolicy.DESTROY);
    batchRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [batchObjects],
      }),
    );
    batchRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [corpusBucket.bucketArn],
      }),
    );
    batchRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: extractModelArns }),
    );

    const batchEnvironment = {
      MODEL_PROVIDER: "bedrock",
      BEDROCK_EXTRACT_MODEL: EXTRACT_MODEL,
      DB_RESOURCE_ARN: dbResourceArn,
      DB_SECRET_ARN: dbSecretArn,
      DB_NAME: dbName,
      CORPUS_BUCKET: corpusBucket.bucketName,
    };
    const startExtractionBatchFn = fn("startExtractionBatch", {
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        ...batchEnvironment,
        ...profileEnvironment(modelProfiles, { extract: true }),
        BATCH_ROLE_ARN: batchRole.roleArn,
      },
    });
    const getExtractionBatchFn = fn("getExtractionBatch", { environment: {} });
    const loadExtractionBatchFn = fn("loadExtractionBatch", {
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: { ...batchEnvironment, ...modelEnv },
    });
    startExtractionBatchFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [batchObjects] }),
    );
    startExtractionBatchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:CreateModelInvocationJob", "bedrock:TagResource"],
        resources: [jobArns, ...extractModelArns],
      }),
    );
    startExtractionBatchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [batchRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "bedrock.amazonaws.com" } },
      }),
    );
    getExtractionBatchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:GetModelInvocationJob"],
        resources: [jobArns],
      }),
    );
    loadExtractionBatchFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [batchObjects] }),
    );
    loadExtractionBatchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [corpusBucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${EXTRACTION_BATCH_PREFIX}*`] } },
      }),
    );

    checkBudgetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["budgets:ViewBudget"],
        resources: budgetNames.map((name) => `arn:aws:budgets::${this.account}:budget/${name}`),
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
    for (const f of [
      checkBudgetFn,
      ingestDocumentFn,
      extractAssertionsFn,
      startExtractionBatchFn,
      loadExtractionBatchFn,
    ]) {
      f.addToRolePolicy(
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
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [dbSecretArn],
        }),
      );
    }
    for (const f of [ingestDocumentFn, extractAssertionsFn, loadExtractionBatchFn]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: invokeResources,
        }),
      );
    }

    const checkBudget = new tasks.LambdaInvoke(this, "CheckBudget", {
      lambdaFunction: checkBudgetFn,
      payloadResponseOnly: true,
      resultPath: "$.budget",
    });
    const listManifest = new tasks.LambdaInvoke(this, "ListManifest", {
      lambdaFunction: listManifestFn,
      payload: sfn.TaskInput.fromObject({ corpus: sfn.JsonPath.stringAt("$.corpus") }),
      payloadResponseOnly: true,
      // The manifest sits beside the execution input, so the run's extraction options stay.
      resultPath: "$.manifest",
    });

    const ingestDocument = new tasks.LambdaInvoke(this, "IngestDocument", {
      lambdaFunction: ingestDocumentFn,
      payloadResponseOnly: true,
      resultPath: "$.result",
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
    // A partial result holds the context lines stored so far; the document is invoked again.
    const documentResult = sfn.Pass.jsonata(this, "DocumentResult", {
      outputs: "{% $states.input.result %}",
    });
    ingestDocument.next(
      new sfn.Choice(this, "DocumentComplete")
        .when(sfn.Condition.stringEquals("$.result.status", "partial"), ingestDocument)
        .otherwise(documentResult),
    );

    const documents = new sfn.Map(this, "IngestDocuments", {
      itemsPath: "$.manifest.items",
      maxConcurrency: MAX_CONCURRENT_DOCUMENTS,
      itemSelector: {
        corpus: sfn.JsonPath.stringAt("$.corpus"),
        row: sfn.JsonPath.objectAt("$$.Map.Item.Value"),
      },
      resultPath: "$.results",
    });
    documents.itemProcessor(ingestDocument);

    const checkBudgetBeforeExtraction = new tasks.LambdaInvoke(
      this,
      "CheckBudgetBeforeExtraction",
      {
        lambdaFunction: checkBudgetFn,
        payloadResponseOnly: true,
        resultPath: "$.extractionBudget",
      },
    );
    const extractDocumentAssertions = new tasks.LambdaInvoke(this, "ExtractDocumentAssertions", {
      lambdaFunction: extractAssertionsFn,
      payloadResponseOnly: true,
    });
    extractDocumentAssertions.addRetry({
      errors: ["ThrottlingException"],
      interval: Duration.seconds(30),
      maxAttempts: 2,
      backoffRate: 2,
    });
    const recordExtractionFailure = sfn.Pass.jsonata(this, "RecordExtractionFailure", {
      outputs: {
        evidenceId: "{% $states.input.row.evidence_id %}",
        error: "{% $states.input.error.Error %}",
        cause: "{% $substring($states.input.error.Cause, 0, 300) %}",
      },
    });
    extractDocumentAssertions.addCatch(recordExtractionFailure, { resultPath: "$.error" });

    const extractions = new sfn.Map(this, "ExtractAssertions", {
      itemsPath: "$.manifest.items",
      maxConcurrency: MAX_CONCURRENT_DOCUMENTS,
      itemSelector: {
        corpus: sfn.JsonPath.stringAt("$.corpus"),
        row: sfn.JsonPath.objectAt("$$.Map.Item.Value"),
      },
      resultPath: "$.extractions",
    });
    extractions.itemProcessor(extractDocumentAssertions);

    const done = new sfn.Succeed(this, "Done");
    extractions.next(done);

    const startExtractionBatch = new tasks.LambdaInvoke(this, "StartExtractionBatch", {
      lambdaFunction: startExtractionBatchFn,
      payloadResponseOnly: true,
      resultPath: "$.batch",
    });
    const recordBatchFailure = sfn.Pass.jsonata(this, "RecordBatchFailure", {
      outputs: {
        jobArn: "{% $exists($states.input.batch.jobArn) ? $states.input.batch.jobArn : null %}",
        error: "{% $states.input.error.Error %}",
        cause: "{% $substring($states.input.error.Cause, 0, 300) %}",
      },
    });
    recordBatchFailure.next(
      new sfn.Fail(this, "ExtractionBatchFailed", { errorPath: "$.error", causePath: "$.cause" }),
    );
    startExtractionBatch.addCatch(recordBatchFailure, { resultPath: "$.error" });

    const waitForBatch = new sfn.Wait(this, "WaitForExtractionBatch", {
      time: sfn.WaitTime.duration(BATCH_POLL_INTERVAL),
    });
    const getExtractionBatch = new tasks.LambdaInvoke(this, "GetExtractionBatch", {
      lambdaFunction: getExtractionBatchFn,
      payload: sfn.TaskInput.fromObject({
        batch: {
          jobArn: sfn.JsonPath.stringAt("$.batch.jobArn"),
          startedAt: sfn.JsonPath.numberAt("$.batch.startedAt"),
        },
      }),
      payloadResponseOnly: true,
      resultPath: "$.batchStatus",
    });
    // A poll that Bedrock throttles is tried again; the job runs on regardless.
    getExtractionBatch.addRetry({
      errors: ["ThrottlingException", "InternalServerException"],
      interval: Duration.seconds(30),
      maxAttempts: 3,
      backoffRate: 2,
    });
    getExtractionBatch.addCatch(recordBatchFailure, { resultPath: "$.error" });

    const loadDocumentAssertions = new tasks.LambdaInvoke(this, "LoadDocumentAssertions", {
      lambdaFunction: loadExtractionBatchFn,
      payloadResponseOnly: true,
      resultPath: "$.result",
    });
    loadDocumentAssertions.addRetry({
      errors: ["ThrottlingException"],
      interval: Duration.seconds(30),
      maxAttempts: 2,
      backoffRate: 2,
    });
    loadDocumentAssertions.addCatch(
      sfn.Pass.jsonata(this, "RecordBatchLoadFailure", {
        outputs: {
          evidenceId: "{% $states.input.document.evidenceId %}",
          error: "{% $states.input.error.Error %}",
          cause: "{% $substring($states.input.error.Cause, 0, 300) %}",
        },
      }),
      { resultPath: "$.error" },
    );
    loadDocumentAssertions.next(
      new sfn.Choice(this, "LoadComplete")
        .when(sfn.Condition.stringEquals("$.result.status", "partial"), loadDocumentAssertions)
        .otherwise(sfn.Pass.jsonata(this, "LoadResult", { outputs: "{% $states.input.result %}" })),
    );
    const loads = new sfn.Map(this, "LoadExtractionBatch", {
      itemsPath: "$.batch.documents",
      maxConcurrency: MAX_CONCURRENT_DOCUMENTS,
      itemSelector: {
        corpus: sfn.JsonPath.stringAt("$.corpus"),
        batch: {
          jobArn: sfn.JsonPath.stringAt("$.batch.jobArn"),
          prefix: sfn.JsonPath.stringAt("$.batch.prefix"),
          replace: sfn.JsonPath.objectAt("$.batch.replace"),
        },
        document: sfn.JsonPath.objectAt("$$.Map.Item.Value"),
      },
      resultPath: "$.extractions",
    });
    loads.itemProcessor(loadDocumentAssertions);
    loads.next(done);

    waitForBatch
      .next(getExtractionBatch)
      .next(
        new sfn.Choice(this, "ExtractionBatchDone")
          .when(sfn.Condition.booleanEquals("$.batchStatus.done", true), loads)
          .otherwise(waitForBatch),
      );

    const definition = checkBudget
      .next(listManifest)
      .next(documents)
      .next(checkBudgetBeforeExtraction)
      .next(startExtractionBatch)
      .next(
        new sfn.Choice(this, "ExtractionMode")
          .when(sfn.Condition.stringEquals("$.batch.mode", "batch"), waitForBatch)
          .otherwise(extractions),
      );

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
    new CfnOutput(this, "ExtractAssertionsFunctionName", {
      value: extractAssertionsFn.functionName,
    });
    new CfnOutput(this, "StartExtractionBatchFunctionName", {
      value: startExtractionBatchFn.functionName,
    });
    new CfnOutput(this, "LoadExtractionBatchFunctionName", {
      value: loadExtractionBatchFn.functionName,
    });
    new CfnOutput(this, "ExtractionBatchRoleArn", { value: batchRole.roleArn });
  }
}
