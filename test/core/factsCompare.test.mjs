// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  ALIGN_SIMILARITY,
  ALIGN_SIMILARITY_ALONE,
  alignAssertions,
  claimText,
  eligible,
  embedTexts,
  normalisePredicate,
  sharedAnchors,
} from "../../packages/core/facts/align.mjs";
import {
  COMPARE_PIPELINE_VERSION,
  LEASE_MINUTES,
  RUN_SQL,
  assertionFromRow,
  modelBatches,
  runComparison,
} from "../../packages/core/facts/compare.mjs";
import {
  NLI_PROMPT_VERSION,
  PAIRS_PER_CALL,
  RULES_MODEL,
  checkLabel,
  contentWords,
  negationSpan,
  nliPrompt,
  rulesLabel,
} from "../../packages/core/facts/nli.mjs";
import { createCompareStore } from "./compareFakeStore.mjs";
import { compareProvider, compareSeed, disputeSeed } from "./compareFixture.mjs";

const quiet = () => {};

function fixtureAssertions(seed = compareSeed()) {
  return seed.assertions.map((a) => {
    const chunk = seed.chunks.find((c) => c.id === a.source_chunk_id);
    const doc = seed.documents.find((d) => d.id === chunk.document_id);
    return assertionFromRow({
      ...a,
      document_id: doc.id,
      sentence: chunk.text,
      statement_date: doc.statement_date,
    });
  });
}

async function aligned(bounds, seed) {
  const assertions = fixtureAssertions(seed).filter(eligible);
  const { provider } = compareProvider();
  const vectors = await embedTexts(provider, assertions.map(claimText));
  return alignAssertions(assertions, vectors, bounds);
}

const ids = (p) => `${p.kind} ${p.a.id}-${p.b.id}`;
const labelOf = (store, a, b) =>
  store.tables.assertion_comparisons.find((c) => c.assertion_a === a && c.assertion_b === b);

