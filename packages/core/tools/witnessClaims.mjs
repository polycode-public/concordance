// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// witness_claims: the stored assertions of one witness in one corpus whose sentences are nearest
// the turn's question in meaning, in document order, each with that sentence as evidence.
import {
  assertionSide,
  eventIdByName,
  optionalText,
  questionVector,
  requiredText,
  withEvidence,
} from "./shared.mjs";

/** The tool returns at most this many assertions, the same count as one search's blocks. */
export const MAX_WITNESS_CLAIMS = 12;

export const WITNESS_CLAIMS_SQL = `
  SELECT a.id, a.witness_id, c.document_id, a.subject_text, a.predicate, a.object_text,
         a.time_text, a.place_text, a.polarity, a.modality, e.name AS event, a.source_chunk_id,
         c.ordinal
    FROM assertions a
    JOIN chunks c ON c.id = a.source_chunk_id
    LEFT JOIN events e ON e.id = a.event_id
   WHERE c.corpus = $1 AND a.witness_id = $2
     AND ($3::text IS NULL OR lower(a.predicate) = lower($3))
     AND ($4::bigint IS NULL OR a.event_id = $4::bigint)
   ORDER BY CASE WHEN c.embedding_model = $6 THEN c.embedding <=> $5::halfvec END NULLS LAST,
            c.document_id, c.ordinal, c.id, a.id
   LIMIT ${MAX_WITNESS_CLAIMS + 1}`;

const documentOrder = (x, y) =>
  String(x.document_id).localeCompare(String(y.document_id)) ||
  Number(x.ordinal) - Number(y.ordinal) ||
  Number(x.source_chunk_id) - Number(y.source_chunk_id) ||
  Number(x.id) - Number(y.id);

export const witnessClaims = {
  name: "witness_claims",
  description:
    `Lists the ${MAX_WITNESS_CLAIMS} stored assertions of one witness in this corpus whose ` +
    "sentences are nearest the question in meaning, in document order: subject, predicate, " +
    "object, stated time and place, polarity and event, each with the sentence that states it " +
    "as an evidence block. Optional filters: a predicate and an event name. Says when the " +
    "witness has more.",
  inputSchema: {
    type: "object",
    properties: {
      witness: { type: "string", description: "A witness id, for example IWS00000490." },
      predicate: { type: "string" },
      event: { type: "string" },
    },
    required: ["witness"],
  },
  async run(context, input) {
    const { db, corpus, provider } = context;
    const witness = requiredText(input, "witness");
    const predicate = optionalText(input, "predicate");
    const eventId = await eventIdByName(db, optionalText(input, "event"));
    const vector = await questionVector(context);
    const { rows } = await db.query(WITNESS_CLAIMS_SQL, [
      corpus,
      witness,
      predicate,
      eventId,
      vector,
      provider.embedModel,
    ]);
    const shown = rows
      .slice(0, MAX_WITNESS_CLAIMS)
      .sort(documentOrder)
      .map((r) => ({
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
    return withEvidence(db, shown, { truncated: rows.length > MAX_WITNESS_CLAIMS });
  },
};
