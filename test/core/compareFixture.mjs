// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// A dozen assertions from three witnesses with a known timing dispute: two witnesses saw smoke
// in the lobby at about 1.00 am, the third at 1.30 am, and the first witness's later statement
// moves to 1.30 am. The third witness is cipher-only, and their document reveals an identity
// when it is paired with the second witness's document. disputeSeed adds the claims that tell a
// shared event from two people doing the same thing: three witnesses who each went to bed at a
// different time, two who time the fire brigade's arrival differently, one whom nobody told, two
// who each give their own age under one event, two relatives who each say "she died" of a
// different person, and two who read the same fire safety notice differently.

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

const I = ["I", "witness"];
const SEEN = "observation";
const DID = "action";
const ASSERTIONS = [
  // id, chunk, witness, event, predicate, object, time, place, polarity, [subject, kind], claim
  [
    "1",
    "101",
    "IWS-A",
    "7",
    "first saw",
    "smoke",
    "about 1.00 am",
    "the lobby",
    "positive",
    I,
    SEEN,
  ],
  ["2", "102", "IWS-B", "7", "saw", "smoke", "about 1.00 am", "the lobby", "positive", I, SEEN],
  ["3", "103", "C123", "7", "saw", "smoke", "1.30 am", "the lobby", "positive", I, SEEN],
  [
    "4",
    "104",
    "IWS-A",
    "8",
    "did not sound",
    null,
    null,
    null,
    "negative",
    ["The fire alarm", "thing"],
  ],
  [
    "5",
    "105",
    "IWS-B",
    "8",
    "sounded",
    null,
    null,
    "the corridor",
    "positive",
    ["The fire alarm", "thing"],
  ],
  ["6", "106", "IWS-A", "7", "first saw", "smoke", "1.30 am", "the lobby", "positive", I, SEEN],
  ["7", "107", "IWS-B", "9", "left", "the flat", null, null, "positive", I, DID],
  [
    "8",
    "108",
    "C123",
    "9",
    "left",
    "the flat",
    "2.10 am",
    null,
    "positive",
    ["We", "witness"],
    DID,
  ],
  ["9", "109", "IWS-A", null, "were dark", null, null, null, "positive", ["The stairs", "thing"]],
  [
    "10",
    "110",
    "C123",
    null,
    "were full of smoke",
    null,
    null,
    null,
    "positive",
    ["The stairs", "thing"],
  ],
  ["11", "111", "IWS-B", null, "told", "us", null, null, "positive", ["A firefighter", "person"]],
  ["12", "112", "IWS-A", null, "told", "us", null, null, "positive", ["A firefighter", "person"]],
];

const DISPUTE_SENTENCES = [
  ["113", "IWS-A1", 4, 3, 10, "I went to bed at about 10pm."],
  ["114", "IWS-B1", 5, 5, 3, "I went to bed around 11pm."],
  ["115", "C123-1", 4, 2, 9, "I went to bed at around 1 to 1.15 am."],
  ["116", "IWS-A1", 5, 3, 11, "The fire brigade arrived at about 1.10 am."],
  ["117", "IWS-B1", 6, 5, 4, "The fire brigade arrived at 1.40 am."],
  ["118", "C123-1", 5, 2, 10, "Nobody told me that."],
  ["119", "IWS-A1", 6, 4, 1, "At the time of the fire I was 40 years old."],
  ["120", "IWS-B1", 7, 6, 1, "I was 42years old at the time of the fire."],
  ["121", "IWS-A1", 7, 4, 2, "Mrs Alder was carried down the stairs by a firefighter."],
  ["122", "IWS-A1", 8, 4, 3, "She died the following day."],
  ["123", "IWS-B1", 8, 6, 2, "She died in January 2018."],
  [
    "124",
    "IWS-A1",
    9,
    5,
    1,
    "The fire safety notice said that residents should stay in their flat.",
  ],
  ["125", "C123-1", 6, 3, 1, "The fire safety notice said to call 999 and to use the stairs."],
  ["126", "IWS-A1", 10, 4, 4, "I have lived in Grenfell Tower for fifteen years."],
  ["127", "IWS-B1", 8, 6, 3, "I have lived in the tower for over twenty years."],
];

