// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// matrix_cell: the comparisons between two witnesses in one corpus, the cell of the
// contradiction matrix, with each pair's label, reason, spans and both sentences as evidence.
import { resolvePairs, VIEW_SQL } from "../facts/views.mjs";
import {
  MAX_TOOL_ROWS,
  eventIdByName,
  optionalText,
  pairRow,
  requiredText,
  withEvidence,
} from "./shared.mjs";

export const matrixCell = {
  name: "matrix_cell",
  description:
    "Lists the stored comparisons between the assertions of two witnesses in this corpus (one " +
    "cell of the contradiction matrix): each pair's label (agree, contradict, unrelated), the " +
    "reason, the compared spans and both sentences as evidence blocks, contradictions first. " +
    "Name the same witness twice for the comparisons between that witness's own statements. " +
    "Optional filter: an event name. Returns the label counts and at most 50 pairs.",
  inputSchema: {
    type: "object",
    properties: {
      witnessA: { type: "string", description: "A witness id." },
      witnessB: { type: "string", description: "A witness id." },
      event: { type: "string" },
    },
    required: ["witnessA", "witnessB"],
  },
  async run({ db, corpus }, input) {
    const witnessA = requiredText(input, "witnessA");
    const witnessB = requiredText(input, "witnessB");
    const eventId = await eventIdByName(db, optionalText(input, "event"));
    const comparisons = (await db.query(VIEW_SQL.byWitness, [witnessA, corpus])).rows;
    const pairs = (await resolvePairs(db, comparisons, null)).filter(
      (p) =>
        p.kind !== "accepted" &&
        ((p.a.witnessId === witnessA && p.b.witnessId === witnessB) ||
          (p.a.witnessId === witnessB && p.b.witnessId === witnessA)) &&
        (eventId === null || p.eventId === eventId),
    );
    const counts = { agree: 0, contradict: 0, unrelated: 0 };
    for (const p of pairs) counts[p.label] += 1;
    return withEvidence(db, pairs.slice(0, MAX_TOOL_ROWS).map(pairRow), {
      counts,
      truncated: pairs.length > MAX_TOOL_ROWS,
    });
  },
};
