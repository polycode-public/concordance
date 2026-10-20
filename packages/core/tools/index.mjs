// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The tools a chat turn offers the model: each computes over the stored data of one corpus and
// returns rows with the evidence blocks that state them.
import { corroboratedContradictions } from "./corroboratedContradictions.mjs";
import { countAssertions } from "./countAssertions.mjs";
import { documentFacts } from "./documentFacts.mjs";
import { matrixCell } from "./matrixCell.mjs";
import { searchChunks } from "./searchChunks.mjs";
import { timelineWindow } from "./timelineWindow.mjs";
import { usageSummary } from "./usageSummary.mjs";
import { witnessClaims } from "./witnessClaims.mjs";

export const STORE_TOOLS = Object.freeze([
  countAssertions,
  witnessClaims,
  timelineWindow,
  matrixCell,
  corroboratedContradictions,
  documentFacts,
  searchChunks,
  usageSummary,
]);

/**
 * @typedef {object} StoreTool
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema
 * @property {(input: object) => Promise<{ rows: object[], evidence: object[], [extra: string]: unknown }>} run
 *   The rows name chunks by chunkId; evidence holds one block, without a number, for each.
 */

/**
 * The tools bound to one turn's store, corpus and provider.
 * @param {{ db: { query: Function }, corpus: string, provider: object, signal?: AbortSignal }} context
 * @returns {StoreTool[]}
 */
export function buildTools(context) {
  if (!context?.db) throw new Error("the tools need a database");
  if (!context.corpus) throw new Error("the tools need a corpus");
  return STORE_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    run: (input) => tool.run(context, input),
  }));
}
