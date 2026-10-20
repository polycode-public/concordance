// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// corroborated_contradictions: the assertions of one corpus that two or more other witnesses
// contradict, by the newest label of each cross pair, grouped by event and predicate, with
// every side's sentence as evidence.
import { resolvePairs, VIEW_SQL } from "../facts/views.mjs";
import {
  MAX_TOOL_ROWS,
  ToolInputError,
  assertionSide,
  eventIdByName,
  eventNames,
  optionalText,
  pairRow,
  withEvidence,
} from "./shared.mjs";

const MIN_WITNESSES = 2;

function minWitnessesOf(input) {
  const value = input?.minWitnesses ?? MIN_WITNESSES;
  if (!Number.isInteger(value) || value < MIN_WITNESSES || value > 100) {
    throw new ToolInputError(`minWitnesses is a whole number from ${MIN_WITNESSES} to 100`);
  }
  return value;
}

export const corroboratedContradictions = {
  name: "corroborated_contradictions",
  description:
    "Lists the assertions in this corpus that two or more other witnesses contradict (or at " +
    "least minWitnesses), by the newest label of each cross-witness comparison, grouped by event " +
    "and predicate, most contradicting witnesses first. Each row has the assertion, every " +
    "contradicting pair with its reason, and every side's sentence as an evidence block. " +
    "Optional filter: an event name. Returns at most 50 assertions.",
  inputSchema: {
    type: "object",
    properties: {
      minWitnesses: { type: "integer", minimum: MIN_WITNESSES },
      event: { type: "string" },
    },
  },
  async run({ db, corpus }, input) {
    const minWitnesses = minWitnessesOf(input);
    const eventId = await eventIdByName(db, optionalText(input, "event"));
    const comparisons = (await db.query(VIEW_SQL.crossContradictions, [corpus, eventId])).rows;
    const pairs = await resolvePairs(db, comparisons, null);
    const byAssertion = new Map();
    for (const pair of pairs) {
      for (const [side, other] of [
        [pair.a, pair.b],
        [pair.b, pair.a],
      ]) {
        if (!other || other.witnessId === side.witnessId) continue;
        const entry = byAssertion.get(side.assertionId) ?? {
          side,
          eventId: pair.eventId,
          topic: pair.topic,
          witnesses: new Set(),
          pairs: [],
        };
        if (other.witnessId) entry.witnesses.add(other.witnessId);
        entry.pairs.push(pair);
        byAssertion.set(side.assertionId, entry);
      }
    }
    const kept = [...byAssertion.values()].filter((e) => e.witnesses.size >= minWitnesses);
    const names = await eventNames(
      db,
      kept.map((e) => e.eventId),
    );
    const rows = kept
      .map((e) => ({
        event: e.eventId ? (names.get(e.eventId) ?? null) : null,
        topic: e.eventId ? null : e.topic,
        predicate: e.side.predicate,
        witnesses: e.witnesses.size,
        assertion: assertionSide(e.side),
        contradictedBy: e.pairs.map(pairRow),
      }))
      .sort(
        (x, y) =>
          String(x.event ?? x.topic ?? "").localeCompare(String(y.event ?? y.topic ?? "")) ||
          x.predicate.localeCompare(y.predicate) ||
          y.witnesses - x.witnesses ||
          Number(x.assertion.assertionId) - Number(y.assertion.assertionId),
      );
    return withEvidence(db, rows.slice(0, MAX_TOOL_ROWS), {
      total: rows.length,
      truncated: rows.length > MAX_TOOL_ROWS,
    });
  },
};
