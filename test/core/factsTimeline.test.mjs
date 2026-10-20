// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  TIME_TOLERANCE,
  parseTimeWindow,
  timelinePoints,
  windowsDisjoint,
} from "../../packages/core/facts/timeline.mjs";

const clock = (text) => {
  const w = parseTimeWindow(text);
  return w && `${w.startClock}-${w.endClock}`;
};

describe("parseTimeWindow", () => {
  it.each([
    ["about 1.00 am", "00:50-01:10"],
    ["around 01:15", "01:05-01:25"],
    ["at about 1:00a.m.", "00:50-01:10"],
    ["approximately 1am", "00:50-01:10"],
    ["shortly after 1am", "01:00-01:20"],
    ["just after 1.40 am", "01:40-01:50"],
    ["just before 3am", "02:50-03:00"],
    ["by 4am", "03:00-04:00"],
    ["at 02:10", "02:05-02:15"],
    ["1.30 am", "01:25-01:35"],
    ["0115 hrs", "01:10-01:20"],
    ["between 1.20 and 1.40am", "01:20-01:40"],
    ["about half past one", "01:20-01:40"],
    ["quarter to two", "01:40-01:50"],
    ["two o'clock", "01:55-02:05"],
    ["midnight", "23:55-00:05"],
    ["11 pm", "22:55-23:05"],
    ["12.30 am", "00:25-00:35"],
  ])("reads %s as %s", (text, expected) => {
    expect(clock(text)).toBe(expected);
  });

  it("places the small hours on 14 June 2017 in UTC and the evening on 13 June", () => {
    expect(parseTimeWindow("at 02:10")).toMatchObject({
      start: "2017-06-14T01:05:00.000Z",
      end: "2017-06-14T01:15:00.000Z",
      hedged: false,
    });
    expect(parseTimeWindow("11 pm").start).toBe("2017-06-13T21:55:00.000Z");
    expect(parseTimeWindow("about 1.00 am")).toMatchObject({
      start: "2017-06-13T23:50:00.000Z",
      hedged: true,
    });
  });

  it.each([
    [null],
    [""],
    ["14 June 2017"],
    ["floor 16"],
    ["flat 113"],
    ["later that night"],
    ["25:00"],
  ])("reads %s as no window", (text) => {
    expect(parseTimeWindow(text)).toBeNull();
  });

  it("widens a hedged time more than a stated one", () => {
    expect(TIME_TOLERANCE.hedged).toBeGreaterThan(TIME_TOLERANCE.exact);
    const hedged = parseTimeWindow("about 1.00 am");
    const exact = parseTimeWindow("1.00 am");
    expect(hedged.endMinutes - hedged.startMinutes).toBe(2 * TIME_TOLERANCE.hedged);
    expect(exact.endMinutes - exact.startMinutes).toBe(2 * TIME_TOLERANCE.exact);
  });
});

describe("windowsDisjoint", () => {
  it("separates about 1.00 am from 1.30 am and joins about 1.00 am with around 01:05", () => {
    const one = parseTimeWindow("about 1.00 am");
    expect(windowsDisjoint(one, parseTimeWindow("1.30 am"))).toBe(true);
    expect(windowsDisjoint(one, parseTimeWindow("around 01:05"))).toBe(false);
    expect(windowsDisjoint(parseTimeWindow("1.30 am"), one)).toBe(true);
  });
});

describe("timelinePoints", () => {
  it("orders the points by window and counts the phrases with no clock time", () => {
    const out = timelinePoints([
      { assertionId: "3", timeText: "1.30 am" },
      { assertionId: "1", timeText: "about 1.00 am" },
      { assertionId: "2", timeText: "that night" },
      { assertionId: "4", timeText: "11 pm" },
    ]);
    expect(out.day).toBe("2017-06-14");
    expect(out.unparsed).toBe(1);
    expect(out.points.map((p) => p.assertionId)).toEqual(["4", "1", "3"]);
    expect(out.points[1].window.startClock).toBe("00:50");
  });
});
