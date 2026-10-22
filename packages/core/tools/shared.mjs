// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// What every tool over the store shares: the row cap, the reading of the model's input, the
// evidence block of a stored chunk, and the side of an assertion as a tool row shows it.
import { EVENING_FROM_HOUR } from "../facts/timeline.mjs";
import { blockFromRow, loadDocuments, withDocuments } from "../retrieval/expand.mjs";
import { halfvecLiteral, loadChunks } from "../retrieval/hybrid.mjs";

/** A tool returns at most this many rows. */
export const MAX_TOOL_ROWS = 50;

export class ToolInputError extends Error {
  name = "ToolInputError";
}

const MAX_INPUT = 200;

/**
 * An optional text field of the model's input, trimmed, or null.
 * @param {object} input
 * @param {string} key
 */
export function optionalText(input, key) {
  const value = input?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_INPUT) {
    throw new ToolInputError(`${key} is not a text of 1 to ${MAX_INPUT} characters`);
  }
  return value.trim();
}

/** A required text field of the model's input. */
export function requiredText(input, key) {
  const value = optionalText(input, key);
  if (value === null) throw new ToolInputError(`the tool needs ${key}`);
  return value;
}

/** One of the allowed values of a field. */
export function oneOf(input, key, values) {
  const value = input?.[key];
  if (!values.includes(value)) {
    throw new ToolInputError(`${key} is one of ${values.join(", ")}`);
  }
  return value;
}

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Minutes after the local midnight of the night's day for an HH:MM reading, on the scale the
 * timeline uses: a reading from 18:00 is the evening before, so it is negative.
 * @param {string} clock
 */
export function clockMinutes(clock) {
  const match = CLOCK.exec(clock);
  if (!match) throw new ToolInputError(`${JSON.stringify(clock)} is not an HH:MM clock time`);
  const hour = Number(match[1]);
  const total = hour * 60 + Number(match[2]);
  return hour >= EVENING_FROM_HOUR ? total - 24 * 60 : total;
}

/**
 * The clock range of the input's from and to, in timeline minutes, or null when neither is
 * given.
 * @param {object} input
 */
export function clockRange(input) {
  const from = optionalText(input, "from");
  const to = optionalText(input, "to");
  if (from === null && to === null) return null;
  if (from === null || to === null) throw new ToolInputError("from and to come together");
  const range = { from: clockMinutes(from), to: clockMinutes(to) };
  if (range.to < range.from) throw new ToolInputError("to is earlier than from");
  return range;
}

/** True when a parsed time window shares a minute with a clock range. */
export const overlaps = (window, range) =>
  window.endMinutes >= range.from && window.startMinutes <= range.to;

const questionVectors = new WeakMap();

/**
 * The halfvec literal of the turn's question, embedded once for all the tool calls of the turn.
 * @param {{ question?: string, provider: { embed: Function } }} context
 * @returns {Promise<string>}
 */
export function questionVector(context) {
  if (typeof context.question !== "string" || !context.question.trim()) {
    throw new Error("the tool needs the turn's question");
  }
  let vector = questionVectors.get(context);
  if (!vector) {
    vector = context.provider.embed([context.question]).then(([v]) => halfvecLiteral(v));
    questionVectors.set(context, vector);
  }
  return vector;
}

/**
 * The id of the event that a name names, case-insensitively, or null for no name. A name that
 * names no event gives "0", an id that no event has, so it matches no row.
 * @param {{ query: Function }} db
 * @param {string | null} name
 */
export async function eventIdByName(db, name) {
  if (name === null) return null;
  const { rows } = await db.query(`SELECT id FROM events WHERE lower(name) = lower($1)`, [name]);
  return rows.length ? String(rows[0].id) : "0";
}

/**
 * The evidence block of each stored chunk, with the facts of its document, in the order given.
 * @param {{ query: Function }} db
 * @param {string[]} chunkIds
 */
export async function chunkEvidence(db, chunkIds) {
  const ids = [...new Set(chunkIds.map(String))];
  if (!ids.length) return [];
  const rows = await loadChunks(db, ids);
  const blocks = ids.map((id) => {
    const row = rows.get(id);
    if (!row) throw new Error(`chunk ${id} was not loaded`);
    return { ...blockFromRow(row, row.text), chunkIds: [id] };
  });
  return withDocuments(
    blocks,
    await loadDocuments(
      db,
      blocks.map((b) => b.documentId),
    ),
  );
}

/**
 * One assertion as a tool row shows it. The chunk id names the evidence that states it.
 * @param {object} a  a side from resolvePairs, or a timeline point
 */
export const assertionSide = (a) => ({
  assertionId: a.assertionId,
  witnessId: a.witnessId ?? null,
  documentId: a.documentId,
  subject: a.subjectText ?? null,
  predicate: a.predicate,
  object: a.objectText ?? null,
  time: a.timeText ?? null,
  polarity: a.polarity,
  chunkId: a.chunkId,
});

/** The chunk ids that a list of tool rows names, at any depth. */
export function chunkIdsOf(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) chunkIdsOf(item, out);
  } else if (value && typeof value === "object") {
    if (typeof value.chunkId === "string") out.push(value.chunkId);
    for (const [key, item] of Object.entries(value)) if (key !== "chunkId") chunkIdsOf(item, out);
  }
  return out;
}

/**
 * The result of a tool: its rows and the evidence block of every chunk they name.
 * @param {{ query: Function }} db
 * @param {object[]} rows
 * @param {object} [extra] fields beside the rows, such as truncated or total
 */
export async function withEvidence(db, rows, extra = {}) {
  return { rows, ...extra, evidence: await chunkEvidence(db, chunkIdsOf(rows)) };
}

/** The side of an identity-revealing pair: who, and nothing that shows the sentence. */
const hiddenSide = (side) => ({ assertionId: side.assertionId, witnessId: side.witnessId ?? null });

/**
 * One comparison pair from resolvePairs as a tool row shows it. A pair whose two documents reveal
 * an identity together carries neither sentence, span nor reason, so no evidence block shows the
 * two side by side.
 * @param {object} pair
 */
export function pairRow(pair) {
  const hide = pair.identityRevealing;
  return {
    comparisonId: pair.id,
    kind: pair.kind,
    label: pair.label,
    decidedBy: pair.decidedBy ?? "machine",
    identityRevealing: hide,
    reason: hide ? null : pair.reason,
    spanA: hide ? null : pair.spanA,
    spanB: hide ? null : pair.spanB,
    a: hide ? hiddenSide(pair.a) : assertionSide(pair.a),
    b: hide ? hiddenSide(pair.b) : assertionSide(pair.b),
  };
}

const EVENT_NAMES = `SELECT id, name FROM events WHERE id = ANY($1::bigint[])`;

/**
 * The names of some events by id.
 * @param {{ query: Function }} db
 * @param {(string | null)[]} eventIds
 * @returns {Promise<Map<string, string>>}
 */
export async function eventNames(db, eventIds) {
  const ids = [...new Set(eventIds.filter(Boolean))];
  const names = new Map();
  if (!ids.length) return names;
  for (const r of (await db.query(EVENT_NAMES, [ids])).rows) names.set(String(r.id), r.name);
  return names;
}
