// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  citationTags,
  markUnsupported,
  splitAnswerSentences,
} from "../../packages/core/checks/citations.mjs";
import { verifyQuote } from "../../packages/core/checks/quotes.mjs";

const RECORDED_ANSWER = [
  "The corpus does not say when residents on floors 16 to 20 first saw smoke outside their windows.",
  "The evidence provided covers residents from floor 16 only, and their accounts focus on smoke in the corridors and stairwells rather than outside their windows [E1][E3][E4].",
  "One floor 16 resident looked out of windows at approximately 1.00-1.15 am and saw three fire engines below but no smoke or flames at that time [E1].",
  "The same resident later woke around 1.30 am to a popping sound and saw an orange streak on the building's exterior, then moved to different windows to investigate, eventually seeing fire along the whole length of the building from the 19th floor down to the bottom [E1].",
  "Another floor 16 resident saw burning debris falling from above when looking out of a window, and noted smoke coming from above and below outside the windows, but the timing of these observations is not specified [E5].",
  "The corpus does not contain evidence about residents on floors 17 to 20, nor does it provide clear information about when floor 16 residents first observed smoke specifically outside their windows [E1][E3][E4][E5].",
].join("\n\n");

describe("citationTags", () => {
  it("extracts evidence numbers in order without repeats", () => {
    expect(citationTags("Smoke was seen at 01:15 [E3][E1] and again [E3].")).toEqual([3, 1]);
  });

  it("returns nothing for an untagged sentence", () => {
    expect(citationTags("The corpus does not say.")).toEqual([]);
  });
});

describe("splitAnswerSentences", () => {
  it("keeps a tag written after the full stop with its sentence", () => {
    expect(splitAnswerSentences("She left by the stairs. [E2] He stayed. [E4]")).toEqual([
      "She left by the stairs. [E2]",
      "He stayed. [E4]",
    ]);
  });

  it("splits sentences with tags before the full stop", () => {
    expect(splitAnswerSentences("Mr. Smith left [E1]. Then the lift failed [E2].")).toEqual([
      "Mr. Smith left [E1].",
      "Then the lift failed [E2].",
    ]);
  });

  it("counts every sentence of a Markdown answer whose tags close the paragraph", () => {
    const result = markUnsupported(RECORDED_ANSWER);
    expect(result.total).toBe(6);
    expect(result.supported).toBe(5);
  });

  it("starts a sentence at a blank line, a bullet and a colon-ended lead", () => {
    const text =
      "Residents described leaving their flats:\n\n- One used the stairs [E1]\n- Another waited [E2]\n";
    expect(splitAnswerSentences(text)).toEqual([
      "Residents described leaving their flats:",
      "One used the stairs [E1]",
      "Another waited [E2]",
    ]);
    expect(markUnsupported(text).supported).toBe(2);
  });

  it("keeps a tag on its own line with the sentence above", () => {
    expect(splitAnswerSentences("She left\n[E2]\nHe stayed [E3]")).toEqual([
      "She left [E2]",
      "He stayed [E3]",
    ]);
  });

  it("does not split a time range, a clock time or a page reference", () => {
    const text = "At 1.00-1.15 am he rang 999 at 02:10, see p.13 [E1].";
    expect(splitAnswerSentences(text)).toEqual([text]);
  });
});

describe("markUnsupported", () => {
  it("flags sentences without a tag and reports the flagged ratio", () => {
    const result = markUnsupported("A was seen [E1]. B happened. C followed [E2]. D is likely.");
    expect(result.sentences.map((s) => s.supported)).toEqual([true, false, true, false]);
    expect(result.supported).toBe(2);
    expect(result.total).toBe(4);
    expect(result.flaggedRatio).toBe(0.5);
  });

  it("reports zero flagged for an empty answer", () => {
    expect(markUnsupported("")).toMatchObject({ total: 0, supported: 0, flaggedRatio: 0 });
  });
});

describe("verifyQuote", () => {
  it("matches across whitespace, curly quotes and dashes", () => {
    const chunk = "He shouted “get out” — and we\n  ran to the stairs.";
    expect(verifyQuote('"get out" - and we ran', chunk)).toBe(true);
  });

  it("matches across Unicode compatibility forms", () => {
    expect(verifyQuote("ﬁre door", "the fire door was open")).toBe(true);
  });

  it("rejects a quote that is not in the chunk", () => {
    expect(verifyQuote("the lift worked", "the lift did not work")).toBe(false);
  });

  it("rejects an empty quote", () => {
    expect(verifyQuote("  ", "anything")).toBe(false);
  });
});

describe("joined citation tags", () => {
  it("reads [E3, E4] and [E3][E4] as two tags", () => {
    expect(citationTags("Both saw it [E3, E4].")).toEqual([3, 4]);
    expect(citationTags("Both saw it [E3][E4].")).toEqual([3, 4]);
    expect(citationTags("Both saw it [E3, 4].")).toEqual([3, 4]);
  });

  it("counts a sentence ending in [E3, E4] as supported", () => {
    const result = markUnsupported("They left together [E3, E4].");
    expect(result.supported).toBe(1);
  });

  it("keeps a joined tag written after the full stop with its sentence", () => {
    expect(splitAnswerSentences("She left. [E2, E3] He stayed. [E4]")).toEqual([
      "She left. [E2, E3]",
      "He stayed. [E4]",
    ]);
  });
});
