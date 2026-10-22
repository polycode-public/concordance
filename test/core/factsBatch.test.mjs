// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  BATCH_MIN_RECORDS,
  BATCH_PREFIX,
  batchJobName,
  batchReplies,
  documentRecords,
  extractRequest,
  extractionMode,
  parseJsonl,
  parseRecordId,
  planExtractionBatch,
  recordIdFor,
  toJsonl,
} from "../../packages/core/facts/batch.mjs";
import {
  ASSERTION_SCHEMA,
  extractAssertions,
  EXTRACT_PIPELINE_VERSION,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_WINDOW,
  extractPrompt,
  sentenceWindows,
} from "../../packages/core/facts/extract.mjs";
import { createBedrockProvider } from "../../packages/core/providers/bedrockProvider.mjs";
import { InvalidReplyError } from "../../packages/core/providers/jsonReply.mjs";
import { ReplyTruncatedError } from "../../packages/core/providers/modelProvider.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { EXTRACTION_BATCH_PREFIX } from "../../infra/lib/dataStack.mjs";
import { createFactsStore } from "./factsFakeStore.mjs";

const S0 = "I saw smoke from Flat 16 at about 01:00 on the night of the fire.";
const S1 = "I did not see firefighters near Flat 16 during the fire.";
const seed = () => ({
  documents: [{ id: "IWS1", witness_id: "IWS1", corpus: "grenfell" }],
  sentences: [
    { id: "11", document_id: "IWS1", ordinal: 0, text: S0, header: "[H]" },
    { id: "12", document_id: "IWS1", ordinal: 1, text: S1, header: "[H]" },
  ],
  witnesses: [{ id: "IWS1", cipher_only: false, aliases: [] }],
});
const A0 = { sentence: 0, predicate: "saw", object_text: "smoke", polarity: "positive" };
const A1 = {
  sentence: 1,
  predicate: "did not see",
  object_text: "firefighters",
  polarity: "negative",
};

const converseOutput = (reply, stopReason = "end_turn") => ({
  output: { message: { role: "assistant", content: [{ text: reply }] } },
  stopReason,
  usage: { inputTokens: 900, outputTokens: 80 },
});
const outputRecord = (index, reply, stopReason) => ({
  recordId: recordIdFor("IWS1", index),
  modelInput: {},
  modelOutput: converseOutput(reply, stopReason),
});

describe("extractRequest", () => {
  it("is the Converse request the on-demand provider sends for the same prompt", async () => {
    const sent = [];
    class ConverseCommand {
      constructor(input) {
        this.input = input;
      }
    }
    const client = {
      async send(command) {
        sent.push(command.input);
        return converseOutput('{"assertions": []}');
      },
    };
    const provider = createBedrockProvider(
      {},
      { sdk: { ConverseCommand }, client, sleep: async () => {}, now: () => 0 },
    );
    const prompt = extractPrompt(sentenceWindows([{ ordinal: 0, text: S0 }])[0]);
    await provider.extractJson({ prompt, schema: ASSERTION_SCHEMA });
    const { messages, inferenceConfig } = sent[0];
    expect(extractRequest(prompt)).toEqual({ messages, inferenceConfig });
  });
});

describe("documentRecords and the JSONL", () => {
  const windows = sentenceWindows(
    [
      { ordinal: 0, text: S0 },
      { ordinal: 1, text: S1 },
      { ordinal: 2, text: "Then I left." },
    ],
    1,
  );

  it("writes one record a window from the first window still to run, named by document and window", () => {
    const records = documentRecords({ documentId: "MPS-0748738", windows, first: 1 });
    expect(records.map((r) => r.recordId)).toEqual(["MPS-0748738_00001", "MPS-0748738_00002"]);
    expect(records[0].modelInput).toEqual(extractRequest(extractPrompt(windows[1])));
    expect(records[0].modelInput.messages[0].content[0].text).toContain(`[S1] ${S1}`);
    expect(parseRecordId(records[1].recordId)).toEqual({ documentId: "MPS-0748738", index: 2 });
  });

  it("reads back the lines it writes, and names a bad line", () => {
    const records = documentRecords({ documentId: "IWS1", windows });
    const text = toJsonl(records);
    expect(text.split("\n")).toHaveLength(4);
    expect(parseJsonl(text, "in.jsonl")).toEqual(records);
    expect(() => parseJsonl('{"a":1}\n{oops\n', "x.jsonl.out")).toThrow(/x.jsonl.out line 2/);
  });

  it("refuses a record id that is not <document>_<window>", () => {
    expect(() => parseRecordId("IWS1")).toThrow(/not <document>_<window>/);
    expect(() => parseRecordId("IWS1_x")).toThrow(/not <document>_<window>/);
    expect(() => parseRecordId(undefined)).toThrow(/not <document>_<window>/);
  });

  it("keeps the batch prefix the data stack expires", () => {
    expect(`${BATCH_PREFIX}/`).toBe(EXTRACTION_BATCH_PREFIX);
  });
});

