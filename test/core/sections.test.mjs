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

  const sentence = (n) => `Sentence number ${n} says something about the stairwell. `;
  const block = (chars) => {
    let text = "";
    for (let n = 0; text.length < chars; n++) text += sentence(n);
    return text.trim();
  };

  it("keeps a numbered paragraph that spans two pages whole", () => {
    const pages = [
      { page: 1, text: `1. ${block(3000)}` },
      { page: 2, text: block(3000) },
      { page: 3, text: "2. Next." },
    ];
    const sections = splitNumberedParagraphs(pages);
    expect(sections.map((s) => [s.paragraph, s.page])).toEqual([
      [1, 1],
      [2, 3],
    ]);
    expect(sections[0].text.length).toBeGreaterThan(6000);
  });

  it("gives unnumbered exhibit pages after a paragraph one section each", () => {
    const pages = [
      { page: 1, text: `1. ${block(500)}` },
      { page: 2, text: block(3000) },
      { page: 3, text: block(3000) },
      { page: 4, text: block(3000) },
      { page: 5, text: block(3000) },
      { page: 6, text: block(3000) },
    ];
    const sections = splitNumberedParagraphs(pages);
    expect(sections.map((s) => [s.paragraph, s.page])).toEqual([
      [1, 1],
      [null, 3],
      [null, 4],
      [null, 5],
      [null, 6],
    ]);
  });

  it("splits a long unnumbered page at blank lines into parts under 6000 characters", () => {
    const text = Array.from({ length: 6 }, () => block(2500)).join("\n\n");
    const sections = splitNumberedParagraphs([{ page: 7, text }]);
    expect(sections).toHaveLength(3);
    for (const s of sections) {
      expect(s.paragraph).toBeNull();
      expect(s.page).toBe(7);
      expect(s.text.length).toBeLessThanOrEqual(6000);
    }
  });

  it("splits a long unnumbered block without blank lines at a sentence end", () => {
    const sections = splitNumberedParagraphs([{ page: 2, text: block(15000) }]);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) {
      expect(s.text.length).toBeLessThanOrEqual(6000);
      expect(s.text.endsWith("stairwell.")).toBe(true);
    }
  });
});
