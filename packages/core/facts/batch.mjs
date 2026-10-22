// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Assertion extraction through Bedrock batch inference. A corpus run writes one JSONL file of
// records a document, each record one window of the on-demand path with the same prompt, schema
// and inference settings in the Converse request body. Bedrock writes a .jsonl.out file for each
// input file; the reader turns its records back into the replies that extractAssertions checks
// and writes as it does a model reply. A window whose record failed, or that has no record, calls
// the model on demand. Nothing here touches S3, Bedrock or the store; the Lambdas in
// packages/aws/ do.

import { parseJsonReply } from "../providers/jsonReply.mjs";
import { ReplyTruncatedError } from "../providers/modelProvider.mjs";
import {
  ASSERTION_SCHEMA,
  clearExtractionProgress,
  extractPrompt,
  extractionState,
} from "./extract.mjs";

/** The Bedrock quota "Minimum number of records per batch inference job" for Claude Haiku 4.5. */
export const BATCH_MIN_RECORDS = 100;
/** The quota "Records per batch inference job" for Claude Haiku 4.5. */
export const BATCH_MAX_RECORDS = 100_000;
/** The output limit of an extraction call; the on-demand provider sends the same. */
export const EXTRACT_MAX_TOKENS = 8192;
/** The job's own timeout; the API accepts 24 to 168 hours. */
export const BATCH_TIMEOUT_HOURS = 24;
/** The corpus bucket prefix of the batch files; the corpora's own prefixes stay unwritten. */
export const BATCH_PREFIX = "extraction-batch";
export const EXTRACTION_MODES = Object.freeze(["batch", "on-demand"]);
/** The job statuses after which the results are read. */
export const BATCH_DONE = Object.freeze(["Completed", "PartiallyCompleted"]);
/** The job statuses that end the job with no results to read. */
export const BATCH_FAILED = Object.freeze(["Failed", "Stopped", "Expired"]);

/**
 * The line after the prompt that asks for JSON; the on-demand provider appends the same.
 * @param {object} [schema]
 */
export function extractInstruction(schema) {
  return schema
    ? `Answer with exactly one JSON object matching this schema:\n${JSON.stringify(schema)}`
    : "Answer with exactly one JSON object.";
}

/**
 * The Converse request body of one extraction call.
 * @param {string} prompt
 * @param {object} [schema]
 */
export function extractRequest(prompt, schema = ASSERTION_SCHEMA) {
  return {
    messages: [{ role: "user", content: [{ text: `${prompt}\n\n${extractInstruction(schema)}` }] }],
    inferenceConfig: { temperature: 0, maxTokens: EXTRACT_MAX_TOKENS },
  };
}

const RECORD_SEPARATOR = "_";
const INDEX_DIGITS = 5;

/** The record id of one window of one document. */
export const recordIdFor = (documentId, index) =>
  `${documentId}${RECORD_SEPARATOR}${String(index).padStart(INDEX_DIGITS, "0")}`;

/** @param {string} recordId */
export function parseRecordId(recordId) {
  const at = typeof recordId === "string" ? recordId.lastIndexOf(RECORD_SEPARATOR) : -1;
  const index = at < 0 ? NaN : Number(recordId.slice(at + 1));
  if (at <= 0 || !Number.isInteger(index) || index < 0) {
    throw new Error(`batch record id ${JSON.stringify(recordId)} is not <document>_<window>`);
  }
  return { documentId: recordId.slice(0, at), index };
}

/** The input file of one document under a job's input prefix. */
export const inputFileFor = (documentId) => `${documentId}.jsonl`;

/**
 * The batch records of one document: one a window from `first`.
 * @param {{ documentId: string, windows: object[], events?: readonly string[], first?: number }} args
 */
export function documentRecords({ documentId, windows, events = [], first = 0 }) {
  return windows.slice(first).map((w, i) => ({
    recordId: recordIdFor(documentId, first + i),
    modelInput: extractRequest(extractPrompt(w, events)),
  }));
}

/** @param {object[]} records */
export const toJsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

/**
 * @param {string} text
 * @param {string} describe names the file in the error
 */
