// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "ui");
const TOKENS = "tokens.css";

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/i;
const NAMED_COLOUR =
  /:\s*[^;{}]*\b(?:white|black|red|green|blue|yellow|orange|gray|grey|silver|purple|navy)\b/i;

const files = readdirSync(ui).filter((name) => /\.(css|html|js)$/.test(name));
const read = (name) => readFileSync(path.join(ui, name), "utf8");

/** The names of the custom properties a CSS block declares, in order. */
function declared(css) {
  return [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
}

/** The body of the first `:root { … }` block after `from` in the stylesheet. */
function rootBlock(css, from = 0) {
  const start = css.indexOf(":root", from);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("the page's tokens", () => {
  it("names no colour outside tokens.css", () => {
    const offenders = files
      .filter((name) => name !== TOKENS)
      .flatMap((name) =>
        read(name)
          .split("\n")
          .map((text, index) => ({ name, line: index + 1, text }))
          .filter(({ text }) => {
            const withoutTokens = text.replace(/var\(--[\w-]+\)/g, "");
            return (
              COLOUR_LITERAL.test(withoutTokens) ||
              (name.endsWith(".css") && NAMED_COLOUR.test(withoutTokens))
            );
          }),
      )
      .map(({ name, line, text }) => `${name}:${line}: ${text.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("redefines every colour token for dark mode", () => {
    const css = read(TOKENS);
    const light = rootBlock(css);
    const darkAt = css.indexOf("prefers-color-scheme: dark");
    expect(darkAt).toBeGreaterThan(0);
    const dark = rootBlock(css, darkAt);
    const colourTokens = declared(light).filter((token) => {
      const value = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(light)[1];
      return /^#[0-9a-f]{3,8}$/i.test(value.trim());
    });
    expect(colourTokens.length).toBeGreaterThan(5);
    const missing = colourTokens.filter((token) => !declared(dark).includes(token));
    expect(missing).toEqual([]);
  });

  it("loads tokens.css before styles.css", () => {
    const html = read("index.html");
    expect(html.indexOf('href="/tokens.css"')).toBeGreaterThan(0);
    expect(html.indexOf('href="/tokens.css"')).toBeLessThan(html.indexOf('href="/styles.css"'));
  });

  it("names the inquiry in the header", () => {
    expect(read("index.html")).toMatch(/<header[\s\S]*Grenfell Tower Inquiry[\s\S]*<\/header>/);
  });
});
