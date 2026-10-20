// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// A dozen assertions from three witnesses with a known timing dispute: two witnesses saw smoke
// in the lobby at about 1.00 am, the third at 1.30 am, and the first witness's later statement
// moves to 1.30 am. The third witness is cipher-only, and their document reveals an identity
// when it is paired with the second witness's document.

import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";

export const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
export const OTHER_SESSION = "0d9a7e44-1c2b-4f3a-9e8d-7c6b5a4f3e2d";

const SENTENCES = [
  // id, document, ordinal, page, paragraph, text
  ["101", "IWS-A1", 1, 2, 5, "I first saw smoke in the lobby at about 1.00 am."],
  ["102", "IWS-B1", 1, 3, 7, "I saw smoke in the lobby at about 1.00 am when I opened the door."],
  ["103", "C123-1", 1, 1, 4, "I saw smoke in the lobby at 1.30 am."],
  ["104", "IWS-A1", 2, 2, 6, "The fire alarm did not sound."],
  ["105", "IWS-B1", 2, 3, 8, "The fire alarm sounded in the corridor."],
  ["106", "IWS-A2", 1, 1, 3, "I first saw smoke in the lobby at 1.30 am."],
  ["107", "IWS-B1", 3, 4, 9, "I left the flat with my children."],
  ["108", "C123-1", 2, 2, 6, "We left the flat at 2.10 am."],
  ["109", "IWS-A1", 3, 3, 9, "The stairs were dark."],
  ["110", "C123-1", 3, 2, 8, "The stairs were full of smoke."],
  ["111", "IWS-B1", 4, 5, 2, "A firefighter told us to stay put."],
  ["112", "IWS-A2", 2, 2, 4, "A firefighter told us to stay in the flat."],
];

const ASSERTIONS = [
  // id, chunk, witness, event, predicate, object, time, place, polarity
  ["1", "101", "IWS-A", "7", "first saw", "smoke", "about 1.00 am", "the lobby", "positive"],
  ["2", "102", "IWS-B", "7", "saw", "smoke", "about 1.00 am", "the lobby", "positive"],
  ["3", "103", "C123", "7", "saw", "smoke", "1.30 am", "the lobby", "positive"],
  ["4", "104", "IWS-A", "8", "did not sound", "The fire alarm", null, null, "negative"],
  ["5", "105", "IWS-B", "8", "sounded", "The fire alarm", null, "the corridor", "positive"],
  ["6", "106", "IWS-A", "7", "first saw", "smoke", "1.30 am", "the lobby", "positive"],
  ["7", "107", "IWS-B", "9", "left", "the flat", null, null, "positive"],
  ["8", "108", "C123", "9", "left", "the flat", "2.10 am", null, "positive"],
  ["9", "109", "IWS-A", null, "were dark", "The stairs", null, null, "positive"],
  ["10", "110", "C123", null, "were full of smoke", "The stairs", null, null, "positive"],
  ["11", "111", "IWS-B", null, "told", "us", null, null, "positive"],
  ["12", "112", "IWS-A", null, "told", "us", null, null, "positive"],
];

/** Fresh seed rows for createCompareStore. */
export function compareSeed() {
  return {
    witnesses: [
      { id: "IWS-A", cipher_only: false, role: "Resident", aliases: [] },
      { id: "IWS-B", cipher_only: false, role: "Resident", aliases: [] },
      { id: "C123", cipher_only: true, role: "Firefighter", aliases: [] },
    ],
    documents: [
      { id: "IWS-A1", corpus: "grenfell", witness_id: "IWS-A", statement_date: "2017-09-01" },
      { id: "IWS-A2", corpus: "grenfell", witness_id: "IWS-A", statement_date: "2018-03-01" },
      { id: "IWS-B1", corpus: "grenfell", witness_id: "IWS-B", statement_date: "2017-11-20" },
      { id: "C123-1", corpus: "grenfell", witness_id: "C123", statement_date: "2018-01-15" },
    ],
    chunks: SENTENCES.map(([id, document_id, ordinal, page, paragraph, text]) => ({
      id,
      document_id,
      level: "sentence",
      ordinal,
      text,
      locator: { page, paragraph },
    })),
    assertions: ASSERTIONS.map(
      ([id, chunk, witness, event, predicate, object, time, place, polarity]) => ({
        id,
        witness_id: witness,
        source_chunk_id: chunk,
        event_id: event,
        predicate,
        object_text: object,
        object_entity_id: null,
        time_text: time,
        time_start: null,
        time_end: null,
        place_text: place,
        place_entity_id: null,
        polarity,
        modality: time?.startsWith("about") ? "about" : null,
        confidence: 0.9,
        extractor: "fake-extract",
        pipeline_version: "facts-v1",
      }),
    ),
    events: [
      { id: "7", name: "smoke in the lobby" },
      { id: "8", name: "the fire alarm" },
      { id: "9", name: "leaving the flat" },
    ],
    facts: [],
    sessions: [
      { id: SESSION, user_id: "sub-1" },
      { id: OTHER_SESSION, user_id: "sub-2" },
    ],
    identityPairs: [
      { document_a: "C123-1", document_b: "IWS-B1", reason: "fixture", marked_by: "test" },
    ],
  };
}

/** One direction per topic, so similar claims share a vector and the rest are orthogonal. */
export function embedFor(text) {
  const t = text.toLowerCase();
  if (t.includes("stairs")) return [0, 0, 0, 1];
  if (t.includes("told")) return [0, 0, 0.6, 0.8];
  if (t.includes("smoke")) return [1, 0, 0, 0];
  if (t.includes("alarm")) return [0, 1, 0, 0];
  if (t.includes("flat")) return [0, 0, 1, 0];
  return [0.5, 0.5, 0.5, 0.5];
}

/** The model's labels by the A sentence of a pair: label and the two verbatim spans. */
export const MODEL_LABELS = {
  "The fire alarm did not sound.": ["contradict", "did not sound", "sounded"],
  "I left the flat with my children.": ["agree", "left the flat", "left the flat"],
  "The stairs were dark.": ["unrelated", "were dark", "were full of smoke"],
};

/** Reads the pairs back out of an nliPrompt. */
export function promptPairs(prompt) {
  const pairs = [];
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^Pair (\d+)$/.exec(lines[i]);
    if (m) pairs.push({ pair: Number(m[1]), a: lines[i + 1].slice(3), b: lines[i + 2].slice(3) });
  }
  return pairs;
}

/** A fake provider whose model pass answers from MODEL_LABELS, or from `answer` when given. */
export function compareProvider({ answer } = {}) {
  const prompts = [];
  const provider = createFakeProvider({
    tokens: [],
    embedFor,
    extractJson: ({ prompt }) => {
      prompts.push(prompt);
      const pairs = promptPairs(prompt);
      if (answer) return answer(pairs, prompt);
      return {
        labels: pairs.map(({ pair, a }) => {
          const [label, span_a, span_b] = MODEL_LABELS[a] ?? ["unrelated", a, a];
          return { pair, label, reason: `fixture reason for ${label}`, span_a, span_b };
        }),
      };
    },
  });
  return { provider, prompts };
}
