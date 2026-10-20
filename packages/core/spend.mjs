// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The spend history by corpus: the usage_daily view's tokens per corpus and day, priced at the
// list prices in pricing.mjs. The GET /spend/history routes on AWS and on the laptop answer
// with it.
import { CURRENCY, costOf } from "./pricing.mjs";

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

export const HISTORY_SQL = `
  SELECT corpus, to_char(day, 'YYYY-MM-DD') AS day, model, source, requests, input_tokens,
         output_tokens
    FROM usage_daily
   WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::int
   ORDER BY day, corpus, model, source`;

export class SpendInputError extends Error {
  name = "SpendInputError";
}

/**
 * The number of days a request asks for.
 * @param {unknown} value
 */
export function historyDays(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_DAYS;
  const s = String(value);
  if (!/^[1-9][0-9]{0,2}$/.test(s) || Number(s) > MAX_DAYS) {
    throw new SpendInputError(`days is a whole number from 1 to ${MAX_DAYS}.`);
  }
  return Number(s);
}

const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * The history as the page draws it: every day of the window, one series per corpus with a point
 * per day, and the models that had no list price.
 * @param {{ corpus: string, day: string, model: string | null, source: string,
 *   requests: number | string, input_tokens: number | string, output_tokens: number | string }[]} rows
 * @param {{ days: number, today: Date }} window
 */
export function spendHistory(rows, { days, today }) {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dates = Array.from({ length: days }, (_, i) =>
    isoDay(new Date(end - (days - 1 - i) * 86_400_000)),
  );
  const byCorpus = new Map();
  const unpriced = new Set();
  for (const r of rows) {
    const inputTokens = Number(r.input_tokens);
    const outputTokens = Number(r.output_tokens);
    const requests = Number(r.requests);
    const series = byCorpus.get(r.corpus) ?? new Map();
    byCorpus.set(r.corpus, series);
    const point = series.get(r.day) ?? { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    series.set(r.day, point);
    point.inputTokens += inputTokens;
    point.outputTokens += outputTokens;
    point.requests += requests;
    if (inputTokens + outputTokens === 0) continue;
    const cost = costOf({ model: r.model, inputTokens, outputTokens });
    if (cost === null) unpriced.add(r.model ?? "unknown");
    else point.cost += cost;
  }
  const empty = { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
  return {
    currency: CURRENCY,
    days: dates,
    series: [...byCorpus.keys()].sort().map((corpus) => ({
      corpus,
      points: dates.map((day) => ({ day, ...(byCorpus.get(corpus).get(day) ?? empty) })),
    })),
    unpriced: [...unpriced].sort(),
  };
}

export const MONTH_SQL = `
  SELECT model, sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens
    FROM usage_daily
   WHERE day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date
   GROUP BY model`;

/**
 * The list-price estimate of this month's model spend over every corpus, in dollars. Models
 * without a list price add nothing.
 * @param {{ query: Function }} db
 */
export async function readMonthEstimate(db) {
  const { rows } = await db.query(MONTH_SQL, []);
  return rows.reduce(
    (sum, r) =>
      sum +
      (costOf({
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
      }) ?? 0),
    0,
  );
}

/**
 * Reads and prices the history of the last `days` days.
 * @param {{ query: Function }} db
 * @param {{ days: number, today: Date }} window
 */
export async function readSpendHistory(db, { days, today }) {
  const { rows } = await db.query(HISTORY_SQL, [days]);
  return spendHistory(rows, { days, today });
}
