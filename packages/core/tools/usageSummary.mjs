// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// usage_summary: this corpus's model use by day, model and source from the usage_daily view,
// priced at the list prices. The rows are records of this system, so they carry no evidence.
import { costOf } from "../pricing.mjs";
import { DEFAULT_DAYS, HISTORY_SQL, MAX_DAYS } from "../spend.mjs";
import { MAX_TOOL_ROWS, ToolInputError } from "./shared.mjs";

export const usageSummary = {
  name: "usage_summary",
  description:
    "Summarises this system's model use for this corpus by day, model and source (turn, " +
    `report or comparison): requests, input and output tokens and the list-price cost. Covers the last ` +
    `days (1 to ${MAX_DAYS}, default ${DEFAULT_DAYS}), newest first, at most 50 rows. These ` +
    "rows record this system's own use, never anything a witness said, and have no evidence " +
    "blocks.",
  inputSchema: {
    type: "object",
    properties: { days: { type: "integer", minimum: 1, maximum: MAX_DAYS } },
  },
  async run({ db, corpus }, input) {
    const days = input?.days ?? DEFAULT_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      throw new ToolInputError(`days is a whole number from 1 to ${MAX_DAYS}`);
    }
    const { rows } = await db.query(HISTORY_SQL, [days]);
    const mine = rows
      .filter((r) => r.corpus === corpus)
      .reverse()
      .map((r) => {
        const inputTokens = Number(r.input_tokens);
        const outputTokens = Number(r.output_tokens);
        return {
          day: r.day,
          model: r.model ?? null,
          source: r.source,
          requests: Number(r.requests),
          inputTokens,
          outputTokens,
          cost: costOf({ model: r.model, inputTokens, outputTokens }),
        };
      });
    return {
      rows: mine.slice(0, MAX_TOOL_ROWS),
      truncated: mine.length > MAX_TOOL_ROWS,
      evidence: [],
    };
  },
};
