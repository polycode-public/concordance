// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { TAG, tagNumbers } from "./tags.mjs";

const BULLET = /^\s*[-*]\s+(.*)$/;
const BOLD = /\*\*(.+?)\*\*/g;

/**
 * Splits a run of text into text nodes and the nodes `chipFor(n)` returns for each [En] tag.
 * @param {(n: number) => Node} chipFor
 * @returns {(run: string) => Node[]}
 */
export function chipInline(chipFor) {
  return (run) => {
    const nodes = [];
    let last = 0;
    for (const match of run.matchAll(TAG)) {
      if (match.index > last) nodes.push(document.createTextNode(run.slice(last, match.index)));
      for (const n of tagNumbers(match)) nodes.push(chipFor(n));
      last = match.index + match[0].length;
    }
    if (last < run.length) nodes.push(document.createTextNode(run.slice(last)));
    return nodes;
  };
}

function inlineNodes(line, inline) {
  const nodes = [];
  let last = 0;
  for (const match of line.matchAll(BOLD)) {
    if (match.index > last) nodes.push(...inline(line.slice(last, match.index)));
    const strong = document.createElement("strong");
    strong.append(...inline(match[1]));
    nodes.push(strong);
    last = match.index + match[0].length;
  }
  if (last < line.length) nodes.push(...inline(line.slice(last)));
  return nodes;
}

function paragraph(lines, inline) {
  const p = document.createElement("p");
  lines.forEach((line, i) => {
    if (i > 0) p.append(document.createElement("br"));
    p.append(...inlineNodes(line, inline));
  });
  return p;
}

/**
 * Builds DOM nodes for paragraphs (blank-line separated, single newlines as line breaks),
 * `-` bullet lists and **bold**. Every run of text goes through `inline`, which makes text
 * nodes, so model text never becomes markup.
 * @param {string} text
 * @param {(run: string) => Node[]} inline
 * @returns {HTMLElement[]}
 */
export function renderMarkdown(text, inline) {
  const blocks = [];
  let lines = [];
  let items = [];
  const flushLines = () => {
    if (lines.length) blocks.push(paragraph(lines, inline));
    lines = [];
  };
  const flushItems = () => {
    if (items.length) {
      const ul = document.createElement("ul");
      for (const item of items) {
        const li = document.createElement("li");
        li.append(...inlineNodes(item, inline));
        ul.append(li);
      }
      blocks.push(ul);
    }
    items = [];
  };
  for (const line of text.split("\n")) {
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushLines();
      items.push(bullet[1]);
    } else if (line.trim() === "") {
      flushLines();
      flushItems();
    } else {
      flushItems();
      lines.push(line.trim());
    }
  }
  flushLines();
  flushItems();
  return blocks;
}
