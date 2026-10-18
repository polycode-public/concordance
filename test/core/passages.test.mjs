// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { slidingPassages } from "../../packages/core/chunking/passages.mjs";

const s = (n) => Array.from({ length: n }, (_, i) => `S${i}.`);

describe("slidingPassages", () => {
  it("windows four sentences with a stride of two by default", () => {
    const out = slidingPassages(s(6));
    expect(out).toEqual([
      { ordinal: 0, sentenceStart: 0, sentenceEnd: 3, text: "S0. S1. S2. S3." },
      { ordinal: 1, sentenceStart: 2, sentenceEnd: 5, text: "S2. S3. S4. S5." },
    ]);
  });

  it("keeps a short last window so the final sentence is covered", () => {
    const out = slidingPassages(s(7));
    expect(out.map((p) => [p.sentenceStart, p.sentenceEnd])).toEqual([
      [0, 3],
      [2, 5],
      [4, 6],
    ]);
  });

  it("returns one passage when there are fewer sentences than the window", () => {
    expect(slidingPassages(s(2))).toEqual([
      { ordinal: 0, sentenceStart: 0, sentenceEnd: 1, text: "S0. S1." },
    ]);
  });

  it("returns nothing for no sentences", () => {
    expect(slidingPassages([])).toEqual([]);
  });

  it("honours a custom window and stride", () => {
    const out = slidingPassages(s(5), { window: 3, stride: 1 });
    expect(out.map((p) => p.text)).toEqual(["S0. S1. S2.", "S1. S2. S3.", "S2. S3. S4."]);
  });

  it("rejects a zero stride", () => {
    expect(() => slidingPassages(s(3), { stride: 0 })).toThrow(RangeError);
  });
});
