// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { WRITE_MARGIN_MS, createHandler } from "../../packages/aws/extractAssertions.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { createFactsStore } from "../core/factsFakeStore.mjs";

const ROW = {
  url: "https://example.test/IWS1.pdf",
  sha256: "a".repeat(64),
  bytes: 10,
  fetched_at: "2026-10-18T12:00:00Z",
  licence: "OGL-3.0",
  evidence_id: "IWS1",
};
const TEXT = "I saw smoke from Flat 16 at 01:00.";

function setup({ extractJson } = {}) {
  const store = createFactsStore({
    documents: [{ id: "IWS1", witness_id: "IWS1" }],
    sentences: [{ id: "21", document_id: "IWS1", ordinal: 0, text: TEXT, header: "[H]" }],
    witnesses: [{ id: "IWS1", cipher_only: false, aliases: [] }],
  });
  const signals = [];
  const lines = [];
  const handler = createHandler({
    providerFor: () =>
      createFakeProvider({
        tokens: [],
        extractJson:
          extractJson ??
          (({ signal }) => {
            signals.push(signal);
            return {
              assertions: [
                { sentence: 0, predicate: "saw", object_text: "smoke", polarity: "positive" },
                { sentence: 0, predicate: "heard", polarity: "positive" },
              ],
            };
          }),
      }),
    openDb: () => store,
    now: () => 0,
    log: (line) => lines.push(JSON.parse(line)),
  });
  return { handler, store, signals, lines };
}

describe("extractAssertions handler", () => {
  it("extracts one document, logs each stage and closes the database", async () => {
    const { handler, store, lines } = setup();
    const result = await handler({ corpus: "grenfell", row: ROW });
    expect(result).toEqual({
      evidenceId: "IWS1",
      status: "extracted",
      counts: { sentences: 1, calls: 1, kept: 1, rejected: 1, written: 1 },
    });
    expect(store.closed).toBe(1);
    expect(store.tables.assertions).toEqual([
      expect.objectContaining({ source_chunk_id: "21", predicate: "saw", witness_id: "IWS1" }),
    ]);
    expect(lines.map((l) => l.stage ?? l.status)).toEqual([
      "sentences-loaded",
      "assertion-rejected",
      "calls-made",
      "assertions-kept",
      "assertions-rejected",
      "rows-written",
      "extracted",
    ]);
    expect(lines.at(-1)).toEqual({
      evidenceId: "IWS1",
      status: "extracted",
      sentences: 1,
      calls: 1,
      kept: 1,
      rejected: 1,
      written: 1,
      ms: 0,
    });
  });

  it("skips a document it already extracted", async () => {
    const { handler } = setup();
    await handler({ corpus: "grenfell", row: ROW });
    const again = await handler({ corpus: "grenfell", row: ROW });
    expect(again.status).toBe("skipped");
  });

  it("stops the model calls a write margin before the Lambda timeout", async () => {
    const { handler, signals } = setup();
    await handler(
      { corpus: "grenfell", row: ROW },
      { getRemainingTimeInMillis: () => WRITE_MARGIN_MS + 5_000 },
    );
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(false);
  });

  it("fails the item and closes the database when the document is not ingested", async () => {
    const { handler, store } = setup();
    await expect(
      handler({ corpus: "grenfell", row: { ...ROW, evidence_id: "IWS2" } }),
    ).rejects.toThrow("IWS2 is not ingested");
    expect(store.closed).toBe(1);
  });

  it("throws on a malformed row or an unknown corpus", async () => {
    const { handler } = setup();
    await expect(handler({ corpus: "grenfell", row: { ...ROW, sha256: "x" } })).rejects.toThrow(
      /sha256 is missing or invalid/,
    );
    await expect(handler({ corpus: "nope", row: ROW })).rejects.toThrow(/unknown corpus nope/);
  });
});
