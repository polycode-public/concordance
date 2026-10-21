// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { parseTurnFilters } from "../../packages/core/protocol.mjs";
import {
  emptyFilters,
  filterChips,
  filterProblem,
  frameFilters,
  withoutChip,
  witnessIds,
} from "../../packages/ui/filters.mjs";

const SET = {
  witnesses: ["IWS1", "IWS2"],
  role: " Resident, floor 12 ",
  from: "2018-01-01",
  to: "",
};

describe("the filters of a turn frame", () => {
  it("is undefined while nothing is set", () => {
    expect(frameFilters(emptyFilters())).toBeUndefined();
    expect(frameFilters({ ...emptyFilters(), role: "  " })).toBeUndefined();
  });

  it("carries only what is set, in the shape the server parses", () => {
    const filters = frameFilters(SET);
    expect(filters).toEqual({
      witnesses: ["IWS1", "IWS2"],
      role: "Resident, floor 12",
      from: "2018-01-01",
    });
    expect(parseTurnFilters(filters)).toEqual(filters);
  });
});

describe("the chip row", () => {
  it("has a chip for each witness, the role and each date", () => {
    expect(filterChips({ ...SET, to: "2018-12-31" }).map((c) => c.text)).toEqual([
      "Witness IWS1",
      "Witness IWS2",
      "Role: Resident, floor 12",
      "From 2018-01-01",
      "To 2018-12-31",
    ]);
    expect(filterChips(emptyFilters())).toEqual([]);
  });

  it("removes one witness, or clears one field", () => {
    expect(withoutChip(SET, { key: "witness", value: "IWS1" }).witnesses).toEqual(["IWS2"]);
    expect(withoutChip(SET, { key: "role" }).role).toBe("");
    expect(withoutChip(SET, { key: "from" }).from).toBe("");
  });
});

describe("the filter checks", () => {
  it("names a From date after the To date", () => {
    expect(filterProblem({ ...emptyFilters(), from: "2019-01-01", to: "2018-01-01" })).toMatch(
      /From date is after/,
    );
    expect(filterProblem({ ...emptyFilters(), from: "2018-01-01", to: "2018-01-01" })).toBeNull();
    expect(filterProblem(emptyFilters())).toBeNull();
  });

  it("lists the witnesses of a timeline with the extra ids, sorted and distinct", () => {
    const timeline = { points: [{ witnessId: "B" }, { witnessId: "A" }, { witnessId: "B" }] };
    expect(witnessIds(timeline, ["C", undefined, "A"])).toEqual(["A", "B", "C"]);
    expect(witnessIds(null)).toEqual([]);
  });
});
