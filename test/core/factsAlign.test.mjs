// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  KIN_TERMS,
  alignAssertions,
  claimText,
  kinSubject,
  sharedAnchors,
  unnamedSubject,
} from "../../packages/core/facts/align.mjs";

const DATES = {
  IWS00000169: "2017-11-01",
  IWS00000835: "2018-01-10",
  IWS00000913: "2017-12-05",
  IWS00000990: "2018-02-14",
  IWS00001157: "2018-03-20",
};

const TOWER = { objectEntityId: "300", objectEntityKind: "place" };

function claim(id, witnessId, [subjectText, subjectKind], claimKind, predicate, objectText, more) {
  return {
    id,
    witnessId,
    documentId: `${witnessId}-1`,
    statementDate: DATES[witnessId],
    chunkId: `c${id}`,
    eventId: null,
    subjectText,
    subjectKind,
    claimKind,
    subjectEntityId: null,
    subjectWitnessId: null,
    predicate,
    objectText,
    objectEntityId: null,
    objectEntityKind: null,
    timeText: null,
    placeText: null,
    placeEntityId: null,
    polarity: "positive",
    modality: null,
    confidence: 0.9,
    sentence: "",
    ...more,
  };
}

const I = ["I", "witness"];
const WE = ["we", "witness"];
const ATTR = "attribute";
const FIRE = { eventId: "20" };

const FALSE_PAIRS = {
  994: [
    claim("1", "IWS00000913", ["my daughter", "person"], ATTR, "was", "[6] years old", FIRE),
    claim("2", "IWS00000990", ["my daughter", "person"], ATTR, "was", "6 years old", FIRE),
  ],
  1008: [
    claim("3", "IWS00000169", I, ATTR, "have lived", "in Grenfell Tower for fifteen years", TOWER),
    "tenure",
  ],
  1038: [claim("4", "IWS00000913", WE, ATTR, "moved into", "Grenfell Tower", TOWER), "tenure"],
  1046: [
    claim("5", "IWS00000990", I, ATTR, "lived in", "Grenfell Tower with my husband", TOWER),
    "tenure",
  ],
  1041: ["survived", claim("6", "IWS00001157", ["He", "person"], "report", "survived", null, FIRE)],
  1088: [
    claim("7", "IWS00000169", ["he", "person"], "report", "sadly died", "in the fire", FIRE),
    "survived",
  ],
};

const SHARED = {
  tenure: claim(
    "8",
    "IWS00000835",
    ["They", "person"],
    "report",
    "had lived",
    "at Grenfell Tower for over twenty years",
    TOWER,
  ),
  survived: claim("9", "IWS00000913", WE, "action", "survived", null, FIRE),
};

const SIGNS = ["The fire safety signs", "thing"];
const SMOKE = ["The smoke", "thing"];
const LOBBY = { eventId: "21" };
const STAIRS = { eventId: "22" };
const SEEN = "observation";
const MRS_ASH = ["Mrs Ash", "person"];
const ASH = { subjectEntityId: "81" };

const REAL_PAIRS = {
  1045: [
    claim("10", "IWS00000913", SIGNS, "report", "said", "to stay in your flat"),
    claim("11", "IWS00000990", SIGNS, "report", "said", "to call 999 and use the stairs"),
  ],
  1051: [
    claim("12", "IWS00000169", SIGNS, "report", "said", "to stay put"),
    claim("13", "IWS00000990", SIGNS, "report", "said", "to leave the building"),
  ],
  1009: [
    claim("14", "IWS00000913", I, SEEN, "saw", "thick black smoke", LOBBY),
    claim("15", "IWS00000990", I, SEEN, "saw", "light grey smoke", LOBBY),
  ],
  1033: [
    claim("16", "IWS00000169", SMOKE, "report", "was", "thick", { placeText: "the lobby" }),
    claim("17", "IWS00000835", SMOKE, "report", "was", "thin", { placeText: "the lobby" }),
  ],
  1054: [
    claim("18", "IWS00000990", SMOKE, "report", "was coming", "from the lift", LOBBY),
    claim("19", "IWS00001157", SMOKE, "report", "was coming", "from the stairs", LOBBY),
  ],
  1055: [
    claim("20", "IWS00000913", I, SEEN, "saw", "smoke on the stairs", STAIRS),
    claim("21", "IWS00000169", I, SEEN, "saw", "clear stairs", STAIRS),
  ],
  1022: [
    claim("22", "IWS00000913", ["The draught", "thing"], "report", "came", "through the windows"),
    claim("23", "IWS00000990", ["The draught", "thing"], "report", "did not come", "in"),
  ],
  1086: [
    claim("24", "IWS00000913", MRS_ASH, "report", "stayed in hospital", "for two weeks", ASH),
    claim("25", "IWS00000990", MRS_ASH, "report", "stayed in hospital", "for three months", ASH),
  ],
};

