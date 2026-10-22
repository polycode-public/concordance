// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One Map item of the batch branch of the ingest state machine: the output records of one
// document's input file into its assertions, through the same checks and writer as the on-demand
// path. A window whose record failed or is missing calls the model on demand; the count is in the
// result. A run that reaches the write margin returns status "partial" and the state machine
// invokes it again, which resumes after the last stored window.

import { extractAssertions } from "../core/facts/extract.mjs";
import { batchReplies, inputFileFor, parseJsonl } from "../core/facts/batch.mjs";
import { corpusInfo } from "../core/ingest/run.mjs";
import { WRITE_MARGIN_MS } from "./extractAssertions.mjs";

/**
 * @param {{ providerFor: () => Promise<object> | object, openDb: () => Promise<object> | object,
 *   listKeys: (prefix: string) => Promise<string[]>, getText: (key: string) => Promise<string>,
 *   now?: () => number, log?: (line: string) => void }} deps
 */
export function createHandler({
  providerFor,
  openDb,
  listKeys,
  getText,
  now = Date.now,
  log = console.log,
}) {
  return async (event, context) => {
    const started = now();
    corpusInfo(event?.corpus);
    const { prefix, replace = false } = event?.batch ?? {};
    const { evidenceId, sourceSha256 } = event?.document ?? {};
    if (!prefix || !evidenceId || !sourceSha256) {
      throw new Error("the batch prefix, evidenceId and sourceSha256 are required");
    }
    const suffix = `/${inputFileFor(evidenceId)}.out`;
    const keys = (await listKeys(`${prefix}/output/`)).filter((k) => k.endsWith(suffix));
    if (keys.length !== 1) {
      throw new Error(`${prefix}/output/ holds ${keys.length} files ending ${suffix}, expected 1`);
    }
    const remaining = context?.getRemainingTimeInMillis?.();
    const signal =
      remaining === undefined
        ? undefined
        : AbortSignal.timeout(Math.max(remaining - WRITE_MARGIN_MS, 0));
    const provider = await providerFor();
    const records = parseJsonl(await getText(keys[0]), keys[0]);
    const { replies, failed } = batchReplies(records, {
      documentId: evidenceId,
      model: provider.extractModel,
    });
    for (const f of failed) {
      log(
        JSON.stringify({
          evidenceId,
          stage: "batch-record-failed",
          window: f.index,
          error: f.error,
        }),
      );
    }
    const db = await openDb();
    try {
      const { status, counts, windows } = await extractAssertions({
        documentId: evidenceId,
        provider,
        db,
        replace,
        replies,
        sourceSha256,
        signal,
        log,
        now,
      });
      const result = {
        evidenceId,
        status,
        counts: { ...counts, batchRecords: records.length, batchFailed: failed.length },
        windows,
      };
      log(JSON.stringify({ ...result, ms: now() - started }));
      return result;
    } finally {
      await db.close();
    }
  };
}

let s3;
const s3Client = async () => {
  const sdk = await import("@aws-sdk/client-s3");
  s3 ??= new sdk.S3Client({});
  return { sdk, client: s3 };
};
export const handler = createHandler({
  providerFor: async () => (await import("../core/providers/index.mjs")).providerFromEnv(),
  openDb: async () => (await import("../core/db.mjs")).openDbFromEnv(),
  listKeys: async (Prefix) => {
    const { sdk, client } = await s3Client();
    const keys = [];
    let ContinuationToken;
    do {
      const page = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: process.env.CORPUS_BUCKET,
          Prefix,
          ContinuationToken,
        }),
      );
      keys.push(...(page.Contents ?? []).map((o) => o.Key));
      ContinuationToken = page.NextContinuationToken;
    } while (ContinuationToken);
    return keys;
  },
  getText: async (Key) => {
    const { sdk, client } = await s3Client();
    const { Body } = await client.send(
      new sdk.GetObjectCommand({ Bucket: process.env.CORPUS_BUCKET, Key }),
    );
    return Body.transformToString();
  },
});
