// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  TAG as CORE_TAG,
  tagNumbers as coreTagNumbers,
} from "../../packages/core/checks/citations.mjs";
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

  it("reads a range as every number in it", () => {
    expect(numbers("all [E13-E16]")).toEqual([13, 14, 15, 16]);
    expect(numbers("all [E13-16]")).toEqual([13, 14, 15, 16]);
    expect(numbers("all [E13\u2013E15, E44, E50]")).toEqual([13, 14, 15, 44, 50]);
    expect(numbers("reversed [E5-E3]")).toEqual([3, 4, 5]);
  });

  it("reads a range wider than 100 numbers as its two ends", () => {
    expect(numbers("wide [E1-E500]")).toEqual([1, 500]);
  });
});

describe("the page and the server read the same numbers", () => {
  const samples = [
    "a [E3] b [E4]",
    "a [E3, E4]",
    "all [E13-E30, E44, E50] and [E2]",
    "none here [E] [x3]",
    "wide [E1-E500]",
  ];
  it.each(samples)("%s", (text) => {
    const server = [...text.matchAll(CORE_TAG)].flatMap(coreTagNumbers);
    expect(server).toEqual(numbers(text));
  });
});
