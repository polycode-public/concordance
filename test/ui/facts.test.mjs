// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { REFUSAL } from "../../packages/ui/facts.js";
import { pointText } from "../../packages/ui/timeline.js";

describe("the facts panel's text", () => {
  it("writes a timeline point as its window, witness, claim and the witness's own words", () => {
    const point = {
      witnessId: "C123",
      predicate: "saw",
      objectText: "smoke",
      polarity: "positive",
      timeText: "1.30 am",
      window: { startClock: "01:25", endClock: "01:35" },
    };
    expect(pointText(point)).toBe('01:25–01:35 C123: saw smoke ("1.30 am")');
    expect(pointText({ ...point, subjectText: "I", subjectKind: "witness" })).toBe(
      '01:25–01:35 C123: saw smoke ("1.30 am")',
    );
    expect(pointText({ ...point, subjectText: "The fire brigade", subjectKind: "group" })).toBe(
      '01:25–01:35 C123: The fire brigade saw smoke ("1.30 am")',
    );
    expect(pointText({ ...point, polarity: "negative", objectText: null })).toBe(
      '01:25–01:35 C123: not saw ("1.30 am")',
    );
  });

  it("says why an identity-revealing pair is not shown side by side", () => {
    expect(REFUSAL).toMatch(/reveal a protected witness's identity/);
    expect(REFUSAL).toMatch(/not shown side by side/);
  });
});
