// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The extraction pass of the ingest state machine, first state: the windows the run's documents
// still need, then the mode. A run of BATCH_MIN_RECORDS records or more, or one that asks for
// "batch", writes one JSONL file a document under the corpus bucket's batch prefix and starts a
// Bedrock batch inference job over them; a smaller run, or one that asks for "on-demand", returns
// mode "on-demand" and the state machine maps the on-demand extraction over the rows. The job
// reads the stored chunk text through its records; the evidence is not read or written here.

import { corpusInfo } from "../core/ingest/run.mjs";
import {
  BATCH_PREFIX,
  BATCH_TIMEOUT_HOURS,
  batchJobName,
  extractionMode,
  inputFileFor,
  planExtractionBatch,
  toJsonl,
} from "../core/facts/batch.mjs";

const requireValue = (value, name) => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/**
 * @param {{ providerFor: () => Promise<object> | object, openDb: () => Promise<object> | object,
 *   putObject: (key: string, body: string) => Promise<void>,
 *   createJob: (input: object) => Promise<{ jobArn: string }>, bucket: string, roleArn: string,
 *   now?: () => number, log?: (line: string) => void }} deps
 */
export function createHandler({
  providerFor,
  openDb,
  putObject,
  createJob,
  bucket,
  roleArn,
  now = Date.now,
  log = console.log,
}) {
  return async (event) => {
    const corpus = event?.corpus;
    corpusInfo(corpus);
    const { evidenceIds, replace = false } = event ?? {};
    if (evidenceIds !== undefined) {
      if (!Array.isArray(evidenceIds) || !evidenceIds.length) {
        throw new Error("evidenceIds must be a non-empty list of evidence ids");
      }
      for (const id of evidenceIds) {
        if (typeof id !== "string" || !id) throw new Error(`evidence id ${id} is not a string`);
      }
    }
    if (typeof replace !== "boolean") throw new Error("replace must be true or false");
    const documentIds = evidenceIds ?? (event?.manifest?.items ?? []).map((row) => row.evidence_id);
    const provider = await providerFor();
    const extractModel = requireValue(provider.extractModel, "the extraction model id");
    const db = await openDb();
    let plan;
    try {
      plan = await planExtractionBatch({ db, documentIds, extractModel, replace });
    } finally {
      await db.close();
    }
    const mode = extractionMode({ requested: event?.extraction ?? null, records: plan.records });
    const summary = {
      corpus,
      mode,
      records: plan.records,
      documents: plan.documents.length,
      skipped: plan.skipped,
      failures: plan.failures,
    };
    if (mode === "on-demand") {
      if (evidenceIds !== undefined || replace) {
        throw new Error("evidenceIds and replace apply to a batch run only");
      }
      log(JSON.stringify(summary));
      return { mode, records: plan.records, failures: plan.failures };
    }
    const jobName = batchJobName(corpus, now());
    const prefix = `${BATCH_PREFIX}/${corpus}/${jobName}`;
    for (const document of plan.documents) {
      if (!document.records.length) continue;
      await putObject(
        `${prefix}/input/${inputFileFor(document.evidenceId)}`,
        toJsonl(document.records),
      );
    }
    const { jobArn } = await createJob({
      jobName,
      clientRequestToken: jobName,
      roleArn: requireValue(roleArn, "the batch service role"),
      modelId: extractModel,
      modelInvocationType: "Converse",
      timeoutDurationInHours: BATCH_TIMEOUT_HOURS,
      inputDataConfig: {
        s3InputDataConfig: {
          s3Uri: `s3://${requireValue(bucket, "CORPUS_BUCKET")}/${prefix}/input/`,
          s3InputFormat: "JSONL",
        },
      },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: `s3://${bucket}/${prefix}/output/` } },
    });
    log(JSON.stringify({ ...summary, jobName, jobArn }));
    return {
      mode,
      jobArn,
      jobName,
      prefix,
      replace,
      startedAt: now(),
      records: plan.records,
      failures: plan.failures,
      documents: plan.documents
        .filter((d) => d.records.length)
        .map((d) => ({
          evidenceId: d.evidenceId,
          sourceSha256: d.sourceSha256,
          records: d.records.length,
        })),
    };
  };
}

let s3;
let bedrock;
export const handler = createHandler({
  providerFor: async () => (await import("../core/providers/index.mjs")).providerFromEnv(),
  openDb: async () => (await import("../core/db.mjs")).openDbFromEnv(),
  putObject: async (Key, Body) => {
    const sdk = await import("@aws-sdk/client-s3");
    s3 ??= new sdk.S3Client({});
    await s3.send(
      new sdk.PutObjectCommand({
        Bucket: process.env.CORPUS_BUCKET,
        Key,
        Body,
        ContentType: "application/jsonl",
      }),
    );
  },
  createJob: async (input) => {
    const sdk = await import("@aws-sdk/client-bedrock");
    bedrock ??= new sdk.BedrockClient({});
    return bedrock.send(new sdk.CreateModelInvocationJobCommand(input));
  },
  bucket: process.env.CORPUS_BUCKET,
  roleArn: process.env.BATCH_ROLE_ARN,
});
