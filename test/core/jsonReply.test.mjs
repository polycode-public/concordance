// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

import { describe, expect, it } from "vitest";
import { parseJsonReply } from "../../packages/core/providers/jsonReply.mjs";

describe("parseJsonReply", () => {
  it("parses a fenced block followed by prose", () => {
    const reply =
      '```json\n{\n  "assertions": []\n}\n```\n\nThe target sentences [S140] and [S141] contain only a signature line.';
    expect(parseJsonReply(reply, "m")).toEqual({ assertions: [] });
  });

  it("parses a bare object", () => {
    expect(parseJsonReply(' {"a": 1} ', "m")).toEqual({ a: 1 });
  });

  it("parses an object between prose", () => {
    expect(parseJsonReply('Here it is: {"a": {"b": 2}} done.', "m")).toEqual({ a: { b: 2 } });
  });

  it("keeps a brace inside a string value", () => {
    expect(parseJsonReply('x {"a": "}{ \\" }", "b": 1} y', "m")).toEqual({ a: '}{ " }', b: 1 });
  });

  it("throws with the reply start when there is no object", () => {
    expect(() => parseJsonReply("no object here", "model-x")).toThrow(
      "model-x returned invalid JSON: no object here",
    );
  });

  it("throws when a fenced block holds invalid JSON", () => {
    expect(() => parseJsonReply("```json\n{bad}\n```\n", "m")).toThrow(/m returned invalid JSON/);
  });
});
