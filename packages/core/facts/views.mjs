// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The fact-store views and a person's actions on them, shared by the HTTP API Lambda and the
// laptop server: the groups, the contradiction matrix of one group, a witness's consistency
// report, the timeline, a person's relabel, promotion to an accepted fact, and a session
// hypothesis. A pair's label is its newest person's row when one exists, else its newest machine
// row. A pair whose two documents reveal an identity together is returned without its two
// sentences, so no client can show them side by side. A hypothesis is visible to its own user only.

import { isUuid } from "../sessions.mjs";
import { pairKey as pairKeyOf } from "./align.mjs";
import { labelsFor } from "./nli.mjs";
import { pairKey as documentPair } from "./registers.mjs";
import { timelinePoints } from "./timeline.mjs";

export const OPERATOR_MODEL = "operator";
export const REASON_LIMIT = 500;
export const TEXT_LIMIT = 2000;
const TIMELINE_PAGE = 1000;
const LABEL_WEIGHT = {
  contradict: 3,
  inconsistent: 3,
  agree: 2,
  consistent: 2,
  unrelated: 1,
  not_covered: 1,
};

const ISO = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const columns = (p = "") =>
  [
    "id",
    "kind",
    "assertion_a",
    "assertion_b",
    "accepted_fact_id",
    "label",
    "reason",
    "span_a",
    "span_b",
    "model",
    "decided_by",
    "overrides",
    "event_id",
    "topic",
    "similarity",
  ]
    .map((c) => `${p}${c}`)
    .concat(`${ISO(`${p}run_at`)} AS run_at`)
    .join(", ");
const COMPARISON_COLUMNS = columns();

export const VIEW_SQL = Object.freeze({
  groups: `
  WITH latest AS (
    SELECT DISTINCT ON (kind, assertion_a, coalesce(assertion_b, 0), coalesce(accepted_fact_id, 0))
           kind, event_id, topic, label
      FROM assertion_comparisons
     ORDER BY kind, assertion_a, coalesce(assertion_b, 0), coalesce(accepted_fact_id, 0),
              (model = 'operator') DESC, run_at DESC, id DESC)
  SELECT l.event_id, e.name, CASE WHEN l.event_id IS NULL THEN l.topic END AS topic,
         count(*) AS pairs,
         count(*) FILTER (WHERE l.label = 'contradict') AS contradictions
    FROM latest l LEFT JOIN events e ON e.id = l.event_id
   WHERE l.kind <> 'accepted'
   GROUP BY l.event_id, e.name, CASE WHEN l.event_id IS NULL THEN l.topic END`,
  byEvent: `SELECT ${COMPARISON_COLUMNS} FROM assertion_comparisons WHERE event_id = $1::bigint`,
  byTopic: `SELECT ${COMPARISON_COLUMNS} FROM assertion_comparisons
   WHERE event_id IS NULL AND topic = $1`,
  byWitness: `SELECT ${columns("c.")}
    FROM assertion_comparisons c
    JOIN assertions a ON a.id = c.assertion_a
    LEFT JOIN assertions b ON b.id = c.assertion_b
   WHERE a.witness_id = $1 OR b.witness_id = $1`,
  comparison: `SELECT ${COMPARISON_COLUMNS} FROM assertion_comparisons WHERE id = $1::bigint`,
  event: `SELECT id, name FROM events WHERE id = $1::bigint`,
  assertions: `
  SELECT a.id, a.witness_id, w.cipher_only, a.event_id, a.predicate, a.object_text, a.time_text,
         a.place_text, a.polarity, a.modality, a.source_chunk_id, c.document_id,
         c.text AS sentence, c.locator, to_char(d.statement_date, 'YYYY-MM-DD') AS statement_date
    FROM assertions a
    JOIN chunks c ON c.id = a.source_chunk_id
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN witnesses w ON w.id = a.witness_id
   WHERE a.id = ANY($1::bigint[])`,
  facts: `
  SELECT f.id, f.assertion_id, f.text, f.source_citation, f.promoted_by, f.is_hypothesis,
         f.session_id, s.user_id AS session_user, ${ISO("f.promoted_at")} AS promoted_at
    FROM accepted_facts f LEFT JOIN sessions s ON s.id = f.session_id
   WHERE f.id = ANY($1::bigint[])`,
  identityPairs: `
  SELECT document_a, document_b FROM identity_revealing_pairs
   WHERE document_a = ANY($1::text[]) AND document_b = ANY($1::text[])`,
  witness: `SELECT id, cipher_only, role FROM witnesses WHERE id = $1`,
  witnessDocuments: `
  SELECT id, to_char(statement_date, 'YYYY-MM-DD') AS statement_date FROM documents
   WHERE witness_id = $1 ORDER BY statement_date NULLS LAST, id`,
  timeline: `
  SELECT a.id, a.witness_id, a.event_id, a.predicate, a.object_text, a.time_text, a.polarity,
         a.modality, a.source_chunk_id, c.document_id, c.locator
    FROM assertions a JOIN chunks c ON c.id = a.source_chunk_id
   WHERE a.time_text IS NOT NULL
     AND ($1::bigint IS NULL OR a.event_id = $1::bigint)
     AND ($2::text IS NULL OR a.witness_id = $2)
     AND a.id > $3::bigint
   ORDER BY a.id LIMIT $4`,
  insertOverride: `
  INSERT INTO assertion_comparisons (kind, assertion_a, assertion_b, accepted_fact_id, label,
                                     reason, span_a, span_b, model, decided_by, overrides,
                                     event_id, topic, similarity)
  VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5, $6, $7, $8, 'operator', $9, $10::bigint,
          $11::bigint, $12, $13)
  RETURNING id, ${ISO("run_at")} AS run_at`,
  sessionUser: `SELECT user_id FROM sessions WHERE id = $1::uuid`,
  insertFact: `
  INSERT INTO accepted_facts (assertion_id, text, source_citation, promoted_by, session_id,
                              is_hypothesis)
  VALUES ($1::bigint, $2, $3, $4, $5::uuid, $6)
  RETURNING id, ${ISO("promoted_at")} AS promoted_at`,
});

