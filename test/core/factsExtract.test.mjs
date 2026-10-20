// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  ASSERTION_SCHEMA,
  EXTRACT_PIPELINE_VERSION,
  EXTRACT_PROMPT_VERSION,
  SHARED_EVENTS,
  byteBatches,
  checkAssertion,
  extractAssertions,
  extractPrompt,
  sentenceWindows,
} from "../../packages/core/facts/extract.mjs";
import { InvalidReplyError } from "../../packages/core/providers/jsonReply.mjs";
import { ReplyTruncatedError } from "../../packages/core/providers/modelProvider.mjs";
import { CLAIM_KINDS } from "../../packages/core/facts/align.mjs";
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
  subject_text: "I",
  subject_kind: "witness",
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
  subject_text: "I",
  subject_kind: "person",
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
    expect(prompt).not.toContain("event_text is a label");
  });

  it("names the corpus's shared events as the labels to prefer", () => {
    const prompt = extractPrompt(
      { before: null, targets: [{ ordinal: 0, text: "A." }], after: null },
      SHARED_EVENTS.grenfell,
    );
    expect(prompt).toContain(
      "event_text is a label. When the claim is about one of these events, copy its name exactly: 'the fire starting in Flat 16'; 'the first 999 calls'; 'the fire brigade arriving'; 'smoke in the lobby'; 'smoke in the stairs'; 'the advice to stay put'; 'the advice changing to leave'. Use the sentence's own words only when none of them fits",
    );
    expect(prompt).toContain("subject_kind is witness when subject_text is I, we or me");
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
        subject_text: "I",
        subjectKind: "witness",
        claimKind: null,
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
    [
      { ...A1, subject_text: "the brigade", subject_kind: "group" },
      "subject_text",
      "not-in-sentence",
    ],
    [
      { ...A1, subject_text: "firefighters", subject_kind: "witness" },
      "subject_kind",
      "witness-not-first-person",
    ],
    [
      { ...A1, subject_text: "firefighters", subject_kind: null },
      "subject_kind",
      "subject-without-kind",
    ],
    [{ ...A1, subject_text: null, subject_kind: "group" }, "subject_kind", "kind-without-subject"],
    [{ ...A1, subject_text: "W5", subject_kind: "crowd" }, "subject_kind", "not-a-subject-kind"],
    [{ ...A1, event_text: "the blaze" }, "event_text", "not-shared-or-in-sentence"],
    [{ ...A1, claim_kind: "opinion" }, "claim_kind", "not-a-claim-kind"],
    ["text", null, "not-an-object"],
  ])("rejects %j at %s as %s", (raw, field, reason) => {
    expect(checkAssertion(raw, targets)).toMatchObject({ ok: false, field, reason });
  });
});

describe("checkAssertion subjects and events", () => {
  const targets = new Map([
    [1, { id: "12", ordinal: 1, text: S1 }],
    [2, { id: "13", ordinal: 2, text: "The fire spread quickly up the building." }],
    [3, { id: "14", ordinal: 3, text: "We were told to stay in the flat by the 999 operator." }],
  ]);
  const check = (raw) => checkAssertion(raw, targets, SHARED_EVENTS.grenfell);

  it("maps I, we and me to the witness whatever kind the model gave", () => {
    expect(check({ ...A1, subject_kind: "group" }).row).toMatchObject({
      subject_text: "I",
      subjectKind: "witness",
    });
    expect(check({ ...A1, subject_text: "me", subject_kind: null }).row.subjectKind).toBe(
      "witness",
    );
    const we = { sentence: 3, subject_text: "We", predicate: "were told", polarity: "positive" };
    expect(check(we).row).toMatchObject({ subject_text: "We", subjectKind: "witness" });
  });

  it("keeps a group or thing subject that is a span of its sentence", () => {
    const operator = {
      sentence: 3,
      subject_text: "the 999 operator",
      subject_kind: "group",
      predicate: "told",
      polarity: "positive",
    };
    expect(check(operator).row).toMatchObject({
      subject_text: "the 999 operator",
      subjectKind: "group",
    });
    const fire = { sentence: 2, subject_text: "The fire", subject_kind: "thing" };
    expect(check({ ...fire, predicate: "spread", polarity: "positive" }).row.subjectKind).toBe(
      "thing",
    );
  });

  it("rejects a first-person subject that is not a word of its sentence", () => {
    const raw = { sentence: 2, subject_text: "I", predicate: "spread", polarity: "positive" };
    expect(check(raw)).toMatchObject({
      ok: false,
      field: "subject_text",
      reason: "not-in-sentence",
    });
  });

  it("takes a shared event in its own spelling, or a span of the sentence, as the event", () => {
    expect(check({ ...A1, event_text: "Smoke in  the Lobby" }).row.event_text).toBe(
      "smoke in the lobby",
    );
    expect(check({ ...A1, event_text: "the fire" }).row.event_text).toBe("the fire");
    expect(check({ ...A1, event_text: "x".repeat(81) })).toMatchObject({
      field: "event_text",
      reason: "too-long",
    });
  });
});

