// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler as createStart } from "../../packages/aws/startExtractionBatch.mjs";
import {
  POLL_DEADLINE_MS,
  createHandler as createGet,
} from "../../packages/aws/getExtractionBatch.mjs";
import { createHandler as createLoad } from "../../packages/aws/loadExtractionBatch.mjs";
import {
  BATCH_MIN_RECORDS,
  parseJsonl,
  planExtractionBatch,
  recordIdFor,
} from "../../packages/core/facts/batch.mjs";
import {
  EXTRACT_PIPELINE_VERSION,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_WINDOW,
} from "../../packages/core/facts/extract.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { createFactsStore } from "../core/factsFakeStore.mjs";

const TEXT = "I saw smoke from Flat 16 at 01:00.";
const sentences = (documentId, count, first = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(first + i + 1),
    document_id: documentId,
    ordinal: i,
    text: TEXT,
  }));
const storeWith = (counts) =>
  createFactsStore({
    documents: Object.keys(counts).map((id) => ({ id, witness_id: id, corpus: "grenfell" })),
    sentences: Object.entries(counts).flatMap(([id, n], k) => sentences(id, n, k * 10_000)),
    witnesses: Object.keys(counts).map((id) => ({ id, cipher_only: false, aliases: [] })),
  });
const row = (evidence_id) => ({ evidence_id });

const PROFILE_ARN =
  "arn:aws:bedrock:eu-west-2:111111111111:application-inference-profile/abc123def456";

function startDeps(store, overrides = {}) {
  const puts = [];
  const jobs = [];
  const lines = [];
  const handler = createStart({
    providerFor: () => createFakeProvider({ tokens: [], extractJson: () => ({ assertions: [] }) }),
    openDb: () => store,
    putObject: async (key, body) => puts.push({ key, body }),
    createJob: async (input) => {
      jobs.push(input);
      return { jobArn: "arn:aws:bedrock:eu-west-2:111111111111:model-invocation-job/abcdef123456" };
    },
    bucket: "corpus-bucket",
    roleArn: "arn:aws:iam::111111111111:role/batch",
    extractProfileArn: PROFILE_ARN,
    now: () => Date.UTC(2026, 9, 22, 1, 2, 3),
    log: (line) => lines.push(JSON.parse(line)),
    ...overrides,
  });
  return { handler, puts, jobs, lines };
}

