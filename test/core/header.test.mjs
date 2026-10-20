// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { buildHeader, formatLocator } from "../../packages/core/chunking/header.mjs";

describe("buildHeader", () => {
  it("produces the bracket header with fields in order", () => {
    expect(
      buildHeader({
        corpus: "Grenfell Inquiry",
        witnessId: "IWS00001200",
        role: "resident, floor 18",
        statementDate: "2019-08-06",
        eventDate: "2017-06-14",
        locator: { page: 3, paragraph: 11 },
      }),
    ).toBe(
      "[Grenfell Inquiry | Witness IWS00001200 | resident, floor 18 | statement 6 Aug 2019 | event 14 Jun 2017 | p.3 para 11]",
    );
  });

  it("places the section heading before the locator", () => {
    expect(
      buildHeader({
        corpus: "Grenfell Inquiry",
        witnessId: "IWS1",
        heading: "Ethiopia",
        locator: { page: 1, paragraph: 3 },
      }),
    ).toBe("[Grenfell Inquiry | Witness IWS1 | Ethiopia | p.1 para 3]");
  });

  it("leaves out missing fields", () => {
    expect(buildHeader({ corpus: "Grenfell Inquiry", witnessId: "IWS1", locator: "p.2" })).toBe(
      "[Grenfell Inquiry | Witness IWS1 | p.2]",
    );
  });

  it("accepts Date objects", () => {
    expect(buildHeader({ corpus: "C", statementDate: new Date(Date.UTC(2018, 0, 2)) })).toBe(
      "[C | statement 2 Jan 2018]",
    );
  });
});

describe("formatLocator", () => {
  it("formats a transcript page and line", () => {
    expect(formatLocator({ page: 12, line: 5 })).toBe("p.12:5");
  });

  it("formats a media start time", () => {
    expect(formatLocator({ startMs: 4470000 })).toBe("t 01:14:30");
  });
});
