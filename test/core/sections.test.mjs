// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { readFileSync } from "node:fs";
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

  describe("paragraph number shapes", () => {
    const paragraphs = (pages) => splitNumberedParagraphs(pages).map((s) => [s.paragraph, s.text]);

    it("starts a paragraph at a number alone on its line", () => {
      expect(paragraphs(["1. First.\n2.\nSecond starts here.\n3. Third."])).toEqual([
        [1, "First."],
        [2, "Second starts here."],
        [3, "Third."],
      ]);
    });

    it("starts a paragraph when OCR turns the opening I into a 1 glued to the number", () => {
      expect(paragraphs(["11. First.\n12.1 opened the window.\n13. Third."])).toEqual([
        [11, "First."],
        [12, "1 opened the window."],
        [13, "Third."],
      ]);
    });

    it("starts a paragraph when OCR turns the opening I into a symbol glued to the number", () => {
      expect(paragraphs(["18. First.\n19.} had used up my data.\n20. Third."])).toEqual([
        [18, "First."],
        [19, "} had used up my data."],
        [20, "Third."],
      ]);
    });

    it("starts a paragraph at a number followed by a comma", () => {
      expect(paragraphs(["2. First.\n3, I was born in May.\n4, My father was a lawyer."])).toEqual([
        [2, "First."],
        [3, "I was born in May."],
        [4, "My father was a lawyer."],
      ]);
    });

    it("starts a paragraph at a number after tabs or several spaces", () => {
      expect(paragraphs(["1.\tFirst.\n2.    Second.\n   3.   Third in a column."])).toEqual([
        [1, "First."],
        [2, "Second."],
        [3, "Third in a column."],
      ]);
    });

    it("accepts a number that skips ahead past a number OCR lost", () => {
      expect(paragraphs(["1. First.\n2. Second.\n4. Fourth.\n7. Seventh."])).toEqual([
        [1, "First."],
        [2, "Second."],
        [4, "Fourth."],
        [7, "Seventh."],
      ]);
    });

    it("keeps a number that skips further than the limit inside the paragraph", () => {
      expect(paragraphs(["1. First.\n9. Not a paragraph."])).toEqual([
        [1, "First. 9. Not a paragraph."],
      ]);
    });

    it("keeps a number that does not advance inside the paragraph", () => {
      expect(paragraphs(["6. Six.\n1. I moved in.\n8. Eight."])).toEqual([
        [6, "Six. 1. I moved in."],
        [8, "Eight."],
      ]);
    });

    it("keeps a bracketed list number and a time inside the paragraph", () => {
      expect(paragraphs(["49. Questions:\n1) Poles?\n2) Wires?\n1.31am we left."])).toEqual([
        [49, "Questions: 1) Poles? 2) Wires? 1.31am we left."],
      ]);
    });

    it("drops a numbered paragraph that has no text", () => {
      expect(paragraphs(["1. First.\n2.\n3.\n4. Fourth."])).toEqual([
        [1, "First."],
        [4, "Fourth."],
      ]);
    });
  });

  describe("statement fixtures", () => {
    const load = (name) =>
      readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")
        .split("\f")
        .map((text, i) => ({ page: i + 1, text }));
    const numbers = (name) =>
      splitNumberedParagraphs(load(name))
        .filter((s) => s.paragraph !== null)
        .map((s) => s.paragraph);
    const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

    it("finds paragraphs 1, 2 and 4 to 12 of IWS00000990 pages 1 to 2", () => {
      expect(numbers("IWS00000990-pages-1-2.txt")).toEqual([1, 2, ...range(4, 12)]);
    });

    it("finds paragraphs 10 to 20 of IWS00000913 pages 3 to 4", () => {
      expect(numbers("IWS00000913-pages-3-4.txt")).toEqual(range(10, 20));
    });

    it("finds paragraphs 1 to 6, 10 and 11 of IWS00000490 pages 1 to 2", () => {
      expect(numbers("IWS00000490-pages-1-2.txt")).toEqual([...range(1, 6), 10, 11]);
    });

    it("places each IWS00000913 paragraph on the page where it starts", () => {
      const sections = splitNumberedParagraphs(load("IWS00000913-pages-3-4.txt"));
      expect(sections.map((s) => s.page)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    });
  });
});
