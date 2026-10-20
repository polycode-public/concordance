// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// count_assertions: the number of stored assertions of one corpus by witness, predicate or
// event, with an optional witness, predicate, event and clock range, and up to three example
// assertions per group as evidence.
import { factsTimeline } from "../facts/views.mjs";
import {
  MAX_TOOL_ROWS,
  clockRange,
  eventIdByName,
  eventNames,
  oneOf,
  optionalText,
  overlaps,
  withEvidence,
} from "./shared.mjs";

const GROUPS = ["witness", "predicate", "event"];
const EXAMPLES = 3;

const KEY = { witness: "a.witness_id", predicate: "a.predicate", event: "e.name" };

export const countSql = (groupBy) => `
  SELECT ${KEY[groupBy]} AS key, count(*)::int AS n, sum(count(*)) OVER ()::int AS total,
         string_agg(a.source_chunk_id::text, ',' ORDER BY a.id) AS chunk_ids
    FROM assertions a
    JOIN chunks c ON c.id = a.source_chunk_id
    LEFT JOIN events e ON e.id = a.event_id
   WHERE c.corpus = $1
     AND ($2::text IS NULL OR a.witness_id = $2)
     AND ($3::text IS NULL OR lower(a.predicate) = lower($3))
     AND ($4::bigint IS NULL OR a.event_id = $4::bigint)
   GROUP BY 1
   ORDER BY n DESC, key NULLS LAST
   LIMIT ${MAX_TOOL_ROWS + 1}`;

async function countInRange(db, { corpus, groupBy, witness, predicate, eventId, range }) {
  const { points } = await factsTimeline(db, {
    corpus,
    eventId: eventId,
    witnessId: witness,
  });
  const matching = points.filter(
    (p) =>
      overlaps(p.window, range) &&
      (predicate === null || p.predicate.toLowerCase() === predicate.toLowerCase()),
  );
  const names =
    groupBy === "event"
      ? await eventNames(
          db,
          matching.map((p) => p.eventId),
        )
      : new Map();
  const keyOf = {
    witness: (p) => p.witnessId,
    predicate: (p) => p.predicate,
    event: (p) => (p.eventId ? (names.get(p.eventId) ?? null) : null),
  }[groupBy];
  const groups = new Map();
  for (const p of matching) {
    const key = keyOf(p);
    const group = groups.get(key) ?? { key, n: 0, chunkIds: [] };
    group.n += 1;
    if (group.chunkIds.length < EXAMPLES) group.chunkIds.push(p.chunkId);
    groups.set(key, group);
  }
  return {
    total: matching.length,
    groups: [...groups.values()].sort(
      (x, y) => y.n - x.n || String(x.key ?? "￿").localeCompare(String(y.key ?? "￿")),
    ),
  };
}

export const countAssertions = {
  name: "count_assertions",
  description:
    "Counts the stored witness assertions of this corpus, grouped by witness id, predicate or " +
    "event name. Filters: one witness id, one predicate, one event name, and a clock range " +
    "(from and to as HH:MM on the night; a time from 18:00 is the evening before) that keeps " +
    "assertions whose stated time overlaps it. Returns at most 50 groups, largest first, each " +
    "with up to 3 example assertions as evidence blocks.",
  inputSchema: {
    type: "object",
    properties: {
      groupBy: { type: "string", enum: GROUPS },
      witness: { type: "string", description: "A witness id, for example IWS00000490." },
      predicate: { type: "string" },
      event: { type: "string", description: "An event name as the store holds it." },
      from: { type: "string", description: "HH:MM" },
      to: { type: "string", description: "HH:MM" },
    },
    required: ["groupBy"],
  },
  async run({ db, corpus }, input) {
    const groupBy = oneOf(input, "groupBy", GROUPS);
    const witness = optionalText(input, "witness");
    const predicate = optionalText(input, "predicate");
    const eventId = await eventIdByName(db, optionalText(input, "event"));
    const range = clockRange(input);
    let total;
    let groups;
    if (range) {
      ({ total, groups } = await countInRange(db, {
        corpus,
        groupBy,
        witness,
        predicate,
        eventId,
        range,
      }));
    } else {
      const { rows } = await db.query(countSql(groupBy), [corpus, witness, predicate, eventId]);
      total = rows.length ? Number(rows[0].total) : 0;
      groups = rows.map((r) => ({
        key: r.key ?? null,
        n: Number(r.n),
        chunkIds: r.chunk_ids ? String(r.chunk_ids).split(",").slice(0, EXAMPLES) : [],
      }));
    }
    const shown = groups.slice(0, MAX_TOOL_ROWS).map((g) => ({
      [groupBy]: g.key,
      count: g.n,
      examples: g.chunkIds.map((chunkId) => ({ chunkId })),
    }));
    return withEvidence(db, shown, { total, truncated: groups.length > MAX_TOOL_ROWS });
  },
};
