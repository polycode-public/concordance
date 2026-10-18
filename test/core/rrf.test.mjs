// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../../packages/core/retrieval/rrf.mjs";

describe("reciprocalRankFusion", () => {
  it("ranks ids found high in several lists first", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    expect(fused.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused[2].score).toBeCloseTo(1 / 63);
  });

  it("puts an id in both lists above an id at the top of one list", () => {
    const fused = reciprocalRankFusion([
      ["x", "shared"],
      ["y", "shared"],
    ]);
    expect(fused[0].id).toBe("shared");
  });

  it("honours k", () => {
    const [top] = reciprocalRankFusion([[1]], { k: 0 });
    expect(top).toEqual({ id: 1, score: 1 });
  });

  it("counts a repeated id once per list", () => {
    const fused = reciprocalRankFusion([["a", "a"]]);
    expect(fused).toEqual([{ id: "a", score: 1 / 61 }]);
  });

  it("returns nothing for no rankings", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
