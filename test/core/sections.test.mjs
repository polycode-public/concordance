// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_SECTION_CHARS,
  splitNumberedParagraphs,
} from "../../packages/core/chunking/sections.mjs";

describe("splitNumberedParagraphs", () => {
  it("splits numbered paragraphs and records the start page", () => {
    const pages = [
      "WITNESS STATEMENT\n1. My name is Witness A.\n2. I lived on the\n   eighteenth floor.",
      "3. I woke at 01:00.\n   I smelt smoke.",
    ];
    expect(splitNumberedParagraphs(pages)).toEqual([
      { paragraph: 1, page: 1, text: "My name is Witness A.", heading: "WITNESS STATEMENT" },
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

  describe("footer and headings", () => {
    const footer = "Jo Smith 1\nIWS00000001 0001";

    it("drops a footer of the learnt pattern and keeps a page whose footer differs", () => {
      const pages = [
        { page: 1, text: `1. First.\n${footer}` },
        { page: 2, text: "2. Second.\nJo Smith 2\nIWS00000002 0002" },
      ];
      expect(splitNumberedParagraphs(pages).map((s) => s.text)).toEqual([
        "First.",
        "Second. Jo Smith 2 IWS00000002 0002",
      ]);
    });

    it("drops a footer that gives the page number before the name", () => {
      const pages = [{ page: 1, text: "1. First.\n7\nJO SMITH\nIWS00000001_0001" }];
      expect(splitNumberedParagraphs(pages)).toEqual([{ paragraph: 1, page: 1, text: "First." }]);
    });

    it("drops nothing when the first page shows no footer", () => {
      const pages = [{ page: 1, text: "1. First.\nJo Smith 1" }];
      expect(splitNumberedParagraphs(pages)[0].text).toBe("First. Jo Smith 1");
    });

    it("keeps a short line inside the paragraph when no numbered paragraph follows it", () => {
      const pages = [{ page: 1, text: "1. First.\nThe end of it all" }];
      expect(splitNumberedParagraphs(pages)[0].text).toBe("First. The end of it all");
    });

    it("keeps a lower-case wrapped line before a paragraph in the paragraph", () => {
      const pages = [{ page: 1, text: "1. First and\nthe thick\n2. Second." }];
      expect(splitNumberedParagraphs(pages)[0].text).toBe("First and the thick");
    });

    it("carries a heading over a numbered paragraph that has no text", () => {
      const pages = [{ page: 1, text: "1. First.\n2.\nTravel\n3.\n4. Fourth." }];
      expect(splitNumberedParagraphs(pages)).toEqual([
        { paragraph: 1, page: 1, text: "First." },
        { paragraph: 4, page: 1, text: "Fourth.", heading: "Travel" },
      ]);
    });
  });

  describe("statement form without numbered paragraphs", () => {
    const pages = readFileSync(
      new URL("../fixtures/MG11-unnumbered-pages-1-3.txt", import.meta.url),
      "utf8",
    )
      .split("\f")
      .map((text, i) => ({ page: i + 1, text }));

    it("drops the marking, statement and page lines at the top of every page", () => {
      const text = splitNumberedParagraphs(pages)
        .map((s) => s.text)
        .join("\n");
      expect(text).not.toMatch(/RESTRICTED|OFFICIAL|Statement of|Page \d/);
    });

    it("records the witness name as the heading once", () => {
      const sections = splitNumberedParagraphs(pages);
      expect(sections.filter((s) => s.heading).map((s) => [s.page, s.heading])).toEqual([
        [1, "ADAMS, YVONNE"],
      ]);
    });

    it("keeps one section per page with a null paragraph", () => {
      const sections = splitNumberedParagraphs(pages);
      expect(sections.map((s) => [s.page, s.paragraph])).toEqual([
        [1, null],
        [2, null],
        [3, null],
      ]);
      expect(sections[1].text).toMatch(/^the first caller .* The caller gave both\. On answering/);
    });

    it("cuts a long page at paragraph ends before sentence ends", () => {
      const long = (word) => `${`${word} `.repeat(14).trim()}.`;
      const paragraph = [long("alpha"), long("beta"), "A short end."].join("\n");
      const text = Array.from({ length: 80 }, () => paragraph).join("\n");
      const sections = splitNumberedParagraphs([{ page: 1, text }]);
      expect(sections.length).toBeGreaterThan(1);
      for (const s of sections) {
        expect(s.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
        expect(s.text.endsWith("A short end.")).toBe(true);
      }
    });

    it("drops a repeated header line on a numbered statement", () => {
      const pages = [
        { page: 1, text: "OFFICIAL\nStatement of: DOE, JANE FormMG11(T)\nPage 1 of 2\n1. First." },
        { page: 2, text: "OFFICIAL\nStatement of: DOE, JANE FormMG11(T)\nPage 2 of 2\n2. Second." },
      ];
      expect(splitNumberedParagraphs(pages)).toEqual([
        { paragraph: 1, page: 1, text: "First.", heading: "DOE, JANE" },
        { paragraph: 2, page: 2, text: "Second." },
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

    it("finds paragraphs 1 to 5, 10 and 11 of IWS00000490 pages 1 to 2", () => {
      expect(numbers("IWS00000490-pages-1-2.txt")).toEqual([...range(1, 5), 10, 11]);
    });

    it("leaves the footer out of every section of IWS00000490", () => {
      const sections = splitNumberedParagraphs(load("IWS00000490-pages-1-2.txt"));
      for (const s of sections) expect(s.text).not.toMatch(/IWS00000490|Behailu Kebede \d/);
      expect(sections.find((s) => s.paragraph === 5).text).toMatch(/memories of my childhood\.$/);
      expect(sections.find((s) => s.paragraph === 11).text).toMatch(/look after them\.$/);
    });

    it("makes the section lines of IWS00000490 the headings of the paragraphs after them", () => {
      const sections = splitNumberedParagraphs(load("IWS00000490-pages-1-2.txt"));
      const headings = sections.filter((s) => s.heading).map((s) => [s.paragraph, s.heading]);
      expect(headings).toEqual([
        [1, "STATEMENT OF BEHAILU KEBEDE"],
        [3, "Ethiopia"],
        [10, "Coming to the UK"],
        [11, "Living at Grenfell Tower"],
      ]);
      expect(sections.find((s) => s.paragraph === 2).text).toMatch(/since then\.$/);
    });

    it("leaves the footer and the page number out of IWS00000913 and IWS00000990", () => {
      for (const name of ["IWS00000913-pages-3-4.txt", "IWS00000990-pages-1-2.txt"]) {
        for (const s of splitNumberedParagraphs(load(name))) {
          expect(s.text).not.toMatch(/IWS0000\d{4} \d{4}|Richard FLETCHER|Hime GASHAW/);
        }
      }
    });

    it("heads IWS00000913 paragraph 15 and IWS00000990 paragraphs 1 and 11", () => {
      const heading = (name, n) =>
        splitNumberedParagraphs(load(name)).find((s) => s.paragraph === n).heading;
      expect(heading("IWS00000913-pages-3-4.txt", 15)).toBe("THE MORNING OF 14 JUNE 2017");
      expect(heading("IWS00000990-pages-1-2.txt", 1)).toBe("INTRODUCTION");
      expect(heading("IWS00000990-pages-1-2.txt", 11)).toBe("The Morning of the 14 June 2017");
    });

    it("places each IWS00000913 paragraph on the page where it starts", () => {
      const sections = splitNumberedParagraphs(load("IWS00000913-pages-3-4.txt"));
      expect(sections.map((s) => s.page)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    });
  });
});
