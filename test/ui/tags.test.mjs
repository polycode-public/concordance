// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { TAG, tagNumbers } from "../../packages/ui/tags.mjs";

const numbers = (text) => [...text.matchAll(TAG)].flatMap(tagNumbers);

describe("tagNumbers", () => {
  it("reads one number per bracket", () => {
    expect(numbers("a [E3] b [E4]")).toEqual([3, 4]);
    expect(numbers("a [E3][E4]")).toEqual([3, 4]);
  });

  it("reads two numbers in one bracket", () => {
    expect(numbers("a [E3, E4]")).toEqual([3, 4]);
    expect(numbers("a [E3,E4]")).toEqual([3, 4]);
  });
});