const side = (x) => (typeof x === "string" ? SHARED[x] : x);
const pairOf = (sides) => sides.map(side);

function alignAll() {
  const all = new Map();
  for (const sides of [...Object.values(FALSE_PAIRS), ...Object.values(REAL_PAIRS)]) {
    for (const a of pairOf(sides)) all.set(a.id, a);
  }
  const assertions = [...all.values()];
  const same = Float32Array.from([1, 0]);
  const vectors = new Map(assertions.map((a) => [claimText(a), same]));
  return alignAssertions(assertions, vectors, { maxPartners: 100, maxPerGroup: 1000 });
}

const key = (a, b) => [a.id, b.id].sort().join("-");

describe("cross pairs by an unnamed subject or an attribute", () => {
  const { pairs } = alignAll();
  const made = new Set(pairs.map((p) => key(p.a, p.b)));

  it.each(Object.entries(FALSE_PAIRS))("makes no pair for comparison %s", (_, sides) => {
    const [a, b] = pairOf(sides);
    expect(sharedAnchors(a, b)).toEqual([]);
    expect(made.has(key(a, b))).toBe(false);
  });

  it.each(Object.entries(REAL_PAIRS))("keeps the shared-fact pair of comparison %s", (_, sides) => {
    const [a, b] = pairOf(sides);
    expect(sharedAnchors(a, b).length).toBeGreaterThan(0);
    expect(made.has(key(a, b))).toBe(true);
  });

  it("names a person by a pronoun or a possessive kin term only when no entity resolves it", () => {
    for (const text of ["they", "We", "her", "my daughter", "our two children", "his wife's"]) {
      expect(unnamedSubject({ subjectText: text, subjectKind: "person" }), text).toBe(true);
    }
    expect(unnamedSubject({ subjectText: "my family", subjectKind: "group" })).toBe(true);
    for (const text of ["Mrs Ash", "a firefighter", "the daughter", "my daughter's school"]) {
      expect(unnamedSubject({ subjectText: text, subjectKind: "person" }), text).toBe(false);
    }
    expect(
      unnamedSubject({ subjectText: "my daughter", subjectKind: "person", subjectEntityId: "5" }),
    ).toBe(false);
    expect(unnamedSubject({ subjectText: "we", subjectKind: "witness" })).toBe(false);
    expect(KIN_TERMS).toContain("flatmate");
    expect(kinSubject("their neighbours")).toBe(true);
  });

  it("pairs an attribute across witnesses only when both subjects resolve to one entry", () => {
    const [a, b] = FALSE_PAIRS[994];
    const named = { subjectText: "Mrs Ash", subjectEntityId: "81" };
    expect(sharedAnchors({ ...a, ...named }, { ...b, ...named })).toEqual(["subject"]);
    expect(sharedAnchors({ ...a, ...named }, { ...b, ...named, subjectEntityId: "82" })).toEqual(
      [],
    );
    expect(
      sharedAnchors(
        { ...a, subjectText: "Mrs Ash", ...TOWER },
        { ...b, subjectText: "Mrs Ash", ...TOWER },
      ),
    ).toEqual([]);
    const own = FALSE_PAIRS[1008][0];
    const about = { ...SHARED.tenure, subjectText: "Mr Oak", subjectEntityId: "90" };
    expect(sharedAnchors(own, about)).toEqual([]);
    expect(sharedAnchors(own, { ...about, subjectWitnessId: own.witnessId })).toEqual(["subject"]);
  });
});
