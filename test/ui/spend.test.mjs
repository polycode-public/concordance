// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { GRAPH, REACHED, historyView, money, spendView } from "../../packages/ui/spend.js";

describe("the spend strip", () => {
  it("writes the spend against the limit and fills cells in proportion", () => {
    expect(spendView({ actual: 3.42, limit: 25, unit: "USD" })).toEqual({
      text: "This month $3.42 of $25",
      filled: 1,
      level: "ok",
      note: "",
    });
    expect(spendView({ actual: 12.5, limit: 25, unit: "USD" }).filled).toBe(5);
  });

  it("turns amber at 20 % headroom and red at 5 %", () => {
    expect(spendView({ actual: 19.99, limit: 25, unit: "USD" }).level).toBe("ok");
    expect(spendView({ actual: 20, limit: 25, unit: "USD" }).level).toBe("amber");
    expect(spendView({ actual: 23.75, limit: 25, unit: "USD" }).level).toBe("red");
  });

  it("says the budget is reached at or over the limit, with every cell filled", () => {
    for (const actual of [25, 31.2]) {
      const view = spendView({ actual, limit: 25, unit: "USD" });
      expect(view).toMatchObject({ filled: 10, level: "red", note: REACHED });
    }
  });

  it("writes a non-dollar unit after the amount", () => {
    expect(money(3.4, "EUR")).toBe("3.40 EUR");
  });

  it("throws on a read without a usable limit", () => {
    expect(() => spendView({ actual: 1, limit: 0, unit: "USD" })).toThrow(/positive limit/);
  });
});

describe("the spend history graph", () => {
  const corpora = [
    { id: "grenfell", name: "Grenfell Tower Inquiry" },
    { id: "ucpi", name: "Undercover Policing Inquiry" },
  ];
  const point = (day, cost) => ({ day, cost, inputTokens: 0, outputTokens: 0, requests: 0 });

  it("draws one line per corpus in drop-list order, scaled to the largest day", () => {
    const view = historyView(
      {
        days: ["2026-10-19", "2026-10-20"],
        series: [
          { corpus: "ucpi", points: [point("2026-10-19", 0), point("2026-10-20", 2)] },
          { corpus: "grenfell", points: [point("2026-10-19", 1), point("2026-10-20", 0)] },
        ],
      },
      corpora,
    );
    expect(view.lines.map((l) => [l.corpus, l.name, l.total])).toEqual([
      ["grenfell", "Grenfell Tower Inquiry", 1],
      ["ucpi", "Undercover Policing Inquiry", 2],
    ]);
    const bottom = GRAPH.height - GRAPH.bottom;
    const right = GRAPH.width - GRAPH.right;
    const middle = GRAPH.top + (bottom - GRAPH.top) / 2;
    expect(view.lines[0].points).toBe(
      `${GRAPH.left.toFixed(1)},${middle.toFixed(1)} ${right.toFixed(1)},${bottom.toFixed(1)}`,
    );
    expect(view.lines[1].points).toBe(
      `${GRAPH.left.toFixed(1)},${bottom.toFixed(1)} ${right.toFixed(1)},${GRAPH.top.toFixed(1)}`,
    );
    expect(view).toMatchObject({ max: 2, first: "2026-10-19", last: "2026-10-20" });
  });

  it("keeps a flat line on the axis when nothing was spent", () => {
    const view = historyView(
      { days: ["2026-10-20"], series: [{ corpus: "x", points: [point("2026-10-20", 0)] }] },
      corpora,
    );
    expect(view.max).toBe(0);
    expect(view.lines[0].name).toBe("x");
    expect(view.lines[0].points).toBe(
      `${GRAPH.left.toFixed(1)},${(GRAPH.height - GRAPH.bottom).toFixed(1)}`,
    );
  });
});
