// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  ASSERTION_SCHEMA,
  EXTRACT_PIPELINE_VERSION,
  EXTRACT_PROMPT_VERSION,
  byteBatches,
  checkAssertion,
  extractAssertions,
  extractPrompt,
  sentenceWindows,
} from "../../packages/core/facts/extract.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { createFactsStore } from "./factsFakeStore.mjs";

const HEADER = "[Grenfell Inquiry | Witness IWS1 | resident | p.2 para 4]";
const S0 = "I saw smoke from Flat 16 at about 01:00 on the night of the fire.";
const S1 = "I did not see firefighters near Flat 16 during the fire, and W5 was with me.";

const seed = (extra = {}) => ({
  documents: [{ id: "IWS1", witness_id: "IWS1" }],
  sentences: [
    { id: "11", document_id: "IWS1", ordinal: 0, text: S0, header: HEADER, context_line: "Ctx." },
    { id: "12", document_id: "IWS1", ordinal: 1, text: S1, header: HEADER, context_line: "Ctx." },
  ],
  witnesses: [
    { id: "IWS1", cipher_only: false, aliases: [] },
    { id: "W5", cipher_only: true, aliases: ["Witness W5"] },
  ],
  ...extra,
});

const A0 = {
  sentence: 0,
  predicate: "saw",
  object_text: "smoke",
  object_kind: null,
  event_text: "the fire",
  time_text: "01:00",
  place_text: "Flat 16",
  modality: "about",
  polarity: "positive",
  confidence: 0.9,
};
const A1 = {
  sentence: 1,
  predicate: "did not see",
  object_text: "firefighters",
  object_kind: "unit",
  event_text: "the fire",
  place_text: "Flat 16",
  polarity: "negative",
  confidence: 0.8,
};
const A2 = { sentence: 1, predicate: "was with", object_text: "W5", polarity: "positive" };
const INVENTED = {
  sentence: 1,
  predicate: "did not see",
  object_text: "flames",
  polarity: "positive",
};
const FROM_NEIGHBOUR = {
  sentence: 1,
  predicate: "did not see",
  object_text: "smoke",
  polarity: "positive",
};
const NOT_A_TARGET = { sentence: 0, predicate: "saw", polarity: "positive" };

/** Answers each one-sentence window by the [Sn] it carries. */
function provider(bySentence) {
  const prompts = [];
  const p = createFakeProvider({
    tokens: [],
    extractJson: ({ prompt, schema }) => {
      expect(schema).toBe(ASSERTION_SCHEMA);
      prompts.push(prompt);
      const n = Number(/^\[S(\d+)\]/m.exec(prompt)[1]);
      return { assertions: bySentence[n] ?? [] };
    },
  });
  return { provider: p, prompts };
}

const RESPONSES = { 0: [A0], 1: [A1, A2, INVENTED, FROM_NEIGHBOUR, NOT_A_TARGET] };

async function run(store, responses = RESPONSES) {
  const lines = [];
  const { provider: p, prompts } = provider(responses);
  const result = await extractAssertions({
    documentId: "IWS1",
    provider: p,
    db: store,
    window: 1,
    log: (line) => lines.push(JSON.parse(line)),
    now: () => 0,
  });
  return { result, lines, prompts };
}

describe("sentenceWindows", () => {
  it("gives each window its targets and the sentence on each side", () => {
    expect(sentenceWindows([1, 2, 3, 4, 5], 2)).toEqual([
      { before: null, targets: [1, 2], after: 3 },
      { before: 2, targets: [3, 4], after: 5 },
      { before: 4, targets: [5], after: null },
    ]);
    expect(() => sentenceWindows([1], 0)).toThrow(RangeError);
  });
});

describe("extractPrompt", () => {
  it("numbers the targets, prints the header once and marks the context sentences", () => {
    const prompt = extractPrompt({
      before: { text: "Before." },
      targets: [
        { ordinal: 4, text: "A.", header: HEADER, context_line: "Ctx." },
        { ordinal: 5, text: "B.", header: HEADER, context_line: "Ctx." },
      ],
      after: null,
    });
    expect(prompt).toContain("Context before: Before.\nHeader: " + HEADER);
    expect(prompt).toContain("Paragraph context: Ctx.\n[S4] A.\n[S5] B.\nContext after: (none)");
    expect(prompt.match(/Header:/g)).toHaveLength(1);
  });
});