describe("alignment", () => {
  it("normalises a predicate without its leading pronoun or auxiliary", () => {
    expect(normalisePredicate("first saw")).toBe("saw");
    expect(normalisePredicate("I had  Seen,")).toBe("seen");
    expect(normalisePredicate("did not sound")).toBe("not sound");
  });

  it("pairs the smoke, alarm, stairs and firefighter claims and nothing else", async () => {
    const { pairs } = await aligned();
    expect(pairs.map(ids).sort()).toEqual(
      [
        "cross 1-2",
        "cross 1-3",
        "self 1-6",
        "cross 2-3",
        "cross 2-6",
        "cross 3-6",
        "cross 4-5",
        "cross 9-10",
        "cross 11-12",
      ].sort(),
    );
  });

  it("orders a self pair by statement date and groups by event, else by predicate", async () => {
    const { pairs } = await aligned();
    const self = pairs.find((p) => p.kind === "self");
    expect([self.a.documentId, self.b.documentId]).toEqual(["IWS-A1", "IWS-A2"]);
    expect(self.eventId).toBe("7");
    const stairs = pairs.find((p) => p.a.id === "9");
    expect(stairs).toMatchObject({ eventId: null, topic: "dark", anchors: ["subject"] });
  });

  it("needs a shared anchor below the stronger threshold", async () => {
    // The firefighter and flat claims sit at cosine 0.6 with no anchor in common.
    const { pairs } = await aligned();
    expect(pairs.some((p) => p.a.id === "7" && p.b.id === "12")).toBe(false);
    expect(ALIGN_SIMILARITY).toBeLessThan(ALIGN_SIMILARITY_ALONE);
  });

  it("anchors a cross pair on the event, a shared subject or a place, vehicle or unit object", async () => {
    const { pairs } = await aligned();
    const anchorsOf = (a, b) => pairs.find((p) => p.a.id === a && p.b.id === b).anchors;
    expect(anchorsOf("1", "3")).toEqual(["event"]);
    expect(anchorsOf("4", "5")).toEqual(["event", "subject"]);
    expect(anchorsOf("11", "12")).toEqual(["subject"]);
    const [a] = fixtureAssertions();
    const car = { objectText: "the car", objectEntityId: "70", witnessId: "IWS-B", id: "90" };
    const thing = { ...a, subjectText: "The lift", subjectKind: "thing", eventId: null };
    expect(
      sharedAnchors(
        { ...thing, ...car, objectEntityKind: "vehicle" },
        { ...thing, objectEntityId: "70", objectEntityKind: "vehicle" },
      ),
    ).toEqual(["subject", "object"]);
    expect(
      sharedAnchors(
        { ...thing, subjectText: "A man", ...car, objectEntityKind: "person" },
        { ...thing, objectEntityId: "70", objectEntityKind: "person" },
      ),
    ).toEqual([]);
  });

  it("pairs two first-person claims of two witnesses only when both observe a shared event", async () => {
    const [a, b] = fixtureAssertions();
    const car = { objectEntityId: "70", objectEntityKind: "vehicle" };
    expect(sharedAnchors({ ...a, ...car, eventId: null }, { ...b, ...car, eventId: null })).toEqual(
      [],
    );
    expect(sharedAnchors(a, b)).toEqual(["event"]);
    for (const kind of ["action", "attribute", "report", null]) {
      expect(sharedAnchors(a, { ...b, claimKind: kind })).toEqual([]);
    }
  });

  it("pairs a witness's own attribute only with a claim whose subject resolves to that witness", () => {
    const [a] = fixtureAssertions();
    const age = { ...a, predicate: "was", objectText: "40 years old", claimKind: "attribute" };
    const about = {
      ...age,
      id: "92",
      witnessId: "IWS-B",
      subjectText: "Mrs Ash",
      subjectKind: "person",
      claimKind: "report",
    };
    expect(sharedAnchors(age, about)).toEqual([]);
    expect(
      sharedAnchors(age, { ...about, subjectEntityId: "81", subjectWitnessId: "IWS-A" }),
    ).toEqual(["subject"]);
    expect(sharedAnchors({ ...age, claimKind: "observation" }, about)).toEqual(["event"]);
  });

  it("shares no subject by a pronoun's words, and one by a resolved entity whatever the words", () => {
    const [, , , alarm] = fixtureAssertions();
    const she = { ...alarm, eventId: null, subjectText: "She", subjectKind: "person" };
    const other = { ...she, id: "93", witnessId: "IWS-B" };
    expect(sharedAnchors(she, other)).toEqual([]);
    expect(
      sharedAnchors({ ...she, subjectText: "this man" }, { ...other, subjectText: "This man" }),
    ).toEqual([]);
    expect(
      sharedAnchors(
        { ...she, subjectText: "Mrs Ash", subjectEntityId: "81" },
        { ...other, subjectText: "Ms Ash", subjectEntityId: "81" },
      ),
    ).toEqual(["subject"]);
    expect(
      sharedAnchors(
        { ...she, subjectText: "Mrs Ash", subjectEntityId: "81" },
        { ...other, subjectText: "Mrs Ash", subjectEntityId: "82" },
      ),
    ).toEqual([]);
  });

  it("pairs the brigade's arrival and the fire safety notice, and no bed time, age, death or nobody told", async () => {
    const { pairs } = await aligned(undefined, disputeSeed());
    const added = pairs.filter((p) => Number(p.a.id) > 12 || Number(p.b.id) > 12);
    expect(added.map(ids).sort()).toEqual(["cross 16-17", "cross 23-24"]);
    expect(added.find((p) => p.a.id === "16")).toMatchObject({
      eventId: "10",
      anchors: ["event", "subject"],
      similarity: 1,
    });
    expect(added.find((p) => p.a.id === "23")).toMatchObject({
      eventId: null,
      anchors: ["subject"],
    });
  });

  it("pairs a self pair on its predicate, or above the stronger threshold with no anchor", async () => {
    const [a] = fixtureAssertions();
    const later = { ...a, id: "91", documentId: "IWS-A2", eventId: null };
    expect(sharedAnchors({ ...a, eventId: null }, later)).toEqual(["subject", "predicate"]);
  });

  it("bounds the pairs per group and per assertion, most similar first", async () => {
    expect((await aligned({ maxPerGroup: 2 })).pairs.filter((p) => p.eventId === "7")).toHaveLength(
      2,
    );
    const byPartners = await aligned({ maxPartners: 1 });
    const degree = new Map();
    for (const p of byPartners.pairs) {
      for (const side of [p.a, p.b]) degree.set(side.id, (degree.get(side.id) ?? 0) + 1);
    }
    expect(Math.max(...degree.values())).toBe(1);
    expect(byPartners.dropped).toBeGreaterThan(0);
  });

  it("leaves low-confidence assertions and assertions with no witness out", () => {
    const [a] = fixtureAssertions();
    expect(eligible({ ...a, confidence: 0.4 })).toBe(false);
    expect(eligible({ ...a, confidence: null })).toBe(true);
    expect(eligible({ ...a, witnessId: null })).toBe(false);
  });
});