const str = (v) => (v === null || v === undefined ? null : String(v));
const time = (v) => (v instanceof Date ? v.toISOString() : v);

/** A comparison row in the shape the views read. */
export function comparisonFromRow(r) {
  return {
    id: String(r.id),
    kind: r.kind,
    assertionA: String(r.assertion_a),
    assertionB: str(r.assertion_b),
    factId: str(r.accepted_fact_id),
    label: r.label,
    reason: r.reason ?? null,
    spanA: r.span_a ?? null,
    spanB: r.span_b ?? null,
    model: r.model,
    decidedBy: r.decided_by ?? null,
    overrides: str(r.overrides),
    eventId: str(r.event_id),
    topic: r.topic ?? null,
    similarity: r.similarity === null || r.similarity === undefined ? null : Number(r.similarity),
    runAt: time(r.run_at),
  };
}

const keyOf = (c) =>
  pairKeyOf({
    kind: c.kind,
    a: { id: c.assertionA },
    b: c.assertionB ? { id: c.assertionB } : null,
    fact: c.factId ? { id: c.factId } : null,
  });

const newer = (x, y) =>
  String(x.runAt).localeCompare(String(y.runAt)) || Number(x.id) - Number(y.id);

/**
 * The label each pair shows: its newest person's row, else its newest machine row. The newest
 * machine row comes along when a person's row wins, so the page can show what was overridden.
 * @param {ReturnType<typeof comparisonFromRow>[]} rows
 */
export function latestPerPair(rows) {
  const byPair = new Map();
  for (const row of rows) {
    const k = keyOf(row);
    const entry = byPair.get(k) ?? { person: null, machine: null };
    const slot = row.model === OPERATOR_MODEL ? "person" : "machine";
    if (!entry[slot] || newer(row, entry[slot]) > 0) entry[slot] = row;
    byPair.set(k, entry);
  }
  return [...byPair.values()].map(({ person, machine }) => ({
    shown: person ?? machine,
    machine: person ? machine : null,
  }));
}

