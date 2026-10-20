// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Writes the comparison fixture into a migrated schema, row for row as the in-memory store holds
// it.
import { compareSeed } from "../core/compareFixture.mjs";

export async function seed(db) {
  const s = compareSeed();
  for (const w of s.witnesses) {
    await db.query("INSERT INTO witnesses (id, cipher_only, role) VALUES ($1, $2, $3)", [
      w.id,
      w.cipher_only,
      w.role,
    ]);
  }
  for (const e of s.events) {
    await db.query("INSERT INTO events (id, name) VALUES ($1, $2)", [e.id, e.name]);
  }
  for (const d of s.documents) {
    await db.query(
      `INSERT INTO documents (id, corpus, source_url, fetched_at, sha256, licence, format,
                              witness_id, statement_date, pipeline_version)
       VALUES ($1, $2, 'https://example.test', now(), repeat('0', 64), 'OGL-3.0', 'pdf', $3, $4, 'v')`,
      [d.id, d.corpus, d.witness_id, d.statement_date],
    );
  }
  for (const c of s.chunks) {
    await db.query(
      `INSERT INTO chunks (id, document_id, level, ordinal, text, locator, pipeline_version)
       VALUES ($1, $2, 'sentence', $3, $4, $5, 'v')`,
      [c.id, c.document_id, c.ordinal, c.text, c.locator],
    );
  }
  for (const a of s.assertions) {
    await db.query(
      `INSERT INTO assertions (id, witness_id, source_chunk_id, event_id, subject_text, subject_kind,
                               claim_kind, predicate, object_text, time_text, place_text, polarity,
                               modality, confidence, extractor, pipeline_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        a.id,
        a.witness_id,
        a.source_chunk_id,
        a.event_id,
        a.subject_text,
        a.subject_kind,
        a.claim_kind,
        a.predicate,
        a.object_text,
        a.time_text,
        a.place_text,
        a.polarity,
        a.modality,
        a.confidence,
        a.extractor,
        a.pipeline_version,
      ],
    );
  }
  for (const x of s.sessions) {
    await db.query("INSERT INTO sessions (id, user_id, corpus) VALUES ($1, $2, $3)", [
      x.id,
      x.user_id,
      x.corpus ?? "grenfell",
    ]);
  }
  for (const p of s.identityPairs) {
    await db.query(
      "INSERT INTO identity_revealing_pairs (document_a, document_b, reason, marked_by) VALUES ($1, $2, $3, $4)",
      [p.document_a, p.document_b, p.reason, p.marked_by],
    );
  }
}