describe("the rules pass", () => {
  it("labels the timing dispute contradict from the stored fields, naming them", async () => {
    const { pairs } = await aligned();
    const find = (a, b) => pairs.find((p) => p.a.id === a && p.b.id === b);
    const dispute = rulesLabel(find("1", "3"));
    expect(dispute).toEqual({
      label: "contradict",
      reason: expect.stringMatching(
        /^time: "about 1.00 am" \(00:50-01:10\) and "1.30 am" \(01:25-01:35\) do not overlap/,
      ),
      spanA: "about 1.00 am",
      spanB: "1.30 am",
    });
    expect(rulesLabel(find("1", "2"))).toMatchObject({ label: "agree", spanA: "first saw" });
    expect(rulesLabel(find("1", "6")).label).toBe("contradict");
    expect(rulesLabel(find("11", "12")).label).toBe("agree");
    for (const [a, b] of [
      ["4", "5"],
      ["9", "10"],
    ])
      expect(rulesLabel(find(a, b))).toBeNull();
  });

  const alarm = () => {
    const [, , , , sounded] = fixtureAssertions();
    return {
      a: sounded,
      b: {
        ...sounded,
        id: "99",
        witnessId: "C123",
        polarity: "negative",
        sentence: "The fire alarm never sounded in the corridor.",
      },
    };
  };

  it("labels opposite polarity on the same claim contradict, on the negation it reads", () => {
    const { a, b } = alarm();
    expect(rulesLabel({ kind: "cross", a, b })).toMatchObject({
      label: "contradict",
      reason: expect.stringMatching(/^polarity: positive against negative/),
      spanA: "sounded",
      spanB: "never sounded",
    });
  });

  it("leaves opposite polarity to the model on a function-word predicate or object", () => {
    const { a, b } = alarm();
    const it_ = { subjectText: "It", subjectKind: "thing", predicate: "was", objectText: "It" };
    expect(
      rulesLabel({
        kind: "cross",
        a: { ...a, ...it_, sentence: "It was it." },
        b: { ...b, ...it_, sentence: "It was not it." },
      }),
    ).toBeNull();
    const told = { predicate: "told", objectText: "us", subjectText: "A firefighter" };
    expect(
      rulesLabel({
        kind: "cross",
        a: { ...a, ...told, subjectKind: "person", sentence: "A firefighter told us." },
        b: { ...b, ...told, subjectKind: "person", sentence: "A firefighter never told us." },
      }),
    ).toBeNull();
  });

  it("never labels two identical spans contradict", () => {
    const { a, b } = alarm();
    const forget = {
      subjectText: null,
      subjectKind: null,
      predicate: "must never forget",
      objectText: "the people of Grenfell",
    };
    expect(
      rulesLabel({
        kind: "cross",
        a: { ...a, ...forget, sentence: "We must never forget the people of Grenfell." },
        b: { ...b, ...forget, sentence: "I must never forget the people of Grenfell." },
      }),
    ).toBeNull();
  });

  it("reads a negation in the predicate or just before it", () => {
    expect(negationSpan("The fire alarm did not sound.", "did not sound")).toBe("did not sound");
    expect(negationSpan("Nobody at all told me that.", "told")).toBe("Nobody at all told");
    expect(negationSpan("The alarm sounded.", "sounded")).toBeNull();
    expect(contentWords("was")).toEqual([]);
    expect(contentWords("went to bed")).toEqual(["bed"]);
  });

  it("applies the time rule only to a pair that shares an event or a subject", async () => {
    const seed = disputeSeed();
    const all = fixtureAssertions(seed);
    const byId = (n) => all.find((x) => x.id === n);
    const brigade = rulesLabel({ kind: "cross", a: byId("16"), b: byId("17") });
    expect(brigade).toMatchObject({
      label: "contradict",
      reason: expect.stringMatching(/^time: "about 1.10 am" .* and "1.40 am" /),
      spanA: "about 1.10 am",
      spanB: "1.40 am",
    });
    expect(rulesLabel({ kind: "cross", a: byId("13"), b: byId("15") })).toBeNull();
    const smoke = (await aligned(undefined, seed)).pairs.filter(
      (p) => p.eventId === "7" && p.kind === "cross",
    );
    expect(smoke.map((p) => [ids(p), rulesLabel(p).label]).sort()).toEqual([
      ["cross 1-2", "agree"],
      ["cross 1-3", "contradict"],
      ["cross 2-3", "contradict"],
      ["cross 2-6", "contradict"],
      ["cross 3-6", "agree"],
    ]);
  });
});