/** The groups that have pairs, most contradictions first. */
export async function factsGroups(db) {
  const { rows } = await db.query(VIEW_SQL.groups);
  const groups = rows.map((r) => ({
    eventId: str(r.event_id),
    name: r.name ?? null,
    topic: r.topic ?? null,
    pairs: Number(r.pairs),
    contradictions: Number(r.contradictions),
  }));
  groups.sort(
    (x, y) =>
      y.contradictions - x.contradictions ||
      y.pairs - x.pairs ||
      String(x.name ?? x.topic).localeCompare(String(y.name ?? y.topic)),
  );
  return groups;
}

function sideOf(a, hideSentence) {
  return {
    assertionId: String(a.id),
    witnessId: a.witness_id ?? null,
    cipherOnly: Boolean(a.cipher_only),
    documentId: a.document_id,
    statementDate: a.statement_date ?? null,
    chunkId: str(a.source_chunk_id),
    locator: a.locator ?? {},
    sentence: hideSentence ? null : a.sentence,
    predicate: a.predicate,
    objectText: a.object_text ?? null,
    timeText: a.time_text ?? null,
    placeText: a.place_text ?? null,
    polarity: a.polarity,
  };
}

/**
 * The pairs of some comparison rows with both sides, the accepted fact, and the identity flag.
 * Hypotheses of other users and pairs whose assertions are gone are left out.
 */
async function resolvePairs(db, rows, userId) {
  const chosen = latestPerPair(rows.map(comparisonFromRow));
  const assertionIds = [
    ...new Set(chosen.flatMap(({ shown }) => [shown.assertionA, shown.assertionB].filter(Boolean))),
  ];
  const factIds = [...new Set(chosen.map(({ shown }) => shown.factId).filter(Boolean))];
  const assertions = new Map();
  if (assertionIds.length) {
    for (const r of (await db.query(VIEW_SQL.assertions, [assertionIds])).rows) {
      assertions.set(String(r.id), r);
    }
  }
  const facts = new Map();
  if (factIds.length) {
    for (const r of (await db.query(VIEW_SQL.facts, [factIds])).rows) facts.set(String(r.id), r);
  }
  const documents = [...new Set([...assertions.values()].map((a) => a.document_id))];
  const revealing = new Set();
  if (documents.length > 1) {
    for (const r of (await db.query(VIEW_SQL.identityPairs, [documents])).rows) {
      revealing.add(`${r.document_a}\u0000${r.document_b}`);
    }
  }
  const pairs = [];
  for (const { shown, machine } of chosen) {
    const a = assertions.get(shown.assertionA);
    const b = shown.assertionB ? assertions.get(shown.assertionB) : null;
    if (!a || (shown.assertionB && !b)) continue;
    const factRow = shown.factId ? facts.get(shown.factId) : null;
    if (shown.factId && !factRow) continue;
    if (factRow?.is_hypothesis && factRow.session_user !== userId) continue;
    const identityRevealing =
      Boolean(b) &&
      a.document_id !== b.document_id &&
      revealing.has(documentPair(a.document_id, b.document_id).join("\u0000"));
    pairs.push({
      id: shown.id,
      kind: shown.kind,
      label: shown.label,
      reason: shown.reason,
      spanA: shown.spanA,
      spanB: shown.spanB,
      model: shown.model,
      decidedBy: shown.decidedBy,
      runAt: shown.runAt,
      similarity: shown.similarity,
      eventId: shown.eventId,
      topic: shown.topic,
      machine: machine
        ? { id: machine.id, label: machine.label, reason: machine.reason, model: machine.model }
        : null,
      identityRevealing,
      a: sideOf(a, identityRevealing),
      b: b ? sideOf(b, identityRevealing) : null,
      fact: factRow
        ? {
            id: String(factRow.id),
            text: factRow.text,
            sourceCitation: factRow.source_citation,
            isHypothesis: Boolean(factRow.is_hypothesis),
            promotedBy: factRow.promoted_by,
          }
        : null,
    });
  }
  pairs.sort(
    (x, y) =>
      LABEL_WEIGHT[y.label] - LABEL_WEIGHT[x.label] ||
      (y.similarity ?? 0) - (x.similarity ?? 0) ||
      Number(x.id) - Number(y.id),
  );
  return pairs;
}