describe("batchReplies", () => {
  it("parses each reply, lists a failed record and keeps the others", () => {
    const { replies, failed } = batchReplies(
      [
        outputRecord(0, '```json\n{"assertions": []}\n```'),
        {
          recordId: recordIdFor("IWS1", 1),
          modelInput: {},
          error: { errorCode: 400, errorMessage: "bad request" },
        },
        outputRecord(2, "I cannot say."),
        outputRecord(3, '{"assertions": [', "max_tokens"),
      ],
      { documentId: "IWS1", model: "m" },
    );
    expect([...replies.keys()]).toEqual([0, 2, 3]);
    expect(replies.get(0)()).toEqual({ assertions: [] });
    expect(() => replies.get(2)()).toThrow(InvalidReplyError);
    expect(() => replies.get(3)()).toThrow(ReplyTruncatedError);
    expect(failed).toEqual([{ index: 1, error: "400 bad request" }]);
  });

  it("refuses a record of another document or one that appears twice", () => {
    const other = { ...outputRecord(0, "{}"), recordId: recordIdFor("IWS2", 0) };
    expect(() => batchReplies([other], { documentId: "IWS1", model: "m" })).toThrow(/not of IWS1/);
    expect(() =>
      batchReplies([outputRecord(0, "{}"), outputRecord(0, "{}")], {
        documentId: "IWS1",
        model: "m",
      }),
    ).toThrow(/appears twice/);
  });
});

describe("extractionMode", () => {
  it("runs a batch from the minimum record count, and on demand below it", () => {
    expect(extractionMode({ records: BATCH_MIN_RECORDS })).toBe("batch");
    expect(extractionMode({ records: BATCH_MIN_RECORDS - 1 })).toBe("on-demand");
    expect(extractionMode({ requested: "on-demand", records: 5000 })).toBe("on-demand");
    expect(extractionMode({ requested: "batch", records: 159 })).toBe("batch");
  });

  it("refuses a batch Bedrock would refuse, and an unknown mode", () => {
    expect(() => extractionMode({ requested: "batch", records: 99 })).toThrow(
      /at least 100 records; this run has 99/,
    );
    expect(() => extractionMode({ requested: "batch", records: 100_001 })).toThrow(/at most/);
    expect(() => extractionMode({ requested: "cheap", records: 1 })).toThrow(/not one of/);
  });
});

describe("batchJobName", () => {
  it("names the corpus and the start time within the API's 63 characters", () => {
    const name = batchJobName("grenfell", Date.UTC(2026, 9, 22, 1, 2, 3));
    expect(name).toBe("concordance-extract-grenfell-20261022T010203");
    expect(name).toMatch(/^[a-zA-Z0-9]{1,63}(-*[a-zA-Z0-9+\-.]){0,63}$/);
    expect(batchJobName("x".repeat(80), 0).length).toBe(63);
  });
});

describe("planExtractionBatch", () => {
  it("plans the windows of a document not yet extracted, skips a finished one, lists a failure", async () => {
    const store = createFactsStore(seed());
    const plan = await planExtractionBatch({
      db: store,
      documentIds: ["IWS1", "IWS9"],
      extractModel: "fake-extract",
    });
    expect(plan.records).toBe(1);
    expect(plan.documents).toEqual([
      expect.objectContaining({ evidenceId: "IWS1", first: 0, windows: 1 }),
    ]);
    expect(plan.documents[0].records[0].recordId).toBe("IWS1_00000");
    expect(plan.failures).toEqual([{ evidenceId: "IWS9", error: "IWS9 is not ingested" }]);

    const p = createFakeProvider({ tokens: [], extractJson: () => ({ assertions: [A0] }) });
    await extractAssertions({ documentId: "IWS1", provider: p, db: store, log: () => {} });
    const again = await planExtractionBatch({
      db: store,
      documentIds: ["IWS1"],
      extractModel: "fake-extract",
    });
    expect(again).toMatchObject({ documents: [], skipped: 1, records: 0 });
    const replace = await planExtractionBatch({
      db: store,
      documentIds: ["IWS1"],
      extractModel: "fake-extract",
      replace: true,
    });
    expect(replace.records).toBe(1);
  });

  it("plans a replace from window 0 and clears the stored progress, a plain run from the progress", async () => {
    const data = seed();
    data.sentences = Array.from({ length: 25 }, (_, i) => ({
      id: String(100 + i),
      document_id: "IWS1",
      ordinal: i,
      text: `${S0} ${i}`,
      header: "[H]",
    }));
    const store = createFactsStore(data);
    const args = { db: store, documentIds: ["IWS1"], extractModel: "fake-extract" };
    const [first] = (await planExtractionBatch(args)).documents;
    expect(first).toMatchObject({ first: 0, windows: 3 });
    const setProgress = () => {
      store.tables.extraction_progress = [
        {
          document_id: "IWS1",
          source_sha256: first.sourceSha256,
          tool_version: EXTRACT_PIPELINE_VERSION,
          model: "fake-extract",
          prompt_version: EXTRACT_PROMPT_VERSION,
          window_size: EXTRACT_WINDOW,
          windows_done: 2,
        },
      ];
    };

    setProgress();
    const [plain] = (await planExtractionBatch(args)).documents;
    expect(plain.records.map((r) => r.recordId)).toEqual(["IWS1_00002"]);

    setProgress();
    const [replace] = (await planExtractionBatch({ ...args, replace: true })).documents;
    expect(replace.records.map((r) => r.recordId)).toEqual([
      "IWS1_00000",
      "IWS1_00001",
      "IWS1_00002",
    ]);
    expect(store.tables.extraction_progress).toEqual([]);
  });
});