const DISPUTE_ASSERTIONS = [
  ["13", "113", "IWS-A", null, "went to bed", null, "about 10pm", null, "positive", I, DID],
  ["14", "114", "IWS-B", null, "went to bed", null, "around 11pm", null, "positive", I, DID],
  ["15", "115", "C123", null, "went to bed", null, "around 1 to 1.15 am", null, "positive", I, DID],
  [
    "16",
    "116",
    "IWS-A",
    "10",
    "arrived",
    null,
    "about 1.10 am",
    null,
    "positive",
    ["The fire brigade", "group"],
  ],
  [
    "17",
    "117",
    "IWS-B",
    "10",
    "arrived",
    null,
    "1.40 am",
    null,
    "positive",
    ["The fire brigade", "group"],
  ],
  ["18", "118", "C123", null, "told", "me", null, null, "negative", ["Nobody", "person"]],
  ["19", "119", "IWS-A", "11", "was", "40 years old", null, null, "positive", I, "attribute"],
  ["20", "120", "IWS-B", "11", "was", "42years old", null, null, "positive", I, "attribute"],
  ["21", "122", "IWS-A", null, "died", null, null, null, "positive", ["Mrs Alder", "person"]],
  ["22", "123", "IWS-B", null, "died", null, null, null, "positive", ["She", "person"]],
  [
    "23",
    "124",
    "IWS-A",
    null,
    "said",
    "that residents should stay in their flat",
    null,
    null,
    "positive",
    ["The fire safety notice", "thing"],
  ],
  [
    "24",
    "125",
    "C123",
    null,
    "said",
    "to call 999 and to use the stairs",
    null,
    null,
    "positive",
    ["The fire safety notice", "thing"],
  ],
];

const RESIDENCE = [
  ["25", "126", "IWS-A", "11", "have lived", "in Grenfell Tower for fifteen years", I],
  ["26", "127", "IWS-B", "11", "have lived", "in the tower for over twenty years", I],
].map(([id, chunk, witness, event, predicate, object, subject]) => [
  id,
  chunk,
  witness,
  event,
  predicate,
  object,
  null,
  null,
  "positive",
  subject,
  "attribute",
]);

const chunkRow = ([id, document_id, ordinal, page, paragraph, text]) => ({
  id,
  document_id,
  level: "sentence",
  ordinal,
  text,
  locator: { page, paragraph },
});

const assertionRow = ([
  id,
  chunk,
  witness,
  event,
  predicate,
  object,
  time,
  place,
  polarity,
  [subject, kind],
  claim = kind === "witness" ? null : "report",
]) => ({
  id,
  witness_id: witness,
  source_chunk_id: chunk,
  event_id: event,
  subject_text: subject,
  subject_kind: kind,
  claim_kind: claim,
  subject_entity_id: null,
  predicate,
  object_text: object,
  object_entity_id: null,
  time_text: time,
  time_start: null,
  time_end: null,
  place_text: place,
  place_entity_id: null,
  polarity,
  modality: /^(about|around)/.test(time ?? "") ? time.split(" ")[0] : null,
  confidence: 0.9,
  extractor: "fake-extract",
  pipeline_version: "facts-v1",
});

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
    chunks: SENTENCES.map(chunkRow),
    assertions: ASSERTIONS.map(assertionRow),
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

/**
 * compareSeed with the claims of six more matters: bed times, the brigade, nobody told, two
 * witnesses' own ages, two deaths, and the fire safety notice.
 */
export function disputeSeed() {
  const seed = compareSeed();
  seed.chunks.push(...DISPUTE_SENTENCES.map(chunkRow));
  seed.assertions.push(...[...DISPUTE_ASSERTIONS, ...RESIDENCE].map(assertionRow));
  seed.events.push(
    { id: "10", name: "the fire brigade arriving" },
    { id: "11", name: "the time of the fire" },
  );
  return seed;
}

const DIRECTIONS = [
  ["notice", [0, 0, 0, 0, 0, 0, 0, 0, 1]],
  ["stairs", [0, 0, 0, 1, 0, 0, 0, 0, 0]],
  ["told", [0, 0, 0.6, 0.8, 0, 0, 0, 0, 0]],
  ["smoke", [1, 0, 0, 0, 0, 0, 0, 0, 0]],
  ["alarm", [0, 1, 0, 0, 0, 0, 0, 0, 0]],
  ["flat", [0, 0, 1, 0, 0, 0, 0, 0, 0]],
  ["bed", [0, 0, 0, 0, 1, 0, 0, 0, 0]],
  ["brigade", [0, 0, 0, 0, 0, 1, 0, 0, 0]],
  ["years old", [0, 0, 0, 0, 0, 0, 1, 0, 0]],
  ["died", [0, 0, 0, 0, 0, 0, 0, 1, 0]],
];

/**
 * One direction per topic, so similar claims share a vector and the rest are orthogonal. The bed
 * times, the ages and the deaths each share one vector, so only the anchors keep them apart.
 */
export function embedFor(text) {
  const t = text.toLowerCase();
  const hit = DIRECTIONS.find(([word]) => t.includes(word));
  return hit ? [...hit[1]] : [0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0];
}

/** The model's labels by the A sentence of a pair: label and the two verbatim spans. */
export const MODEL_LABELS = {
  "The fire alarm did not sound.": ["contradict", "did not sound", "sounded"],
  "I left the flat with my children.": ["agree", "left the flat", "left the flat"],
  "The stairs were dark.": ["unrelated", "were dark", "were full of smoke"],
  "The fire safety notice said that residents should stay in their flat.": [
    "contradict",
    "residents should stay in their flat",
    "call 999 and to use the stairs",
  ],
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