describe("startExtractionBatch", () => {
  it("refuses to start without the extract profile ARN, before any write", async () => {
    const { handler, puts, jobs } = startDeps(storeWith({ IWS1: 1000 }), {
      extractProfileArn: undefined,
    });
    await expect(
      handler({ corpus: "grenfell", extraction: "batch", manifest: { items: [row("IWS1")] } }),
    ).rejects.toThrow(/BEDROCK_EXTRACT_PROFILE_ARN/);
    expect(puts).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("writes one JSONL a document and starts a Converse batch job over the input prefix", async () => {
    const store = storeWith({ IWS1: 600, IWS2: 410 });
    const { handler, puts, jobs } = startDeps(store);
    const result = await handler({
      corpus: "grenfell",
      extraction: "batch",
      manifest: { items: [row("IWS1"), row("IWS2")] },
    });
    const prefix = "extraction-batch/grenfell/concordance-extract-grenfell-20261022T010203";
    expect(puts.map((p) => p.key)).toEqual([
      `${prefix}/input/IWS1.jsonl`,
      `${prefix}/input/IWS2.jsonl`,
    ]);
    const records = parseJsonl(puts[1].body, "IWS2.jsonl");
    expect(records).toHaveLength(41);
    expect(records[40].recordId).toBe(recordIdFor("IWS2", 40));
    expect(jobs).toEqual([
      {
        jobName: "concordance-extract-grenfell-20261022T010203",
        clientRequestToken: "concordance-extract-grenfell-20261022T010203",
        roleArn: "arn:aws:iam::111111111111:role/batch",
        modelId: PROFILE_ARN,
        modelInvocationType: "Converse",
        tags: [{ key: "project", value: "concordance" }],
        timeoutDurationInHours: 24,
        inputDataConfig: {
          s3InputDataConfig: {
            s3Uri: `s3://corpus-bucket/${prefix}/input/`,
            s3InputFormat: "JSONL",
          },
        },
        outputDataConfig: { s3OutputDataConfig: { s3Uri: `s3://corpus-bucket/${prefix}/output/` } },
      },
    ]);
    expect(result).toMatchObject({
      mode: "batch",
      jobArn: expect.stringContaining("model-invocation-job/"),
      prefix,
      replace: false,
      records: 101,
      failures: [],
      documents: [
        { evidenceId: "IWS1", sourceSha256: expect.any(String), records: 60 },
        { evidenceId: "IWS2", sourceSha256: expect.any(String), records: 41 },
      ],
    });
    expect(store.closed).toBe(1);
  });

  it("returns on-demand for a large run that does not ask for a batch, and writes nothing", async () => {
    const { handler, puts, jobs } = startDeps(storeWith({ IWS1: 1000 }));
    const result = await handler({ corpus: "grenfell", manifest: { items: [row("IWS1")] } });
    expect(result).toMatchObject({ mode: "on-demand", records: 100 });
    expect(puts).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("returns on-demand under the minimum and writes nothing", async () => {
    const { handler, puts, jobs } = startDeps(storeWith({ IWS1: (BATCH_MIN_RECORDS - 1) * 10 }));
    const result = await handler({ corpus: "grenfell", manifest: { items: [row("IWS1")] } });
    expect(result).toEqual({ mode: "on-demand", records: 99, failures: [] });
    expect(puts).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("runs one named statement again as a batch with replace", async () => {
    const store = storeWith({ IWS1: 1000, IWS2: 20 });
    const { handler, puts } = startDeps(store);
    const result = await handler({
      corpus: "grenfell",
      manifest: { items: [row("IWS1"), row("IWS2")] },
      extraction: "batch",
      replace: true,
      evidenceIds: ["IWS1"],
    });
    expect(result).toMatchObject({ mode: "batch", replace: true, records: 100 });
    expect(puts.map((p) => p.key.split("/").at(-1))).toEqual(["IWS1.jsonl"]);
  });

  it("plans every window of a replace though the document holds stored progress", async () => {
    const store = storeWith({ IWS1: 1000 });
    const [{ sourceSha256 }] = (
      await planExtractionBatch({
        db: store,
        documentIds: ["IWS1"],
        extractModel: "fake-extract",
      })
    ).documents;
    store.tables.extraction_progress = [
      {
        document_id: "IWS1",
        source_sha256: sourceSha256,
        tool_version: EXTRACT_PIPELINE_VERSION,
        model: "fake-extract",
        prompt_version: EXTRACT_PROMPT_VERSION,
        window_size: EXTRACT_WINDOW,
        windows_done: 60,
      },
    ];
    const { handler } = startDeps(store);
    const result = await handler({
      corpus: "grenfell",
      manifest: { items: [row("IWS1")] },
      extraction: "batch",
      replace: true,
      evidenceIds: ["IWS1"],
    });
    expect(result).toMatchObject({ mode: "batch", records: 100 });
    expect(store.tables.extraction_progress).toEqual([]);
  });

  it("refuses a batch under the minimum, and evidenceIds on an on-demand run", async () => {
    const { handler, jobs } = startDeps(storeWith({ IWS1: 30 }));
    await expect(
      handler({ corpus: "grenfell", manifest: { items: [row("IWS1")] }, extraction: "batch" }),
    ).rejects.toThrow(/at least 100 records; this run has 3/);
    await expect(
      handler({ corpus: "grenfell", manifest: { items: [] }, evidenceIds: ["IWS1"] }),
    ).rejects.toThrow(/apply to a batch run only/);
    await expect(handler({ corpus: "nowhere", manifest: { items: [] } })).rejects.toThrow(
      /unknown corpus/,
    );
    expect(jobs).toEqual([]);
  });
});

describe("getExtractionBatch", () => {
  const jobArn = "arn:aws:bedrock:eu-west-2:111111111111:model-invocation-job/abcdef123456";
  const get = (job, now = 1000) =>
    createGet({ getJob: async () => job, now: () => now })({ batch: { jobArn, startedAt: 0 } });

  it("reports done for a completed or partly completed job, with its counts", async () => {
    await expect(
      get({
        status: "Completed",
        totalRecordCount: 159,
        successRecordCount: 158,
        errorRecordCount: 1,
      }),
    ).resolves.toEqual({
      status: "Completed",
      done: true,
      total: 159,
      processed: null,
      succeeded: 158,
      failed: 1,
    });
    await expect(get({ status: "PartiallyCompleted" })).resolves.toMatchObject({ done: true });
    await expect(get({ status: "InProgress" })).resolves.toMatchObject({ done: false });
  });

  it("throws a named error for a failed, stopped or expired job, and past the deadline", async () => {
    for (const status of ["Failed", "Stopped", "Expired"]) {
      await expect(get({ status, message: "why" })).rejects.toMatchObject({
        name: "BatchJobFailed",
        message: expect.stringContaining(`is ${status}: why`),
      });
    }
    await expect(get({ status: "Scheduled" }, POLL_DEADLINE_MS + 1)).rejects.toMatchObject({
      name: "BatchJobTimedOut",
    });
  });
});

describe("loadExtractionBatch", () => {
  const prefix = "extraction-batch/grenfell/job";
  const outputKey = `${prefix}/output/abcdef123456/IWS1.jsonl.out`;
  const reply = (index, assertions) => ({
    recordId: recordIdFor("IWS1", index),
    modelInput: {},
    modelOutput: {
      output: { message: { content: [{ text: JSON.stringify({ assertions }) }] } },
      stopReason: "end_turn",
    },
  });

  async function load({ files, extractJson, sourceSha256 }) {
    const store = storeWith({ IWS1: 20 });
    const { documents } = await planExtractionBatch({
      db: store,
      documentIds: ["IWS1"],
      extractModel: "fake-extract",
    });
    const calls = [];
    const handler = createLoad({
      providerFor: () =>
        createFakeProvider({
          tokens: [],
          extractJson: (args) => {
            calls.push(args);
            return extractJson();
          },
        }),
      openDb: () => store,
      listKeys: async (p) => Object.keys(files).filter((k) => k.startsWith(p)),
      getText: async (key) => files[key],
      now: () => 0,
      log: () => {},
    });
    const result = await handler({
      corpus: "grenfell",
      batch: { jobArn: "arn", prefix, replace: false },
      document: { evidenceId: "IWS1", sourceSha256: sourceSha256 ?? documents[0].sourceSha256 },
    });
    return { result, store, calls };
  }

  it("writes the assertions of the output records and calls the model for a failed record", async () => {
    const files = {
      [`${prefix}/input/IWS1.jsonl`]: "",
      [outputKey]: [
        JSON.stringify(
          reply(0, [{ sentence: 0, predicate: "saw", object_text: "smoke", polarity: "positive" }]),
        ),
        JSON.stringify({
          recordId: recordIdFor("IWS1", 1),
          modelInput: {},
          error: { errorCode: 500 },
        }),
      ].join("\n"),
    };
    const { result, store, calls } = await load({
      files,
      extractJson: () => ({
        assertions: [
          { sentence: 10, predicate: "saw", object_text: "Flat 16", polarity: "positive" },
        ],
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("[S10]");
    expect(result).toEqual({
      evidenceId: "IWS1",
      status: "extracted",
      counts: {
        sentences: 20,
        calls: 1,
        kept: 2,
        rejected: 0,
        written: 2,
        batchReplies: 1,
        batchRecords: 2,
        batchFailed: 1,
      },
      windows: { done: 2, total: 2 },
    });
    expect(store.tables.assertions.map((a) => a.predicate)).toEqual(["saw", "saw"]);
  });

  it("throws when the output file is missing, and when the sentences changed", async () => {
    await expect(load({ files: {}, extractJson: () => ({ assertions: [] }) })).rejects.toThrow(
      /holds 0 files ending \/IWS1.jsonl.out/,
    );
    await expect(
      load({
        files: { [outputKey]: JSON.stringify(reply(0, [])) },
        extractJson: () => ({ assertions: [] }),
        sourceSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/sentences changed/);
  });
});
