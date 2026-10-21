// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The status poll of the extraction batch job. A job that failed, stopped or expired throws, and
// so does one still running past the deadline, so the state machine takes its failure path.

import { BATCH_DONE, BATCH_FAILED, BATCH_TIMEOUT_HOURS } from "../core/facts/batch.mjs";

/** The poll gives up this long after the job started: past the job's own timeout. */
export const POLL_DEADLINE_MS = (BATCH_TIMEOUT_HOURS + 2) * 3600_000;

class BatchJobError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

/** @param {{ getJob: (jobArn: string) => Promise<object>, now?: () => number }} deps */
export function createHandler({ getJob, now = Date.now }) {
  return async (event) => {
    const { jobArn, startedAt } = event?.batch ?? {};
    if (!jobArn || !Number.isFinite(startedAt)) {
      throw new Error("the batch jobArn and startedAt are required");
    }
    const job = await getJob(jobArn);
    const status = job.status;
    const counts = {
      total: job.totalRecordCount ?? null,
      processed: job.processedRecordCount ?? null,
      succeeded: job.successRecordCount ?? null,
      failed: job.errorRecordCount ?? null,
    };
    if (BATCH_FAILED.includes(status)) {
      throw new BatchJobError(
        "BatchJobFailed",
        `${jobArn} is ${status}: ${job.message ?? "no message"}`,
      );
    }
    const done = BATCH_DONE.includes(status);
    if (!done && now() - startedAt > POLL_DEADLINE_MS) {
      throw new BatchJobError(
        "BatchJobTimedOut",
        `${jobArn} is still ${status} ${Math.round((now() - startedAt) / 3600_000)} hours after it started`,
      );
    }
    return { status, done, ...counts };
  };
}

let client;
export const handler = createHandler({
  getJob: async (jobIdentifier) => {
    const sdk = await import("@aws-sdk/client-bedrock");
    client ??= new sdk.BedrockClient({});
    return client.send(new sdk.GetModelInvocationJobCommand({ jobIdentifier }));
  },
});