const cellKey = (x, y) => (x <= y ? [x, y] : [y, x]);

/** The matrix cells of self and cross pairs: one per unordered witness pair, worst label first. */
export function matrixCells(pairs) {
  const cells = new Map();
  for (const p of pairs) {
    if (p.kind === "accepted") continue;
    const [x, y] = cellKey(p.a.witnessId, p.b.witnessId);
    const k = `${x}\u0000${y}`;
    const cell = cells.get(k) ?? {
      witnessA: x,
      witnessB: y,
      label: null,
      counts: { agree: 0, contradict: 0, unrelated: 0 },
      pairIds: [],
    };
    cell.counts[p.label] += 1;
    cell.pairIds.push(p.id);
    if (!cell.label || LABEL_WEIGHT[p.label] > LABEL_WEIGHT[cell.label]) cell.label = p.label;
    cells.set(k, cell);
  }
  return [...cells.values()].sort(
    (p, q) => p.witnessA.localeCompare(q.witnessA) || p.witnessB.localeCompare(q.witnessB),
  );
}

/** The witnesses on the matrix axes, by id. A witness is known by its id or cipher only. */
function axis(pairs) {
  const out = new Map();
  for (const p of pairs) {
    for (const side of [p.a, p.b]) {
      if (side?.witnessId)
        out.set(side.witnessId, { id: side.witnessId, cipherOnly: side.cipherOnly });
    }
  }
  return [...out.values()].sort((x, y) => x.id.localeCompare(y.id));
}

/**
 * The contradiction matrix of one group: an event by id, or a predicate where no event is named.
 * @param {{ query: Function }} db
 * @param {{ eventId?: string, topic?: string, userId: string }} which
 */
export async function factsMatrix(db, { eventId, topic, userId }) {
  let group;
  let rows;
  if (eventId) {
    const event = (await db.query(VIEW_SQL.event, [eventId])).rows[0];
    if (!event) return null;
    group = { eventId: String(event.id), name: event.name, topic: null };
    rows = (await db.query(VIEW_SQL.byEvent, [eventId])).rows;
  } else {
    group = { eventId: null, name: null, topic };
    rows = (await db.query(VIEW_SQL.byTopic, [topic])).rows;
  }
  const pairs = await resolvePairs(db, rows, userId);
  const witnessPairs = pairs.filter((p) => p.kind !== "accepted");
  return {
    group,
    witnesses: axis(witnessPairs),
    cells: matrixCells(witnessPairs),
    pairs: witnessPairs,
    accepted: pairs.filter((p) => p.kind === "accepted"),
  };
}

/**
 * One witness's consistency report: their documents by statement date, their own pairs across
 * documents, their cross pairs counted by the other witness, and their accepted-fact labels.
 */
export async function witnessReport(db, { witnessId, userId }) {
  const witness = (await db.query(VIEW_SQL.witness, [witnessId])).rows[0];
  if (!witness) return null;
  const documents = (await db.query(VIEW_SQL.witnessDocuments, [witnessId])).rows.map((d) => ({
    id: d.id,
    statementDate: d.statement_date ?? null,
  }));
  const pairs = await resolvePairs(
    db,
    (await db.query(VIEW_SQL.byWitness, [witnessId])).rows,
    userId,
  );
  const self = pairs
    .filter((p) => p.kind === "self")
    .sort(
      (x, y) =>
        String(x.a.statementDate).localeCompare(String(y.a.statementDate)) ||
        String(x.b.statementDate).localeCompare(String(y.b.statementDate)) ||
        Number(x.id) - Number(y.id),
    );
  const crossBy = new Map();
  for (const p of pairs.filter((q) => q.kind === "cross")) {
    const other = p.a.witnessId === witnessId ? p.b : p.a;
    const entry = crossBy.get(other.witnessId) ?? {
      witnessId: other.witnessId,
      cipherOnly: other.cipherOnly,
      counts: { agree: 0, contradict: 0, unrelated: 0 },
    };
    entry.counts[p.label] += 1;
    crossBy.set(other.witnessId, entry);
  }
  return {
    witness: {
      id: witness.id,
      cipherOnly: Boolean(witness.cipher_only),
      role: witness.role ?? null,
    },
    documents,
    self,
    cross: [...crossBy.values()].sort(
      (x, y) => y.counts.contradict - x.counts.contradict || x.witnessId.localeCompare(y.witnessId),
    ),
    accepted: pairs.filter((p) => p.kind === "accepted" && p.a.witnessId === witnessId),
  };
}