describe("checkAssertion", () => {
  const targets = new Map([[1, { id: "12", ordinal: 1, text: S1 }]]);

  it("keeps a row whose spans are in its sentence, with whitespace collapsed", () => {
    const checked = checkAssertion({ ...A1, object_text: "  firefighters " }, targets);
    expect(checked).toEqual({
      ok: true,
      row: {
        sentence: 1,
        sourceChunkId: "12",
        predicate: "did not see",
        object_text: "firefighters",
        event_text: "the fire",
        time_text: null,
        place_text: "Flat 16",
        modality: null,
        polarity: "negative",
        objectKind: "unit",
        confidence: 0.8,
      },
    });
  });

  it.each([
    [INVENTED, "object_text", "not-in-sentence"],
    [{ ...A1, place_text: "flat 16" }, "place_text", "not-in-sentence"],
    [{ ...A1, sentence: 0 }, "sentence", "not-a-target-sentence"],
    [{ ...A1, predicate: "" }, "predicate", "missing"],
    [{ ...A1, time_text: 1 }, "time_text", "not-a-string"],
    [{ ...A1, polarity: "maybe" }, "polarity", "not-positive-or-negative"],
    [{ ...A1, object_kind: "idea" }, "object_kind", "not-an-entity-kind"],
    [{ ...A1, object_text: null }, "object_kind", "kind-without-object"],
    [{ ...A1, confidence: 2 }, "confidence", "not-in-0-to-1"],
    ["text", null, "not-an-object"],
  ])("rejects %j at %s as %s", (raw, field, reason) => {
    expect(checkAssertion(raw, targets)).toMatchObject({ ok: false, field, reason });
  });
});

describe("byteBatches", () => {
  it("splits rows so a batch stays under the byte limit", () => {
    const items = Array.from({ length: 10 }, () => "x".repeat(100));
    const out = byteBatches(items, 1000);
    expect(out.flat()).toEqual(items);
    for (const b of out) expect(b.length).toBeLessThanOrEqual(3);
    expect(() => byteBatches(["x".repeat(600)], 1000)).toThrow(/over 1000/);
  });
});

