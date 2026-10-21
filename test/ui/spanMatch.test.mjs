// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { firstSentence, itemBox, matchSpan } from "../../packages/ui/spanMatch.mjs";

const ITEMS = [
  "Statement of Witness",
  "I looked out of the window at",
  "about 01:14 and saw thick",
  "black smoke. We waited in",
  "the hallway.",
].map((str) => ({ str }));

describe("the first sentence of a block", () => {
  it("takes the first sentence, and the next while it is shorter than six words", () => {
    expect(firstSentence("I saw smoke at the window. It was dark. Then we left.")).toBe(
      "I saw smoke at the window.",
    );
    expect(firstSentence("Yes. I saw smoke at the window. It was dark.")).toBe(
      "Yes. I saw smoke at the window.",
    );
    expect(firstSentence("")).toBe("");
    expect(firstSentence(undefined)).toBe("");
  });
});

describe("matching a sentence in the page's text items", () => {
  it("returns every item the longest matching run touches", () => {
    expect(
      matchSpan(ITEMS, "I looked out of the window at about 01:14 and saw thick black smoke."),
    ).toEqual([1, 2, 3]);
  });

  it("ignores case, punctuation and the breaks between items", () => {
    expect(matchSpan(ITEMS, "I LOOKED out of the WINDOW, at about 01:14")).toEqual([1, 2]);
  });

  it("uses the longest run when only part of the sentence is on the page", () => {
    expect(matchSpan(ITEMS, "Residents said we waited in the hallway until morning")).toEqual([
      3, 4,
    ]);
  });

  it("accepts plain strings as items", () => {
    expect(matchSpan(["one two three four"], "two three four")).toEqual([0]);
  });

  it("returns nothing for a run under three words, an empty sentence or an empty page", () => {
    expect(matchSpan(ITEMS, "smoke and fire everywhere")).toEqual([]);
    expect(matchSpan(ITEMS, "")).toEqual([]);
    expect(matchSpan([], "I looked out of the window")).toEqual([]);
  });

  it("matches a sentence shorter than three words in full", () => {
    expect(matchSpan([{ str: "Thank you." }], "Thank you")).toEqual([0]);
  });
});

describe("the box of a text item", () => {
  it("places the item from its baseline, scaled by the viewport", () => {
    const viewport = [2, 0, 0, -2, 0, 1000];
    const item = { transform: [10, 0, 0, 10, 50, 400], width: 100, height: 10 };
    expect(itemBox(viewport, item, 2)).toEqual({ left: 100, top: 180, width: 200, height: 20 });
  });
});
