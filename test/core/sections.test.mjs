// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { splitNumberedParagraphs } from "../../packages/core/chunking/sections.mjs";

describe("splitNumberedParagraphs", () => {
  it("splits numbered paragraphs and records the start page", () => {
    const pages = [
      "WITNESS STATEMENT\n1. My name is Witness A.\n2. I lived on the\n   eighteenth floor.",
      "3. I woke at 01:00.\n   I smelt smoke.",
    ];
    expect(splitNumberedParagraphs(pages)).toEqual([
      { paragraph: null, page: 1, text: "WITNESS STATEMENT" },
      { paragraph: 1, page: 1, text: "My name is Witness A." },
      { paragraph: 2, page: 1, text: "I lived on the eighteenth floor." },
      { paragraph: 3, page: 2, text: "I woke at 01:00. I smelt smoke." },
    ]);
  });

  it("continues a paragraph across a page break", () => {
    const pages = [
      { page: 4, text: "10. The stairs were dark and" },
      { page: 5, text: "full of smoke.\n11. I reached the ground." },
    ];
    expect(splitNumberedParagraphs(pages)).toEqual([
      { paragraph: 10, page: 4, text: "The stairs were dark and full of smoke." },
      { paragraph: 11, page: 5, text: "I reached the ground." },
    ]);
  });

  it("keeps an out-of-sequence numbered line inside the current paragraph", () => {
    const pages = ["5. I saw three things:\n1. smoke\n2. flames\n6. Then I left."];
    expect(splitNumberedParagraphs(pages)).toEqual([
      { paragraph: 5, page: 1, text: "I saw three things: 1. smoke 2. flames" },
      { paragraph: 6, page: 1, text: "Then I left." },
    ]);
  });

  it("does not treat a decimal or a time at line start as a paragraph", () => {
    const pages = ["1. First.\n2.5 metres away\n01:15 was the time"];
    expect(splitNumberedParagraphs(pages)).toEqual([
      { paragraph: 1, page: 1, text: "First. 2.5 metres away 01:15 was the time" },
    ]);
  });
});