describe("extractAssertions", () => {
  it("rejects and counts each value that is not in its target sentence", async () => {
    const { result, lines } = await run(createFactsStore(seed()));
    expect(result.counts).toEqual({ sentences: 2, calls: 2, kept: 3, rejected: 3, written: 3 });
    const rejections = lines.filter((l) => l.stage === "assertion-rejected");
    expect(rejections.map((l) => [l.sentence, l.field, l.reason])).toEqual([
      [1, "object_text", "not-in-sentence"],
      [1, "object_text", "not-in-sentence"],
      [0, "sentence", "not-a-target-sentence"],
    ]);
    expect(rejections[0].value).toBe('"flames"');
    const summary = lines.find((l) => l.stage === "assertions-rejected");
    expect(summary).toMatchObject({
      count: 3,
      reasons: { "not-in-sentence": 2, "not-a-target-sentence": 1 },
    });
    expect(lines.map((l) => l.stage)).toEqual([
      "sentences-loaded",
      "assertion-rejected",
      "assertion-rejected",
      "assertion-rejected",
      "calls-made",
      "assertions-kept",
      "assertions-rejected",
      "rows-written",
    ]);
  });

  it("writes the assertions with their sentence chunk, reusing one entity and one event", async () => {
    const store = createFactsStore(
      seed({ entities: [{ id: "500", kind: "place", canonical: "flat 16", aliases: [] }] }),
    );
    const { result, prompts } = await run(store);
    expect(result.status).toBe("extracted");
    expect(prompts[1]).toContain(`Context before: ${S0}`);
    expect(prompts[1]).toContain(`[S1] ${S1}`);

    const { assertions, entities, events, provenance } = store.tables;
    expect(events).toEqual([{ id: expect.any(String), name: "the fire" }]);
    const eventId = events[0].id;
    const unit = entities.find((e) => e.kind === "unit");
    const cipher = entities.find((e) => e.kind === "person");
    expect(entities).toHaveLength(3);
    expect(unit.canonical).toBe("firefighters");
    expect(cipher).toMatchObject({ canonical: "W5", aliases: [] });
    expect(assertions).toEqual([
      expect.objectContaining({
        witness_id: "IWS1",
        source_chunk_id: "11",
        event_id: eventId,
        predicate: "saw",
        object_text: "smoke",
        object_entity_id: null,
        time_text: "01:00",
        place_text: "Flat 16",
        place_entity_id: "500",
        polarity: "positive",
        modality: "about",
        confidence: 0.9,
        extractor: "fake-extract",
        pipeline_version: EXTRACT_PIPELINE_VERSION,
      }),
      expect.objectContaining({
        source_chunk_id: "12",
        event_id: eventId,
        object_entity_id: unit.id,
        place_entity_id: "500",
        polarity: "negative",
      }),
      expect.objectContaining({
        source_chunk_id: "12",
        predicate: "was with",
        object_text: "W5",
        object_entity_id: cipher.id,
        event_id: null,
      }),
    ]);
    expect(provenance).toEqual([
      {
        derived_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        step: "extract-assertions",
        tool: "concordance-facts",
        tool_version: EXTRACT_PIPELINE_VERSION,
        model: "fake-extract",
        prompt_version: EXTRACT_PROMPT_VERSION,
      },
    ]);
    expect(store.statements.some((s) => /accepted_facts/.test(s.text))).toBe(false);
  });

  it("creates a place entity once when two sentences name it", async () => {
    const store = createFactsStore(seed());
    await run(store, {
      0: [A0],
      1: [{ ...A1, place_text: "Flat 16" }],
    });
    const places = store.tables.entities.filter((e) => e.kind === "place");
    expect(places).toEqual([
      { id: expect.any(String), kind: "place", canonical: "Flat 16", aliases: [] },
    ]);
    const ids = store.tables.assertions.map((a) => a.place_entity_id);
    expect(ids).toEqual([places[0].id, places[0].id]);
  });

  it("inserts nothing and calls no model on a second run", async () => {
    const store = createFactsStore(seed());
    await run(store);
    const before = structuredClone(store.tables);
    const { result, prompts } = await run(store);
    expect(result).toEqual({
      status: "skipped",
      counts: { sentences: 2, calls: 0, kept: 0, rejected: 0, written: 0 },
      windows: { done: 2, total: 2 },
    });
    expect(prompts).toEqual([]);
    expect(store.tables).toEqual(before);
  });

  it("replaces the assertions made under another pipeline version", async () => {
    const store = createFactsStore(seed());
    await run(store);
    const { provider: p } = provider(RESPONSES);
    const result = await extractAssertions({
      documentId: "IWS1",
      provider: p,
      db: store,
      window: 1,
      pipelineVersion: "facts-v0",
      log: () => {},
    });
    expect(result.status).toBe("replaced");
    expect(store.tables.assertions).toHaveLength(3);
    expect(store.tables.assertions.every((a) => a.pipeline_version === "facts-v0")).toBe(true);
    expect(store.tables.entities).toHaveLength(3);
    expect(store.tables.events).toHaveLength(1);
  });

  it("asks one model call for a window of sentences", async () => {
    const store = createFactsStore(seed());
    let calls = 0;
    const p = createFakeProvider({
      tokens: [],
      extractJson: ({ prompt }) => {
        calls++;
        expect(prompt).toContain("[S0]");
        expect(prompt).toContain("[S1]");
        return { assertions: [A0, A1] };
      },
    });
    const result = await extractAssertions({
      documentId: "IWS1",
      provider: p,
      db: store,
      log: () => {},
    });
    expect(calls).toBe(1);
    expect(result.counts).toMatchObject({ calls: 1, kept: 2, written: 2 });
  });

  it("fails the document and writes nothing when a response has no assertions array", async () => {
    const store = createFactsStore(seed());
    const p = createFakeProvider({ tokens: [], extractJson: () => ({ facts: [] }) });
    await expect(
      extractAssertions({ documentId: "IWS1", provider: p, db: store, log: () => {} }),
    ).rejects.toThrow(/no assertions array for sentences 0-1/);
    expect(store.tables.assertions).toEqual([]);
    expect(store.tables.provenance).toEqual([]);
  });

  it("rolls back the window whose write fails and keeps the windows before it", async () => {
    const store = createFactsStore(seed());
    const query = store.query;
    const failing = async (text, params) => {
      if (/INSERT INTO provenance/.test(text)) throw new Error("write failed");
      return query(text, params);
    };
    const db = {
      query: failing,
      pool: { connect: async () => ({ query: failing, release() {} }) },
    };
    const { provider: p } = provider(RESPONSES);
    await expect(
      extractAssertions({ documentId: "IWS1", provider: p, db, window: 1, log: () => {} }),
    ).rejects.toThrow("write failed");
    expect(store.tables.assertions.map((a) => a.source_chunk_id)).toEqual(["11"]);
    expect(store.tables.provenance).toEqual([]);
    expect(store.tables.extraction_progress).toEqual([
      expect.objectContaining({ document_id: "IWS1", windows_done: 1, window_size: 1 }),
    ]);
  });

  it("throws for a document that is not ingested or has no sentences", async () => {
    const { provider: p } = provider({});
    await expect(
      extractAssertions({
        documentId: "IWS9",
        provider: p,
        db: createFactsStore(seed()),
        log() {},
      }),
    ).rejects.toThrow("IWS9 is not ingested");
    await expect(
      extractAssertions({
        documentId: "IWS1",
        provider: p,
        db: createFactsStore(seed({ sentences: [] })),
        log() {},
      }),
    ).rejects.toThrow("IWS1 has no sentence chunks");
  });

  describe("resuming across runs", () => {
    const COUNT = 7;
    const textOf = (n) => `I saw smoke number ${n}.`;
    const long = (extraSeed = {}) =>
      createFactsStore({
        documents: [{ id: "IWS1", witness_id: "IWS1" }],
        sentences: Array.from({ length: COUNT }, (_, n) => ({
          id: String(100 + n),
          document_id: "IWS1",
          ordinal: n,
          text: textOf(n),
          header: HEADER,
          context_line: null,
        })),
        witnesses: [{ id: "IWS1", cipher_only: false, aliases: [] }],
        ...extraSeed,
      });

    /** Answers every target of a window; aborts the signal after `stopAfter` calls. */
    function runner(store, { stopAfter = Infinity, window = 2 } = {}) {
      const controller = new AbortController();
      const firsts = [];
      const p = createFakeProvider({
        tokens: [],
        extractJson: ({ prompt }) => {
          const ordinals = [...prompt.matchAll(/^\[S(\d+)\]/gm)].map((m) => Number(m[1]));
          firsts.push(ordinals[0]);
          if (firsts.length >= stopAfter) controller.abort();
          return {
            assertions: ordinals.map((n) => ({
              sentence: n,
              predicate: "saw",
              object_text: `smoke number ${n}`,
              polarity: "positive",
            })),
          };
        },
      });
      const lines = [];
      return {
        firsts,
        lines,
        run: () =>
          extractAssertions({
            documentId: "IWS1",
            provider: p,
            db: store,
            window,
            signal: controller.signal,
            log: (line) => lines.push(JSON.parse(line)),
            now: () => 0,
          }),
      };
    }

    it("stores the windows it finished, records the marker and returns partial", async () => {
      const store = long();
      const first = runner(store, { stopAfter: 2 });
      const result = await first.run();
      expect(result).toEqual({
        status: "partial",
        counts: { sentences: COUNT, calls: 2, kept: 4, rejected: 0, written: 4 },
        windows: { done: 2, total: 4 },
      });
      expect(store.tables.assertions.map((a) => a.source_chunk_id)).toEqual([
        "100",
        "101",
        "102",
        "103",
      ]);
      expect(store.tables.provenance).toEqual([]);
      expect(store.tables.extraction_progress).toEqual([
        expect.objectContaining({ document_id: "IWS1", windows_done: 2, window_size: 2 }),
      ]);
    });

    it("resumes after the last stored window, finishes and then skips", async () => {
      const store = long();
      await runner(store, { stopAfter: 2 }).run();
      const second = runner(store);
      const result = await second.run();
      expect(second.firsts).toEqual([4, 6]);
      expect(result).toEqual({
        status: "extracted",
        counts: { sentences: COUNT, calls: 2, kept: 3, rejected: 0, written: 3 },
        windows: { done: 4, total: 4 },
      });
      expect(store.tables.assertions).toHaveLength(COUNT);
      expect(store.tables.provenance).toHaveLength(1);
      expect(store.tables.extraction_progress).toEqual([]);

      const third = runner(store);
      expect(await third.run()).toMatchObject({ status: "skipped" });
      expect(third.firsts).toEqual([]);
      expect(store.tables.assertions).toHaveLength(COUNT);
    });

    it("stops when the call itself is aborted and keeps the earlier windows", async () => {
      const store = long();
      const controller = new AbortController();
      let calls = 0;
      const p = createFakeProvider({
        tokens: [],
        extractJson: () => {
          if (++calls === 3) {
            controller.abort();
            throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
          }
          return { assertions: [] };
        },
      });
      const result = await extractAssertions({
        documentId: "IWS1",
        provider: p,
        db: store,
        window: 2,
        signal: controller.signal,
        log: () => {},
      });
      expect(result.status).toBe("partial");
      expect(result.windows).toEqual({ done: 2, total: 4 });
      expect(store.tables.extraction_progress[0].windows_done).toBe(2);
    });

    it("fails the document when a call fails and the signal has not fired", async () => {
      const store = long();
      const p = createFakeProvider({
        tokens: [],
        extractJson: () => {
          throw new Error("throttled");
        },
      });
      await expect(
        extractAssertions({ documentId: "IWS1", provider: p, db: store, window: 2, log: () => {} }),
      ).rejects.toThrow("throttled");
    });

    it("starts from the first window when the sentence set changed", async () => {
      const store = long();
      await runner(store, { stopAfter: 2 }).run();
      store.tables.chunks[0].text = "I saw smoke number 0, again.";
      const again = runner(store);
      const result = await again.run();
      expect(again.firsts).toEqual([0, 2, 4, 6]);
      expect(result.status).toBe("replaced");
      expect(store.tables.assertions).toHaveLength(COUNT);
      expect(store.tables.extraction_progress).toEqual([]);
    });

    it("starts from the first window when the window size changed", async () => {
      const store = long();
      await runner(store, { stopAfter: 2 }).run();
      const again = runner(store, { window: 3 });
      await again.run();
      expect(again.firsts).toEqual([0, 3, 6]);
      expect(store.tables.assertions).toHaveLength(COUNT);
    });
  });
});
