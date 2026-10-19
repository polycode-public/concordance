// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chipInline, renderMarkdown } from "../../packages/ui/markdown.mjs";

class Node_ {
  constructor(tag, text) {
    this.tag = tag;
    this.text = text;
    this.children = [];
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
}

/** Serialises a node tree as tag(children), text as quoted strings. */
const show = (node) =>
  node.tag === "#text"
    ? JSON.stringify(node.text)
    : `${node.tag}(${node.children.map(show).join(" ")})`;

const original = globalThis.document;
beforeAll(() => {
  globalThis.document = {
    createElement: (tag) => new Node_(tag),
    createTextNode: (text) => new Node_("#text", text),
  };
});
afterAll(() => {
  globalThis.document = original;
});

const chip = (n) => new Node_("chip", String(n));
const render = (text) => renderMarkdown(text, chipInline(chip)).map(show);

describe("renderMarkdown", () => {
  it("makes a paragraph per blank-line block and a br per single newline", () => {
    expect(render("One.\nTwo.\n\nThree.")).toEqual([`p("One." br() "Two.")`, `p("Three.")`]);
  });

  it("makes a list from dash lines and ends it at a blank line", () => {
    expect(render("- a\n- b\n\nafter")).toEqual([`ul(li("a") li("b"))`, `p("after")`]);
  });

  it("makes strong from **bold**", () => {
    expect(render("**Head:** body")).toEqual([`p(strong("Head:") " body")`]);
  });

  it("puts chips in place, two for a joined tag", () => {
    expect(render("- seen [E3, E4].")).toEqual([`ul(li("seen " chip() chip() "."))`]);
  });

  it("keeps markup characters in model text as text", () => {
    expect(render("<b>x</b> <img src=x>")).toEqual([`p("<b>x</b> <img src=x>")`]);
  });

  it("returns nothing for empty text", () => {
    expect(render("")).toEqual([]);
  });
});