describe("the model pass checks", () => {
  const assertions = fixtureAssertions();
  const batch = [{ kind: "cross", a: assertions[3], b: assertions[4] }];
  const ok = {
    pair: 1,
    label: "contradict",
    reason: "one sounds, one does not",
    span_a: "did not sound",
    span_b: "sounded",
  };

  it("prompts with both sentences of each pair", () => {
    const prompt = nliPrompt(batch);
    expect(prompt).toContain(
      "Pair 1\nA: The fire alarm did not sound.\nB: The fire alarm sounded in the corridor.",
    );
    expect(prompt).toMatch(/Do not use anything you know about the real event/);
  });

  it("keeps a label whose spans are verbatim and rejects the rest", () => {
    expect(checkLabel(ok, batch)).toMatchObject({ ok: true, index: 0, label: "contradict" });
    expect(checkLabel({ ...ok, span_a: "did not ring" }, batch)).toMatchObject({
      ok: false,
      reason: "span-a-not-in-sentence",
    });
    expect(checkLabel({ ...ok, span_b: "rang" }, batch).reason).toBe("span-b-not-in-sentence");
    expect(checkLabel({ ...ok, label: "consistent" }, batch).reason).toBe("label-not-allowed");
    expect(checkLabel({ ...ok, pair: 2 }, batch).reason).toBe("not-a-pair");
    expect(checkLabel({ ...ok, reason: "a\nb" }, batch).reason).toBe("reason-not-one-line");
    expect(checkLabel({ ...ok, reason: " " }, batch).reason).toBe("no-reason");
  });

  it("batches witness pairs apart from accepted pairs", () => {
    const pairs = [
      ...Array.from({ length: PAIRS_PER_CALL + 1 }, () => ({ kind: "cross" })),
      { kind: "accepted" },
    ];
    expect(modelBatches(pairs).map((b) => [b[0].kind, b.length])).toEqual([
      ["cross", PAIRS_PER_CALL],
      ["cross", 1],
      ["accepted", 1],
    ]);
  });
});