/** The timeline over every assertion with a time phrase, optionally of one event or witness. */
export async function factsTimeline(db, { eventId = null, witnessId = null } = {}) {
  const rows = [];
  for (;;) {
    const after = rows.at(-1)?.id ?? "0";
    const page = (
      await db.query(VIEW_SQL.timeline, [eventId, witnessId, String(after), TIMELINE_PAGE])
    ).rows;
    rows.push(...page);
    if (page.length < TIMELINE_PAGE) break;
  }
  return timelinePoints(
    rows.map((r) => ({
      assertionId: String(r.id),
      witnessId: r.witness_id ?? null,
      eventId: str(r.event_id),
      documentId: r.document_id,
      chunkId: str(r.source_chunk_id),
      locator: r.locator ?? {},
      predicate: r.predicate,
      objectText: r.object_text ?? null,
      timeText: r.time_text,
      polarity: r.polarity,
      modality: r.modality ?? null,
    })),
  );
}

export class FactsInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const text = (value, name, limit, required = true) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new FactsInputError(`The request needs ${name}.`);
    return null;
  }
  if (typeof value !== "string" || !value.trim()) throw new FactsInputError(`${name} is not text.`);
  if (value.length > limit) throw new FactsInputError(`${name} is over ${limit} characters.`);
  return value.trim();
};

const DIGITS = /^[1-9][0-9]{0,18}$/;
const numericId = (value, name, required = true) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new FactsInputError(`The request needs ${name}.`);
    return null;
  }
  const s = String(value);
  if (!DIGITS.test(s)) throw new FactsInputError(`${name} is not an id.`);
  return s;
};

/** A person's relabel of a pair, stored as a new row that wins over every machine row. */
export async function overrideLabel(db, { comparisonId, label, reason, userId }) {
  const idValue = numericId(comparisonId, "comparisonId");
  const why = text(reason, "a reason", REASON_LIMIT);
  const row = (await db.query(VIEW_SQL.comparison, [idValue])).rows[0];
  if (!row) throw new FactsInputError("No such comparison.", 404);
  const c = comparisonFromRow(row);
  if (!labelsFor(c.kind).includes(label)) {
    throw new FactsInputError(`A ${c.kind} pair takes ${labelsFor(c.kind).join(", ")}.`);
  }
  const stored = (
    await db.query(VIEW_SQL.insertOverride, [
      c.kind,
      c.assertionA,
      c.assertionB,
      c.factId,
      label,
      why,
      c.spanA,
      c.spanB,
      userId,
      c.id,
      c.eventId,
      c.topic,
      c.similarity,
    ])
  ).rows[0];
  return {
    id: String(stored.id),
    overrides: c.id,
    kind: c.kind,
    label,
    reason: why,
    model: OPERATOR_MODEL,
    decidedBy: userId,
    runAt: time(stored.run_at),
    previous: { label: c.label, reason: c.reason, model: c.model },
  };
}

async function storeFact(db, { assertionId, factText, citation, userId, sessionId }) {
  let body = factText;
  if (assertionId) {
    const a = (await db.query(VIEW_SQL.assertions, [[assertionId]])).rows[0];
    if (!a) throw new FactsInputError("No such assertion.", 404);
    body ??= a.sentence;
  }
  if (!body) throw new FactsInputError("The request needs an assertionId or a text.");
  const stored = (
    await db.query(VIEW_SQL.insertFact, [
      assertionId,
      body,
      citation,
      userId,
      sessionId,
      Boolean(sessionId),
    ])
  ).rows[0];
  return {
    id: String(stored.id),
    assertionId,
    text: body,
    sourceCitation: citation,
    promotedBy: userId,
    promotedAt: time(stored.promoted_at),
    isHypothesis: Boolean(sessionId),
    sessionId: sessionId ?? null,
  };
}

