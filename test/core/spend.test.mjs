// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAYS,
  HISTORY_SQL,
  MONTH_SQL,
  SpendInputError,
  historyDays,
  readMonthEstimate,
  readSpendHistory,
  spendHistory,
} from "../../packages/core/spend.mjs";

const SONNET = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const today = new Date("2026-10-20T15:00:00Z");

describe("the days of a history request", () => {
  it("defaults to 30 and takes 1 to 366", () => {
    expect(historyDays(undefined)).toBe(DEFAULT_DAYS);
    expect(historyDays("")).toBe(30);
    expect(historyDays("7")).toBe(7);
    expect(historyDays("366")).toBe(366);
    for (const bad of ["0", "367", "-1", "1.5", "x", "07"]) {
      expect(() => historyDays(bad)).toThrow(SpendInputError);
    }
  });
});

describe("the spend history", () => {
  it("prices each corpus's tokens by day and fills the days without use", () => {
    const history = spendHistory(
      [
        {
          corpus: "grenfell",
          day: "2026-10-19",
          model: SONNET,
          source: "turn",
          requests: "2",
          input_tokens: "1000000",
          output_tokens: "0",
          cache_read_tokens: "0",
          cache_write_tokens: "0",
        },
        {
          corpus: "grenfell",
          day: "2026-10-19",
          model: HAIKU,
          source: "report",
          requests: 1,
          input_tokens: 0,
          output_tokens: 1_000_000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        {
          corpus: "ucpi",
          day: "2026-10-20",
          model: SONNET,
          source: "turn",
          requests: 1,
          input_tokens: 0,
          output_tokens: 100_000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        {
          corpus: "ucpi",
          day: "2026-10-20",
          model: HAIKU,
          source: "comparison",
          requests: 4,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        {
          corpus: "ucpi",
          day: "2026-10-20",
          model: "qwen3:8b",
          source: "turn",
          requests: 1,
          input_tokens: 10,
          output_tokens: 10,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
      { days: 3, today },
    );
    expect(history.currency).toBe("USD");
    expect(history.days).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(history.series.map((s) => s.corpus)).toEqual(["grenfell", "ucpi"]);
    const [grenfell, ucpi] = history.series;
    expect(grenfell.points.map((p) => p.cost)).toEqual([0, 8 * 1.1, 0]);
    expect(grenfell.points[1]).toMatchObject({
      requests: 3,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(ucpi.points[2].cost).toBeCloseTo(1.5 * 1.1, 10);
    expect(ucpi.points[2]).toMatchObject({ requests: 6, inputTokens: 10, outputTokens: 100_010 });
    expect(history.unpriced).toEqual(["qwen3:8b"]);
  });

  it("prices cached tokens at the cache rates", () => {
    const history = spendHistory(
      [
        {
          corpus: "grenfell",
          day: "2026-10-20",
          model: SONNET,
          source: "turn",
          requests: 1,
          input_tokens: "1000000",
          output_tokens: "0",
          cache_read_tokens: "600000",
          cache_write_tokens: "100000",
        },
      ],
      { days: 1, today },
    );
    expect(history.series[0].points[0].cost).toBeCloseTo(
      (0.3 * 3 + 0.6 * 0.3 + 0.1 * 3.75) * 1.1,
      10,
    );
    expect(history.series[0].points[0].inputTokens).toBe(1_000_000);
  });

  it("reads the view for the window and prices it", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    const history = await readSpendHistory(db, { days: 2, today });
    expect(calls).toEqual([{ text: HISTORY_SQL, params: [2] }]);
    expect(HISTORY_SQL).toMatch(/FROM usage_daily/);
    expect(HISTORY_SQL).toMatch(/cache_read_tokens, cache_write_tokens/);
    expect(history).toEqual({
      currency: "USD",
      days: ["2026-10-19", "2026-10-20"],
      series: [],
      unpriced: [],
    });
  });
});

describe("the month's estimate", () => {
  it("prices this month's tokens over every corpus and skips unpriced models", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push({ text, params });
        return {
          rows: [
            {
              model: SONNET,
              input_tokens: "1000000",
              output_tokens: "100000",
              cache_read_tokens: "0",
              cache_write_tokens: "0",
            },
            {
              model: HAIKU,
              input_tokens: "1000000",
              output_tokens: "0",
              cache_read_tokens: "1000000",
              cache_write_tokens: "0",
            },
            {
              model: HAIKU,
              input_tokens: "2000000",
              output_tokens: "0",
              cache_read_tokens: "0",
              cache_write_tokens: "0",
            },
            {
              model: null,
              input_tokens: "0",
              output_tokens: "0",
              cache_read_tokens: "0",
              cache_write_tokens: "0",
            },
          ],
        };
      },
    };
    expect(await readMonthEstimate(db)).toBeCloseTo((3 + 1.5 + 2 + 0.1) * 1.1, 10);
    expect(calls).toEqual([{ text: MONTH_SQL, params: [] }]);
    expect(MONTH_SQL).toMatch(/FROM usage_daily/);
    expect(MONTH_SQL).toMatch(/sum\(cache_read_tokens\)/);
    expect(MONTH_SQL).toMatch(/sum\(cache_write_tokens\)/);
  });
});