describe("extractAssertions with batch replies", () => {
  const onDemand = (answer) => {
    const prompts = [];
    const provider = createFakeProvider({
      tokens: [],
      extractJson: ({ prompt }) => {
        prompts.push(prompt);
        return answer(prompt);
      },
    });
    return { provider, prompts };
  };
  const bySentence = (prompt) => ({
    assertions: /\[S0\]/.test(prompt) ? [A0] : /\[S1\]/.test(prompt) ? [A1] : [],
  });
  const rowsOf = (store) =>
    store.tables.assertions.map(({ source_chunk_id, predicate, object_text, polarity }) => ({
      source_chunk_id,
      predicate,
      object_text,
      polarity,
    }));
  const sha = async (store) =>
    (await planExtractionBatch({ db: store, documentIds: ["IWS1"], extractModel: "fake-extract" }))
      .documents[0].sourceSha256;

  it("writes the rows the on-demand path writes, with no model call", async () => {
    const reference = createFactsStore(seed());
    await extractAssertions({
      documentId: "IWS1",
      provider: onDemand(bySentence).provider,
      db: reference,
      window: 1,
      log: () => {},
    });

    const store = createFactsStore(seed());
    const { replies } = batchReplies(
      [
        outputRecord(0, JSON.stringify({ assertions: [A0] })),
        outputRecord(1, JSON.stringify({ assertions: [A1] })),
      ],
      { documentId: "IWS1", model: "fake-extract" },
    );
    const { provider, prompts } = onDemand(() => {
      throw new Error("no model call expected");
    });
    const result = await extractAssertions({
      documentId: "IWS1",
      provider,
      db: store,
      window: 1,
      replies,
      sourceSha256: await sha(store),
      log: () => {},
    });
    expect(prompts).toEqual([]);
    expect(result).toEqual({
      status: "extracted",
      counts: { sentences: 2, calls: 0, kept: 2, rejected: 0, written: 2, batchReplies: 2 },
      windows: { done: 2, total: 2 },
    });
    expect(rowsOf(store)).toEqual(rowsOf(reference));
    expect(store.tables.provenance).toHaveLength(1);
  });

  it("calls the model for a window whose record failed, and splits a cut-off reply", async () => {
    const store = createFactsStore(seed());
    const { replies } = batchReplies([outputRecord(0, '{"assertions": [', "max_tokens")], {
      documentId: "IWS1",
      model: "fake-extract",
    });
    const { provider, prompts } = onDemand(bySentence);
    const result = await extractAssertions({
      documentId: "IWS1",
      provider,
      db: store,
      window: 2,
      replies,
      log: () => {},
    });
    expect(prompts).toHaveLength(2);
    expect(result.counts).toMatchObject({ calls: 2, batchReplies: 1, written: 2 });
  });

  it("refuses replies made from another sentence set", async () => {
    const store = createFactsStore(seed());
    await expect(
      extractAssertions({
        documentId: "IWS1",
        provider: onDemand(bySentence).provider,
        db: store,
        replies: new Map(),
        sourceSha256: "0".repeat(64),
        log: () => {},
      }),
    ).rejects.toThrow(/sentences changed after the batch records were written/);
    expect(store.tables.assertions).toEqual([]);
  });

  it("runs a finished document again with replace and keeps one set of rows", async () => {
    const store = createFactsStore(seed());
    const { provider } = onDemand(bySentence);
    await extractAssertions({ documentId: "IWS1", provider, db: store, window: 1, log: () => {} });
    const { replies } = batchReplies(
      [outputRecord(0, JSON.stringify({ assertions: [A0] })), outputRecord(1, '{"assertions":[]}')],
      { documentId: "IWS1", model: "fake-extract" },
    );
    const result = await extractAssertions({
      documentId: "IWS1",
      provider,
      db: store,
      window: 1,
      replace: true,
      replies,
      log: () => {},
    });
    expect(result.status).toBe("replaced");
    expect(rowsOf(store)).toEqual([
      { source_chunk_id: "11", predicate: "saw", object_text: "smoke", polarity: "positive" },
    ]);
  });
});