describe("checkAssertion claim kinds and pronoun subjects", () => {
  const NAMED = "Mrs Alder was carried down the stairs by a firefighter.";
  const SHE = "She died the following day.";
  const targets = new Map([
    [1, { id: "21", ordinal: 1, text: NAMED }],
    [2, { id: "22", ordinal: 2, text: SHE }],
    [3, { id: "23", ordinal: 3, text: "The fire spread quickly up the building." }],
  ]);
  const died = { sentence: 2, subject_kind: "person", predicate: "died", polarity: "positive" };

  it("offers the claim kinds in the schema and keeps each one, or null", () => {
    const item = ASSERTION_SCHEMA.properties.assertions.items.properties;
    expect(item.claim_kind).toEqual({ enum: [...CLAIM_KINDS, null] });
    expect(CLAIM_KINDS).toEqual(["attribute", "action", "observation", "report"]);
    const one = new Map([[1, { id: "12", ordinal: 1, text: S1 }]]);
    for (const kind of CLAIM_KINDS) {
      expect(checkAssertion({ ...A1, claim_kind: kind }, one).row.claimKind).toBe(kind);
    }
    expect(checkAssertion(A1, one).row.claimKind).toBeNull();
  });

  it("sets the kind to attribute when the witness states their own age, residence, job, family or home", () => {
    const ask = (predicate, object_text, claim_kind = "action", sentenceText) => {
      const text = sentenceText ?? `I ${predicate} ${object_text ?? ""}`.trim();
      const one = new Map([[1, { id: "9", ordinal: 1, text }]]);
      return checkAssertion(
        {
          sentence: 1,
          subject_text: "I",
          subject_kind: "witness",
          predicate,
          object_text,
          claim_kind,
          polarity: "positive",
        },
        one,
      ).row;
    };
    const attributes = [
      ["was", "40 years old"],
      ["was", "aged 42"],
      ["have lived", "in the tower for fifteen years"],
      ["am", "a resident of the tower"],
      ["was", "in poor health"],
      ["worked", "as a nurse"],
      ["have", "a wife and two sons"],
      ["have", "a flat on the ninth floor"],
    ];
    for (const [predicate, object] of attributes) {
      expect(ask(predicate, object, "report").claimKind, `${predicate} ${object}`).toBe(
        "attribute",
      );
    }
    const kept = [
      ["saw", "smoke coming under the door"],
      ["left", "the flat"],
      ["called", "my son"],
      ["was", "with my wife"],
      ["was", "in my home"],
    ];
    for (const [predicate, object] of kept) {
      expect(ask(predicate, object, "action").claimKind, `${predicate} ${object}`).toBe("action");
      expect(ask(predicate, object, "action").kindOverridden).toBeUndefined();
    }
    expect(ask("was", "40 years old", "attribute").kindOverridden).toBe(false);
    expect(ask("was", "40 years old", null).kindOverridden).toBe(true);
    const other = new Map([[1, { id: "9", ordinal: 1, text: "He was 40 years old." }]]);
    const row = checkAssertion(
      {
        sentence: 1,
        subject_text: "He",
        subject_kind: "person",
        predicate: "was",
        object_text: "40 years old",
        claim_kind: "report",
        polarity: "positive",
      },
      other,
      [],
      ["Mr Ash came in."],
    );
    expect(row.row).toMatchObject({ claimKind: "attribute", kindOverridden: true });
  });

  it("sets the kind to attribute when another person's tenure, age or family is stated, whatever the model said", () => {
    const ask = (text, raw) =>
      checkAssertion(
        { sentence: 1, polarity: "positive", subject_kind: "person", ...raw },
        new Map([[1, { id: "9", ordinal: 1, text }]]),
      ).row;
    const tenure = ask("They had lived at Grenfell Tower for over twenty years.", {
      subject_text: "They",
      predicate: "had lived",
      object_text: "at Grenfell Tower for over twenty years",
      claim_kind: "report",
    });
    expect(tenure).toMatchObject({ claimKind: "attribute", kindOverridden: true });
    const daughter = ask(
      "At the time of the fire I was 40 years old and my daughter was 6 years old",
      {
        subject_text: "my daughter",
        predicate: "was",
        object_text: "6 years old",
        claim_kind: "report",
      },
    );
    expect(daughter.claimKind).toBe("attribute");
    const survived = ask("He survived, as he was not there on the night of the fire.", {
      subject_text: "He",
      predicate: "survived",
      object_text: null,
      claim_kind: "report",
    });
    expect(survived.claimKind).toBe("report");
    const lift = ask("The lift was not working.", {
      subject_text: "The lift",
      subject_kind: "thing",
      predicate: "was not working",
      object_text: null,
      claim_kind: "report",
    });
    expect(lift.claimKind).toBe("report");
  });

  it("asks for the name a pronoun stands for and for the claim kind", () => {
    const prompt = extractPrompt({
      before: null,
      targets: [{ ordinal: 0, text: "A." }],
      after: null,
    });
    expect(prompt).toContain(
      "When the target sentence names the subject by a pronoun such as he, she, they, it or 'this man', subject_text is the name or description of that person or thing, copied exactly from the target sentence or another sentence shown here. Write the pronoun only when no sentence shown here names them.",
    );
    expect(prompt).toContain(
      "claim_kind is attribute when the claim states the age, health, home, years of residence, family or job of the witness or of another person; action when it states what the witness did; observation when it states what the witness saw, heard, smelt, felt, was told or called; report when it states what another person or a thing did or was.",
    );
    expect(prompt).toContain(
      "Examples of claim_kind: 'I was 40 years old at the time of the fire' and 'I have lived in the tower for fifteen years' are attribute, and so are 'They had lived at Grenfell Tower for over twenty years' and 'my daughter was 6 years old'; 'I saw smoke coming under the door' is observation; 'The fire brigade arrived at about 1.10 am' is report.",
    );
    expect(prompt).not.toContain("resolve pronouns");
  });

  it("keeps the name a pronoun stands for from a target or a context sentence", () => {
    expect(checkAssertion({ ...died, subject_text: "Mrs Alder" }, targets).row).toMatchObject({
      sourceChunkId: "22",
      subject_text: "Mrs Alder",
      subjectKind: "person",
    });
    const context = ["Mr Birch lived on the twentieth floor.", null];
    expect(
      checkAssertion({ ...died, subject_text: "Mr Birch" }, targets, [], context).row.subject_text,
    ).toBe("Mr Birch");
    expect(checkAssertion({ ...died, subject_text: "She" }, targets).row.subject_text).toBe("She");
  });

  it("rejects a name from outside the window, or from a neighbour when the sentence has no pronoun", () => {
    expect(checkAssertion({ ...died, subject_text: "Mr Birch" }, targets)).toMatchObject({
      ok: false,
      field: "subject_text",
      reason: "not-in-sentence",
    });
    const fire = { ...died, sentence: 3, subject_text: "Mrs Alder", predicate: "spread" };
    expect(checkAssertion(fire, targets)).toMatchObject({
      ok: false,
      field: "subject_text",
      reason: "not-in-sentence",
    });
    expect(checkAssertion({ ...died, subject_text: "Ald" }, targets).ok).toBe(false);
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

  it("counts the claim kinds it overrides as a stage figure", async () => {
    const store = createFactsStore(seed());
    const lines = [];
    const p = createFakeProvider({
      tokens: [],
      extractJson: () => ({
        assertions: [
          { ...A0, claim_kind: "observation" },
          { ...A1, claim_kind: "report" },
        ],
      }),
    });
    await extractAssertions({
      documentId: "IWS1",
      provider: p,
      db: store,
      log: (line) => lines.push(JSON.parse(line)),
    });
    expect(lines.some((l) => l.stage === "kind-overridden")).toBe(false);
    const age = "I was 40 years old at the time of the fire.";
    const aged = createFactsStore(
      seed({
        sentences: [
          {
            id: "11",
            document_id: "IWS1",
            ordinal: 0,
            text: age,
            header: HEADER,
            context_line: null,
          },
        ],
      }),
    );
    const agedLines = [];
    const q = createFakeProvider({
      tokens: [],
      extractJson: () => ({
        assertions: [
          {
            sentence: 0,
            subject_text: "I",
            subject_kind: "witness",
            claim_kind: "action",
            predicate: "was",
            object_text: "40 years old",
            polarity: "positive",
          },
        ],
      }),
    });
    await extractAssertions({
      documentId: "IWS1",
      provider: q,
      db: aged,
      log: (line) => agedLines.push(JSON.parse(line)),
    });
    expect(agedLines.find((l) => l.stage === "kind-overridden")).toMatchObject({ count: 1 });
    expect(aged.tables.assertions[0].claim_kind).toBe("attribute");
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
        subject_text: "I",
        subject_kind: "witness",
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
        subject_text: null,
        subject_kind: null,
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

  it("offers the shared events of the document's corpus and stores the shared name", async () => {
    const store = createFactsStore(
      seed({ documents: [{ id: "IWS1", witness_id: "IWS1", corpus: "grenfell" }] }),
    );
    const { prompts } = await run(store, {
      0: [{ ...A0, event_text: "The fire starting in Flat 16" }],
    });
    expect(prompts[0]).toContain("'the fire brigade arriving'");
    expect(store.tables.events).toEqual([
      { id: expect.any(String), name: "the fire starting in Flat 16" },
    ]);
  });

  it("stores the claim kind and the register entry a subject names, from the window", async () => {
    const named = "Witness W5 lived on the twentieth floor.";
    const store = createFactsStore(
      seed({
        sentences: [
          { id: "11", document_id: "IWS1", ordinal: 0, text: named },
          { id: "12", document_id: "IWS1", ordinal: 1, text: "She died the following day." },
          { id: "13", document_id: "IWS1", ordinal: 2, text: "He was 80 years old." },
        ],
      }),
    );
    const report = { subject_kind: "person", polarity: "positive", claim_kind: "report" };
    const { result } = await run(store, {
      0: [{ ...report, sentence: 0, subject_text: "Witness W5", predicate: "lived on" }],
      1: [{ ...report, sentence: 1, subject_text: "Witness W5", predicate: "died" }],
      2: [{ ...report, sentence: 2, subject_text: "He", predicate: "was" }],
    });
    expect(result.counts).toMatchObject({ kept: 3, rejected: 0 });
    const cipher = store.tables.entities.find((e) => e.canonical === "W5");
    expect(cipher).toMatchObject({ kind: "person" });
    expect(
      store.tables.assertions.map((a) => [
        a.source_chunk_id,
        a.subject_text,
        a.claim_kind,
        a.subject_entity_id,
      ]),
    ).toEqual([
      ["11", "Witness W5", "attribute", cipher.id],
      ["12", "Witness W5", "report", cipher.id],
      ["13", "He", "report", null],
    ]);
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

  describe("replies cut off at the output limit", () => {
    const store = (count) =>
      createFactsStore({
        documents: [{ id: "IWS1", witness_id: "IWS1" }],
        sentences: Array.from({ length: count }, (_, n) => ({
          id: String(100 + n),
          document_id: "IWS1",
          ordinal: n,
          text: `I saw smoke number ${n}.`,
          header: HEADER,
          context_line: null,
        })),
        witnesses: [{ id: "IWS1", cipher_only: false, aliases: [] }],
      });
    const ordinalsIn = (prompt) => [...prompt.matchAll(/^\[S(\d+)\]/gm)].map((m) => Number(m[1]));
    const answer = (ordinals) => ({
      assertions: ordinals.map((n) => ({
        sentence: n,
        predicate: "saw",
        object_text: `smoke number ${n}`,
        polarity: "positive",
      })),
    });

    it("splits a cut-off window into halves and adds their counts", async () => {
      const db = store(10);
      const seen = [];
      const lines = [];
      const p = createFakeProvider({
        tokens: [],
        extractJson: ({ prompt }) => {
          const ordinals = ordinalsIn(prompt);
          seen.push(ordinals);
          if (ordinals.length === 10) throw new ReplyTruncatedError("m", 9000);
          return answer(ordinals);
        },
      });
      const result = await extractAssertions({
        documentId: "IWS1",
        provider: p,
        db,
        window: 10,
        log: (line) => lines.push(JSON.parse(line)),
        now: () => 0,
      });
      expect(seen.map((o) => o.length)).toEqual([10, 5, 5]);
      expect(result.counts).toMatchObject({ calls: 3, kept: 10, rejected: 0, written: 10 });
      expect(result.windows).toEqual({ done: 1, total: 1 });
      expect(db.tables.assertions).toHaveLength(10);
      expect(lines.filter((l) => l.stage === "window-split")).toEqual([
        {
          evidenceId: "IWS1",
          stage: "window-split",
          window: 0,
          depth: 1,
          sentences: "0-9",
          reason: "truncated",
        },
      ]);
    });

    it("splits a half that is cut off again", async () => {
      const seen = [];
      const p = createFakeProvider({
        tokens: [],
        extractJson: ({ prompt }) => {
          const ordinals = ordinalsIn(prompt);
          seen.push(ordinals.length);
          if (ordinals.length > 2) throw new ReplyTruncatedError("m", 9000);
          return answer(ordinals);
        },
      });
      const result = await extractAssertions({
        documentId: "IWS1",
        provider: p,
        db: store(5),
        window: 5,
        log: () => {},
      });
      expect(seen).toEqual([5, 3, 2, 1, 2]);
      expect(result.counts).toMatchObject({ calls: 5, kept: 5, written: 5 });
    });

    it("fails the document naming the window when one sentence is still cut off", async () => {
      const db = store(4);
      const p = createFakeProvider({
        tokens: [],
        extractJson: ({ prompt }) => {
          const ordinals = ordinalsIn(prompt);
          if (ordinals.includes(2)) throw new ReplyTruncatedError("m", 9000);
          return answer(ordinals);
        },
      });
      await expect(
        extractAssertions({ documentId: "IWS1", provider: p, db, window: 2, log: () => {} }),
      ).rejects.toThrow(/window 1, sentence 2-2: m stopped at its output limit/);
      expect(db.tables.assertions.map((a) => a.source_chunk_id)).toEqual(["100", "101"]);
      expect(db.tables.provenance).toEqual([]);
    });

    it("splits a window whose reply is not valid JSON and logs the reason", async () => {
      const db = store(10);
      const lines = [];
      const seen = [];
      const p = createFakeProvider({
        tokens: [],
        extractJson: ({ prompt }) => {
          const ordinals = ordinalsIn(prompt);
          seen.push(ordinals.length);
          if (ordinals.length === 10) throw new InvalidReplyError("m returned invalid JSON: {");
          return answer(ordinals);
        },
      });
      const result = await extractAssertions({
        documentId: "IWS1",
        provider: p,
        db,
        window: 10,
        log: (line) => lines.push(JSON.parse(line)),
      });
      expect(seen).toEqual([10, 5, 5]);
      expect(result.counts).toMatchObject({ calls: 3, kept: 10, written: 10 });
      expect(lines.filter((l) => l.stage === "window-split")).toEqual([
        {
          evidenceId: "IWS1",
          stage: "window-split",
          window: 0,
          depth: 1,
          sentences: "0-9",
          reason: "invalid",
        },
      ]);
    });

    it("fails the document naming the sentence and the reply when one sentence is still invalid", async () => {
      const db = store(4);
      const p = createFakeProvider({
        tokens: [],
        extractJson: ({ prompt }) => {
          const ordinals = ordinalsIn(prompt);
          if (ordinals.includes(2)) {
            throw new InvalidReplyError('m returned invalid JSON: {"assertions": [ ... ]]');
          }
          return answer(ordinals);
        },
      });
      await expect(
        extractAssertions({ documentId: "IWS1", provider: p, db, window: 2, log: () => {} }),
      ).rejects.toThrow(/window 1, sentence 2-2: m returned invalid JSON: \{"assertions"/);
      expect(db.tables.assertions.map((a) => a.source_chunk_id)).toEqual(["100", "101"]);
    });
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