/** Promotes an assertion, or a typed text, to an accepted fact with its source citation. */
export function acceptFact(db, { assertionId, text: typed, sourceCitation, userId }) {
  return storeFact(db, {
    assertionId: numericId(assertionId, "assertionId", false),
    factText: text(typed, "text", TEXT_LIMIT, false),
    citation: text(sourceCitation, "a sourceCitation", REASON_LIMIT),
    userId,
  });
}

/** A session hypothesis: an accepted fact scoped to one of the user's sessions. */
export async function addHypothesis(
  db,
  { sessionId, text: typed, assertionId, sourceCitation, userId },
) {
  if (!isUuid(sessionId)) throw new FactsInputError("The request needs a sessionId (UUID).");
  const owner = (await db.query(VIEW_SQL.sessionUser, [sessionId])).rows[0];
  if (!owner || owner.user_id !== userId) throw new FactsInputError("No such session.", 404);
  return storeFact(db, {
    assertionId: numericId(assertionId, "assertionId", false),
    factText: text(typed, "text", TEXT_LIMIT, false),
    citation: text(sourceCitation, "a sourceCitation", REASON_LIMIT, false) ?? "session hypothesis",
    userId,
    sessionId,
  });
}

const WITNESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const get = (query, name) =>
  typeof query?.get === "function" ? query.get(name) : (query?.[name] ?? null);

/**
 * Answers one facts route.
 * @param {{ query: Function }} db
 * @param {{ method: string, path: string, query?: URLSearchParams | Record<string, string>,
 *   body?: unknown, userId: string }} request
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function factsResponse(db, { method, path, query, body, userId }) {
  const route = path.replace(/\/+$/, "");
  const reads = ["/facts/groups", "/facts/matrix", "/facts/timeline"];
  const writes = ["/facts/override", "/facts/accept", "/facts/hypothesis"];
  const isWitness = route.startsWith("/facts/witness/");
  if (!reads.includes(route) && !writes.includes(route) && !isWitness) {
    return { status: 404, body: { message: "No such facts route." } };
  }
  const wantsPost = writes.includes(route);
  if (method !== (wantsPost ? "POST" : "GET")) {
    return { status: 405, body: { message: `Use ${wantsPost ? "POST" : "GET"}.` } };
  }
  try {
    if (route === "/facts/groups") return { status: 200, body: { groups: await factsGroups(db) } };
    if (route === "/facts/matrix") {
      const eventId = numericId(get(query, "event"), "event", false);
      const topic = eventId ? null : text(get(query, "topic"), "an event or a topic", 200);
      const matrix = await factsMatrix(db, { eventId, topic, userId });
      if (!matrix) return { status: 404, body: { message: "No such event." } };
      return { status: 200, body: matrix };
    }
    if (route === "/facts/timeline") {
      const eventId = numericId(get(query, "event"), "event", false);
      const witnessId = get(query, "witness") || null;
      if (witnessId && !WITNESS_ID.test(witnessId))
        throw new FactsInputError("witness is not an id.");
      return { status: 200, body: await factsTimeline(db, { eventId, witnessId }) };
    }
    if (isWitness) {
      let witnessId;
      try {
        witnessId = decodeURIComponent(route.slice("/facts/witness/".length));
      } catch {
        throw new FactsInputError("The witness id is not an id.");
      }
      if (!WITNESS_ID.test(witnessId)) throw new FactsInputError("The witness id is not an id.");
      const report = await witnessReport(db, { witnessId, userId });
      if (!report) return { status: 404, body: { message: "No such witness." } };
      return { status: 200, body: report };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new FactsInputError("The request body is not a JSON object.");
    }
    if (route === "/facts/override") {
      return { status: 201, body: { comparison: await overrideLabel(db, { ...body, userId }) } };
    }
    if (route === "/facts/accept") {
      return { status: 201, body: { fact: await acceptFact(db, { ...body, userId }) } };
    }
    return { status: 201, body: { fact: await addHypothesis(db, { ...body, userId }) } };
  } catch (err) {
    if (err instanceof FactsInputError)
      return { status: err.status, body: { message: err.message } };
    throw err;
  }
}
