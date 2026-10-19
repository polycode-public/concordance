// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { REACHED, money, spendView } from "../../packages/ui/spend.js";

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
