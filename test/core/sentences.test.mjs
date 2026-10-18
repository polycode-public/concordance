// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { splitSentences } from "../../packages/core/chunking/sentences.mjs";

describe("splitSentences", () => {
  it("splits plain sentences on terminal punctuation", () => {
    expect(splitSentences("I woke up. The alarm was ringing! Was it real?")).toEqual([
      "I woke up.",
      "The alarm was ringing!",
      "Was it real?",
    ]);
  });

  it("keeps titles with the name that follows", () => {
    expect(splitSentences("I spoke to Mr. Smith and Mrs. Jones. Dr. Patel arrived.")).toEqual([
      "I spoke to Mr. Smith and Mrs. Jones.",
      "Dr. Patel arrived.",
    ]);
  });

  it("does not split on No. and para. references", () => {
    expect(splitSentences("See exhibit No. 4 and para. 12 of my statement. Then I left.")).toEqual([
      "See exhibit No. 4 and para. 12 of my statement.",
      "Then I left.",
    ]);
  });

  it("does not split decimals or clock times", () => {
    expect(splitSentences("At 01:15 the smoke was 2.5 metres thick. At 01.30 I left.")).toEqual([
      "At 01:15 the smoke was 2.5 metres thick.",
      "At 01.30 I left.",
    ]);
  });

  it("keeps single initials with the surname", () => {
    expect(splitSentences("Officer J. Brown spoke to me. He was calm.")).toEqual([
      "Officer J. Brown spoke to me.",
      "He was calm.",
    ]);
  });

  it("keeps closing quotes with the sentence and collapses whitespace", () => {
    expect(splitSentences('He said "get out now."\n  We   ran.')).toEqual([
      'He said "get out now."',
      "We ran.",
    ]);
  });

  it("returns an empty list for empty text", () => {
    expect(splitSentences("  \n ")).toEqual([]);
  });
});
