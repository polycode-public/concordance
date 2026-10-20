// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Time phrases from witness statements as windows on the night of the incident. The extractor
// stores the phrase only ("about 1.00 am", "shortly after 1am", "at 02:10"); a window turns the
// phrase into an interval that two witnesses' times can be compared on, with a tolerance that
// widens when the witness hedges.

/** The local date the night's small hours fall on, and its offset from UTC (BST). */
export const INCIDENT_DAY = Object.freeze({ year: 2017, month: 6, day: 14, utcOffsetMinutes: 60 });

/** Half-widths and spans of a window, in minutes, by how the witness states the time. */
export const TIME_TOLERANCE = Object.freeze({
  exact: 5,
  hedged: 10,
  shortly: 20,
  just: 10,
  open: 60,
});

/** A time at 18:00 or later, with no date, is the evening before the small hours. */
export const EVENING_FROM_HOUR = 18;

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const HOUR_WORD = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;

const HEDGE =
  /\b(about|around|approximately|approx|roughly|circa|some ?time|maybe|perhaps|probably|i think|i believe|or so)\b|ish\b/;

// One clock time, tried in order: 24-hour with a four-digit "hrs" form, h:mm or h.mm with an
// optional am or pm, h with am or pm, h o'clock, midnight, noon, and half or quarter past or to.
const CLOCK = new RegExp(
  [
    String.raw`\b(?<hrs>[0-2]\d[0-5]\d)\s*(?:hrs|hours|h)\b`,
    String.raw`\b(?<h>[0-2]?\d)[:.](?<m>[0-5]\d)\s*(?<mer>am|pm)?\b`,
    String.raw`\b(?<h2>1[0-2]|0?[1-9])\s*(?<mer2>am|pm)\b`,
    `\\b(?<h3>${HOUR_WORD})\\s*o'?clock\\b`,
    String.raw`\b(?<midnight>midnight)\b`,
    String.raw`\b(?<noon>noon|midday)\b`,
    `\\b(?:a )?(?<part>half|quarter)\\s+(?<dir>past|to)\\s+(?<h4>${HOUR_WORD})\\b`,
  ].join("|"),
  "g",
);

function normaliseText(text) {
  return String(text)
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/a\.m\.?/g, "am")
    .replace(/p\.m\.?/g, "pm")
    .replace(/\s+/g, " ")
    .trim();
}

const hourValue = (raw) => NUMBER_WORDS[raw] ?? Number(raw);

/** Minutes after local midnight of the night's day for one match, or null. Negative is the evening before. */
function minutesOf(groups) {
  let hour;
  let minute = 0;
  let meridiem = null;
  if (groups.hrs) {
    hour = Number(groups.hrs.slice(0, 2));
    minute = Number(groups.hrs.slice(2));
  } else if (groups.h !== undefined) {
    hour = Number(groups.h);
    minute = Number(groups.m);
    meridiem = groups.mer ?? null;
  } else if (groups.h2 !== undefined) {
    hour = Number(groups.h2);
    meridiem = groups.mer2;
  } else if (groups.h3 !== undefined) {
    hour = hourValue(groups.h3);
  } else if (groups.midnight) {
    hour = 0;
  } else if (groups.noon) {
    hour = 12;
  } else if (groups.h4 !== undefined) {
    hour = hourValue(groups.h4);
    const quarter = groups.part === "half" ? 30 : 15;
    if (groups.dir === "past") minute = quarter;
    else {
      hour -= 1;
      minute = 60 - quarter;
    }
  } else {
    return null;
  }
  if (hour > 23 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  const total = hour * 60 + minute;
  return hour >= EVENING_FROM_HOUR ? total - 24 * 60 : total;
}

function clockTimes(text) {
  const out = [];
  for (const match of text.matchAll(CLOCK)) {
    const minutes = minutesOf(match.groups);
    if (minutes !== null)
      out.push({ minutes, index: match.index, end: match.index + match[0].length });
  }
  return out;
}

const toIso = (minutes) => {
  const { year, month, day, utcOffsetMinutes } = INCIDENT_DAY;
  return new Date(Date.UTC(year, month - 1, day, 0, minutes - utcOffsetMinutes)).toISOString();
};

const pad = (n) => String(n).padStart(2, "0");
/** The local clock reading of minutes after midnight, as HH:MM. */
export const localClock = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

/**
 * The window a time phrase states, or null when it states no clock time.
 * @param {string | null | undefined} text
 * @returns {{ start: string, end: string, startMinutes: number, endMinutes: number,
 *   startClock: string, endClock: string, hedged: boolean } | null}
 */
export function parseTimeWindow(text) {
  if (!text) return null;
  const t = normaliseText(text);
  const times = clockTimes(t);
  if (!times.length) return null;
  const hedged = HEDGE.test(t);
  const first = times[0];
  const before = t.slice(0, first.index);
  let start;
  let end;
  if (times.length >= 2 && /\b(between|from)\b/.test(before)) {
    start = first.minutes;
    end = times[1].minutes;
    if (end < start) [start, end] = [end, start];
    if (hedged) {
      start -= TIME_TOLERANCE.exact;
      end += TIME_TOLERANCE.exact;
    }
  } else {
    const at = first.minutes;
    const lead = before.trim();
    if (/\b(shortly|soon|not long) after$/.test(lead))
      [start, end] = [at, at + TIME_TOLERANCE.shortly];
    else if (/\bjust after$/.test(lead)) [start, end] = [at, at + TIME_TOLERANCE.just];
    else if (/\b(shortly|not long) before$/.test(lead))
      [start, end] = [at - TIME_TOLERANCE.shortly, at];
    else if (/\bjust before$/.test(lead)) [start, end] = [at - TIME_TOLERANCE.just, at];
    else if (/\bafter$/.test(lead)) [start, end] = [at, at + TIME_TOLERANCE.open];
    else if (/\b(before|by|until|till)$/.test(lead)) [start, end] = [at - TIME_TOLERANCE.open, at];
    else {
      const half = hedged ? TIME_TOLERANCE.hedged : TIME_TOLERANCE.exact;
      [start, end] = [at - half, at + half];
    }
  }
  return {
    start: toIso(start),
    end: toIso(end),
    startMinutes: start,
    endMinutes: end,
    startClock: localClock(start),
    endClock: localClock(end),
    hedged,
  };
}

/** True when two windows share no minute. */
export const windowsDisjoint = (a, b) =>
  a.endMinutes < b.startMinutes || b.endMinutes < a.startMinutes;

/**
 * The timeline: each assertion with a parsed window as a point, ordered by window start, and the
 * count of time phrases that state no clock time.
 * @param {{ assertionId: string, timeText: string | null }[]} assertions
 */
export function timelinePoints(assertions) {
  const points = [];
  let unparsed = 0;
  for (const a of assertions) {
    const window = parseTimeWindow(a.timeText);
    if (!window) {
      unparsed++;
      continue;
    }
    points.push({ ...a, window });
  }
  points.sort(
    (x, y) =>
      x.window.startMinutes - y.window.startMinutes ||
      x.window.endMinutes - y.window.endMinutes ||
      Number(x.assertionId) - Number(y.assertionId),
  );
  const { year, month, day } = INCIDENT_DAY;
  return { day: `${year}-${pad(month)}-${pad(day)}`, points, unparsed };
}
