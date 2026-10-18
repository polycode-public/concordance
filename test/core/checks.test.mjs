// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  citationTags,
  markUnsupported,
  splitAnswerSentences,
} from "../../packages/core/checks/citations.mjs";
import { verifyQuote } from "../../packages/core/checks/quotes.mjs";

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
