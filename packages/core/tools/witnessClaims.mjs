// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// witness_claims: one witness's stored assertions in one corpus, in document order, each with
// the sentence that states it as evidence.
import {
  MAX_TOOL_ROWS,
  assertionSide,
  eventIdByName,
  optionalText,
  requiredText,
  withEvidence,
} from "./shared.mjs";

export const WITNESS_CLAIMS_SQL = `
  SELECT a.id, a.witness_id, c.document_id, a.subject_text, a.predicate, a.object_text,
         a.time_text, a.place_text, a.polarity, a.modality, e.name AS event, a.source_chunk_id
    FROM assertions a
    JOIN chunks c ON c.id = a.source_chunk_id
    LEFT JOIN events e ON e.id = a.event_id
   WHERE c.corpus = $1 AND a.witness_id = $2
     AND ($3::text IS NULL OR lower(a.predicate) = lower($3))
     AND ($4::bigint IS NULL OR a.event_id = $4::bigint)
   ORDER BY c.document_id, c.ordinal, c.id, a.id
   LIMIT ${MAX_TOOL_ROWS + 1}`;

export const witnessClaims = {
  name: "witness_claims",
  description:
    "Lists one witness's stored assertions in this corpus in document order: subject, " +
    "predicate, object, stated time and place, polarity and event, each with the sentence that " +
    "states it as an evidence block. Optional filters: a predicate and an event name. Returns at " +
    "most 50 assertions and says when there are more.",
  inputSchema: {
    type: "object",
    properties: {
      witness: { type: "string", description: "A witness id, for example IWS00000490." },
      predicate: { type: "string" },
      event: { type: "string" },
    },
    required: ["witness"],
  },
  async run({ db, corpus }, input) {
    const witness = requiredText(input, "witness");
    const predicate = optionalText(input, "predicate");
    const eventId = await eventIdByName(db, optionalText(input, "event"));
    const { rows } = await db.query(WITNESS_CLAIMS_SQL, [corpus, witness, predicate, eventId]);
    const shown = rows.slice(0, MAX_TOOL_ROWS).map((r) => ({
      ...assertionSide({
        assertionId: String(r.id),
        witnessId: r.witness_id,
        documentId: r.document_id,
        subjectText: r.subject_text,
        predicate: r.predicate,
        objectText: r.object_text,
        timeText: r.time_text,
        polarity: r.polarity,
        chunkId: String(r.source_chunk_id),
      }),
      place: r.place_text ?? null,
      modality: r.modality ?? null,
      event: r.event ?? null,
    }));
    return withEvidence(db, shown, { truncated: rows.length > MAX_TOOL_ROWS });
  },
};