export function parseJsonl(text, describe) {
  return text
    .split("\n")
    .map((line, i) => [line.trim(), i + 1])
    .filter(([line]) => line)
    .map(([line, n]) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${describe} line ${n} is not JSON: ${line.slice(0, 200)}`);
      }
    });
}

/**
 * The replies of one document's output records, by window index, for extractAssertions. A
 * record with an error object, or with no reply text, is listed under failed and gets no entry,
 * so its window calls the model on demand. A reply stopped at the output limit throws
 * ReplyTruncatedError and one that is not JSON throws InvalidReplyError, as extractJson does.
 * @param {object[]} records the lines of the .jsonl.out file
 * @param {{ documentId: string, model: string }} args
 */
export function batchReplies(records, { documentId, model }) {
  const replies = new Map();
  const failed = [];
  for (const record of records) {
    const { documentId: owner, index } = parseRecordId(record?.recordId);
    if (owner !== documentId) {
      throw new Error(`batch record ${record.recordId} is not of ${documentId}`);
    }
    if (replies.has(index)) throw new Error(`batch record ${record.recordId} appears twice`);
    const output = record.modelOutput;
    const text = output?.output?.message?.content?.find((c) => typeof c?.text === "string")?.text;
    if (record.error || typeof text !== "string") {
      failed.push({
        index,
        error: record.error
          ? `${record.error.errorCode ?? ""} ${record.error.errorMessage ?? ""}`.trim()
          : "no reply text",
      });
      continue;
    }
    const truncated = output.stopReason === "max_tokens";
    replies.set(index, () => {
      if (truncated) throw new ReplyTruncatedError(model, text.length);
      return parseJsonReply(text, model);
    });
  }
  return { replies, failed };
}

/**
 * The extraction mode of a run: "batch" only when asked, otherwise "on-demand". A batch under
 * BATCH_MIN_RECORDS or over BATCH_MAX_RECORDS records throws, because Bedrock refuses the job.
 * @param {{ requested?: string | null, records: number }} args
 */
export function extractionMode({ requested, records }) {
  if (requested != null && !EXTRACTION_MODES.includes(requested)) {
    throw new Error(`extraction ${JSON.stringify(requested)} is not one of ${EXTRACTION_MODES}`);
  }
  const mode = requested ?? "on-demand";
  if (mode === "batch" && records < BATCH_MIN_RECORDS) {
    throw new Error(
      `a batch job needs at least ${BATCH_MIN_RECORDS} records; this run has ${records}`,
    );
  }
  if (mode === "batch" && records > BATCH_MAX_RECORDS) {
    throw new Error(
      `a batch job takes at most ${BATCH_MAX_RECORDS} records; this run has ${records}`,
    );
  }
  return mode;
}

/**
 * The job name of a corpus run: within the 63 characters the API takes.
 * @param {string} corpus
 * @param {number} at milliseconds since the epoch
 */
export function batchJobName(corpus, at) {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `concordance-extract-${corpus}-${stamp}`.slice(0, 63);
}

/**
 * The windows each document of a run still needs, as batch records. A document whose sentence
 * set is already extracted is left out unless replace is set; one with stored progress starts
 * after it. A replace plans every window from 0 and clears the stored progress, so the load's
 * first window deletes the old rows and the load resumes only within this run. A document that cannot be planned, such as one whose ingest failed, is listed under
 * failures and left out, so it fails alone.
 * @param {{ db: { query: Function }, documentIds: string[], extractModel: string,
 *   replace?: boolean }} args
 */
export async function planExtractionBatch({ db, documentIds, extractModel, replace = false }) {
  const documents = [];
  const failures = [];
  let skipped = 0;
  for (const documentId of documentIds) {
    let state;
    try {
      if (replace) await clearExtractionProgress(db, documentId);
      state = await extractionState({ documentId, db, extractModel, replace });
    } catch (err) {
      failures.push({ evidenceId: documentId, error: err.message.slice(0, 300) });
      continue;
    }
    if (state.done) {
      skipped++;
      continue;
    }
    documents.push({
      evidenceId: documentId,
      sourceSha256: state.sourceSha256,
      first: state.first,
      windows: state.windows.length,
      records: documentRecords({
        documentId,
        windows: state.windows,
        events: state.events,
        first: state.first,
      }),
    });
  }
  return {
    documents,
    failures,
    skipped,
    records: documents.reduce((n, d) => n + d.records.length, 0),
  };
}