describe("runComparison", () => {
  it("labels the dispute by rules, the rest through one model call, and records the run", async () => {
    const store = createCompareStore(compareSeed());
    const { provider, prompts } = compareProvider();
    const lines = [];
    const result = await runComparison({
      corpus: "grenfell",
      db: store,
      provider,
      log: (l) => lines.push(l),
    });
    expect(result).toMatchObject({
      status: "complete",
      counts: {
        assertions: 12,
        compared: 12,
        pairs: 9,
        rules: 7,
        modelCalls: 1,
        modelLabelled: 2,
        rejected: 0,
        written: 9,
        remaining: 0,
      },
    });
    expect(prompts).toHaveLength(1);
    expect(labelOf(store, "1", "3")).toMatchObject({ label: "contradict", model: RULES_MODEL });
    expect(labelOf(store, "2", "3")).toMatchObject({ label: "contradict", model: RULES_MODEL });
    expect(labelOf(store, "1", "2")).toMatchObject({ label: "agree", model: RULES_MODEL });
    expect(labelOf(store, "4", "5")).toMatchObject({
      label: "contradict",
      model: "fake-extract",
      span_a: "did not sound",
      span_b: "sounded",
      event_id: "8",
    });
    expect(labelOf(store, "9", "10")).toMatchObject({ label: "unrelated", topic: "dark" });
    expect(store.tables.comparison_runs).toEqual([
      expect.objectContaining({
        corpus: "grenfell",
        pipeline_version: COMPARE_PIPELINE_VERSION,
        prompt_version: NLI_PROMPT_VERSION,
        model: "fake-extract",
        status: "complete",
      }),
    ]);
    const stages = lines.map((l) => JSON.parse(l).stage);
    expect(stages).toEqual([
      "assertions-loaded",
      "run-opened",
      "claims-embedded",
      "pairs-aligned",
      "rules-labelled",
      "model-labelled",
      "run-finished",
    ]);
  });

  it("inserts nothing and calls no model on a rerun over the same assertions", async () => {
    const store = createCompareStore(compareSeed());
    const { provider, prompts } = compareProvider();
    await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
    const before = store.tables.assertion_comparisons.length;
    const writes = store.statements.length;
    const again = await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
    expect(again.status).toBe("skipped");
    expect(store.tables.assertion_comparisons).toHaveLength(before);
    expect(store.tables.comparison_runs).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(store.statements.slice(writes).some((s) => /INSERT|UPDATE/.test(s.text))).toBe(false);
  });

  it("stops model calls at the deadline as partial and resumes without relabelling", async () => {
    const store = createCompareStore(compareSeed());
    const { provider, prompts } = compareProvider();
    let clock = 0;
    const first = await runComparison({
      corpus: "grenfell",
      db: store,
      provider,
      log: quiet,
      now: () => clock,
      deadline: 0,
    });
    expect(first).toMatchObject({
      status: "partial",
      counts: { rules: 7, modelCalls: 0, remaining: 2 },
    });
    expect(store.tables.comparison_runs[0].status).toBe("partial");
    clock = 1;
    const second = await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
    expect(second).toMatchObject({
      status: "complete",
      runId: first.runId,
      counts: { alreadyLabelled: 7, rules: 0, modelCalls: 1, written: 2 },
    });
    expect(prompts).toHaveLength(1);
    expect(store.tables.assertion_comparisons).toHaveLength(9);
  });

  describe("a run in progress", () => {
    async function runningStore() {
      const store = createCompareStore(compareSeed());
      const { provider, prompts } = compareProvider();
      const first = await runComparison({
        corpus: "grenfell",
        db: store,
        provider,
        log: quiet,
        deadline: 0,
      });
      store.tables.comparison_runs[0].status = "running";
      return { store, provider, prompts, first };
    }

    it("returns running and touches no model and writes nothing", async () => {
      const { store, provider, first } = await runningStore();
      const startedAt = store.tables.comparison_runs[0].started_at;
      const writes = store.statements.length;
      const idle = { extractModel: provider.extractModel };
      const second = await runComparison({
        corpus: "grenfell",
        db: store,
        provider: idle,
        log: quiet,
      });
      expect(second).toEqual({ status: "running", runId: first.runId, startedAt });
      const written = store.statements
        .slice(writes)
        .filter((s) => /INSERT|UPDATE/.test(s.text) && s.text !== RUN_SQL.claimRun);
      expect(written).toEqual([]);
      expect(store.tables.comparison_runs[0]).toMatchObject({
        status: "running",
        started_at: startedAt,
      });
    });

    it("resumes a lease older than sixteen minutes", async () => {
      const { store, provider, prompts, first } = await runningStore();
      store.advance((LEASE_MINUTES + 1) * 60_000);
      const second = await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
      expect(second).toMatchObject({ status: "complete", runId: first.runId });
      expect(prompts).toHaveLength(1);
    });

    it("keeps a lease younger than sixteen minutes", async () => {
      const { store, provider, first } = await runningStore();
      store.advance((LEASE_MINUTES - 1) * 60_000);
      const second = await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
      expect(second).toMatchObject({ status: "running", runId: first.runId });
    });

    it("marks the run partial with its counts when a model call throws", async () => {
      const store = createCompareStore(compareSeed());
      const { provider } = compareProvider({
        answer: () => {
          throw new Error("throttled after 8 attempts");
        },
      });
      await expect(
        runComparison({ corpus: "grenfell", db: store, provider, log: quiet }),
      ).rejects.toThrow(/throttled/);
      expect(store.tables.comparison_runs[0]).toMatchObject({
        status: "partial",
        counts: { rules: 7 },
      });
    });
  });

  it("drops a label whose span is not in its sentence and counts it", async () => {
    const store = createCompareStore(compareSeed());
    const { provider } = compareProvider({
      answer: (pairs) => ({
        labels: pairs.map(({ pair }) => ({
          pair,
          label: "agree",
          reason: "made up",
          span_a: "a span nobody wrote",
          span_b: "another",
        })),
      }),
    });
    const lines = [];
    const result = await runComparison({
      corpus: "grenfell",
      db: store,
      provider,
      log: (l) => lines.push(l),
    });
    expect(result.counts).toMatchObject({ modelLabelled: 0, rejected: 2, written: 7 });
    expect(lines.filter((l) => l.includes('"label-rejected"'))).toHaveLength(2);
  });

  it("throws when the model reply has no labels array", async () => {
    const store = createCompareStore(compareSeed());
    const { provider } = compareProvider({ answer: () => ({ nope: true }) });
    await expect(
      runComparison({ corpus: "grenfell", db: store, provider, log: quiet }),
    ).rejects.toThrow(/no labels array/);
  });

  it("labels the brigade's arrival by rules and the notice through the model, and pairs no age or death", async () => {
    const store = createCompareStore(disputeSeed());
    const { provider, prompts } = compareProvider();
    const result = await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
    expect(result.counts).toMatchObject({ assertions: 24, pairs: 11, rules: 8, modelLabelled: 3 });
    expect(labelOf(store, "16", "17")).toMatchObject({
      label: "contradict",
      model: RULES_MODEL,
      event_id: "10",
    });
    expect(labelOf(store, "23", "24")).toMatchObject({
      label: "contradict",
      model: "fake-extract",
      span_a: "residents should stay in their flat",
      span_b: "call 999 and to use the stairs",
    });
    expect(prompts.join("\n")).toMatch(
      /statements about themselves \(their own age, health, home or family\) are not about one person/,
    );
    const touched = store.tables.assertion_comparisons.filter((c) =>
      ["13", "14", "15", "18", "19", "20", "21", "22"].some(
        (n) => c.assertion_a === n || c.assertion_b === n,
      ),
    );
    expect(touched).toEqual([]);
  });

  it("compares witness assertions against an accepted fact, and only the new pairs on a rerun", async () => {
    const store = createCompareStore(compareSeed());
    const { provider } = compareProvider();
    await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
    store.tables.accepted_facts.push({
      id: "40",
      assertion_id: "2",
      text: "I saw smoke in the lobby at about 1.00 am when I opened the door.",
      source_citation: "fixture paragraph 1",
      promoted_by: "sub-1",
      session_id: null,
      is_hypothesis: false,
    });
    const result = await runComparison({ corpus: "grenfell", db: store, provider, log: quiet });
    expect(result).toMatchObject({
      status: "complete",
      counts: { alreadyLabelled: 9, pairs: 12, rules: 3, modelCalls: 0, written: 3 },
    });
    const accepted = store.tables.assertion_comparisons.filter((c) => c.kind === "accepted");
    expect(
      accepted.map((c) => [c.assertion_a, c.assertion_b, c.accepted_fact_id, c.label]).sort(),
    ).toEqual([
      ["1", "2", "40", "consistent"],
      ["3", "2", "40", "inconsistent"],
      ["6", "2", "40", "inconsistent"],
    ]);
    expect(store.tables.comparison_runs).toHaveLength(2);
  });
});
