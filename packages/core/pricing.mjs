// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// List prices per model, in US dollars per million tokens, for the store's spend estimate by
// corpus. Cost Explorer has the real bill but cannot split it by corpus, so the page shows these
// figures as estimates beside the project's budget.

export const CURRENCY = "USD";

/** A price applies to every model id that contains its `family`; the first match wins. */
export const LIST_PRICES = Object.freeze([
  Object.freeze({ family: "claude-opus-4-6", input: 5, output: 25 }),
  Object.freeze({ family: "claude-opus-4-5", input: 5, output: 25 }),
  Object.freeze({ family: "claude-sonnet-4-6", input: 3, output: 15 }),
  Object.freeze({ family: "claude-sonnet-4-5", input: 3, output: 15 }),
  Object.freeze({ family: "claude-haiku-4-5", input: 1, output: 5 }),
  Object.freeze({ family: "titan-embed-text-v2", input: 0.02, output: 0 }),
]);

const PER_TOKEN = 1 / 1_000_000;

/**
 * The list price of a model id, or null when the table has none.
 * @param {string | null | undefined} model
 * @returns {{ family: string, input: number, output: number } | null}
 */
export function priceFor(model) {
  if (typeof model !== "string" || !model) return null;
  return LIST_PRICES.find((p) => model.includes(p.family)) ?? null;
}

/**
 * The cost of some tokens at the model's list price, or null when the model has no price.
 * @param {{ model: string | null, inputTokens: number, outputTokens: number }} usage
 */
export function costOf({ model, inputTokens, outputTokens }) {
  const price = priceFor(model);
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) * PER_TOKEN;
}
