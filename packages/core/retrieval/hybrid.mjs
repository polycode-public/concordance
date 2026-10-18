// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Hybrid retrieval over the chunks table: lexical (tsvector) and vector (HNSW,
// cosine) rankings at passage and section level, fused by reciprocal rank.
import { reciprocalRankFusion } from "./rrf.mjs";

/** The dimension of chunks.embedding in the schema. */
export const CHUNK_EMBED_DIM = 1024;

export const RANK_LIMITS = Object.freeze({ passage: 40, section: 20 });

const CHUNK_COLUMNS = [
  "id",
  "document_id",
  "level",
  "text",
  "header",
  "locator",
  "prev_id",
  "next_id",
  "parent_id",
];

/**
 * Formats an embedding as a halfvec literal. Throws on a wrong length or a
 * value that is not a finite number.
 * @param {number[]} vector
 */
export function halfvecLiteral(vector) {
  if (!Array.isArray(vector) || vector.length !== CHUNK_EMBED_DIM) {
    throw new Error(
      `query embedding has ${vector?.length ?? "no"} dimensions; chunks.embedding has ${CHUNK_EMBED_DIM}`,
    );
  }
  for (const v of vector) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("query embedding holds a value that is not a finite number");
    }
  }
  return `[${vector.join(",")}]`;
}

/**
 * Chunk ids at one level, best lexical match first.
 * @param {{ query: Function }} db
 */
export async function lexicalRanking(db, question, level, limit) {
  const { rows } = await db.query(
    `SELECT id FROM chunks
      WHERE level = $2::chunk_level AND tsv @@ plainto_tsquery('english', $1)
      ORDER BY ts_rank(tsv, plainto_tsquery('english', $1)) DESC, id
      LIMIT $3`,
    [question, level, limit],
  );
  return rows.map((r) => String(r.id));
}

/**
 * Chunk ids at one level, nearest embedding first. Only rows embedded by the
 * same model take part.
 * @param {{ query: Function }} db
 */
export async function vectorRanking(db, literal, embedModel, level, limit) {
  const { rows } = await db.query(
    `SELECT id FROM chunks
      WHERE level = $2::chunk_level AND embedding IS NOT NULL AND embedding_model = $3
      ORDER BY embedding <=> $1::halfvec
      LIMIT $4`,
    [literal, level, embedModel, limit],
  );
  return rows.map((r) => String(r.id));
}

/**
 * Embeds the question and runs the four rankings, then fuses them.
 * @param {{ question: string, provider: object, db: { query: Function }, signal?: AbortSignal }} args
 * @returns {Promise<{ fused: { id: string, score: number }[], rankings: Record<string, string[]> }>}
 */
export async function retrieve({ question, provider, db, signal }) {
  if (typeof provider.embedModel !== "string" || !provider.embedModel) {
    throw new Error("provider has no embedModel");
  }
  if (provider.embedDim !== CHUNK_EMBED_DIM) {
    throw new Error(
      `provider ${provider.name} embeds ${provider.embedDim} dimensions; chunks.embedding has ${CHUNK_EMBED_DIM}`,
    );
  }
  const [lexicalPassage, lexicalSection, vectors] = await Promise.all([
    lexicalRanking(db, question, "passage", RANK_LIMITS.passage),
    lexicalRanking(db, question, "section", RANK_LIMITS.section),
    provider.embed([question]),
  ]);
  signal?.throwIfAborted();
  if (!Array.isArray(vectors) || vectors.length !== 1) {
    throw new Error("provider.embed returned no vector for the question");
  }
  const literal = halfvecLiteral(vectors[0]);
  const [vectorPassage, vectorSection] = await Promise.all([
    vectorRanking(db, literal, provider.embedModel, "passage", RANK_LIMITS.passage),
    vectorRanking(db, literal, provider.embedModel, "section", RANK_LIMITS.section),
  ]);
  signal?.throwIfAborted();
  const rankings = { lexicalPassage, lexicalSection, vectorPassage, vectorSection };
  const fused = reciprocalRankFusion(Object.values(rankings));
  return { fused, rankings };
}

/**
 * Loads chunk rows by id. Throws when a row lacks a column the evidence needs.
 * @param {{ query: Function }} db
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>}
 */
export async function loadChunks(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT ${CHUNK_COLUMNS.join(", ")} FROM chunks WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  for (const row of rows) {
    for (const column of CHUNK_COLUMNS) {
      if (!(column in row)) throw new Error(`chunk row has no ${column} column`);
    }
    const id = String(row.id);
    out.set(id, {
      ...row,
      id,
      prev_id: row.prev_id == null ? null : String(row.prev_id),
      next_id: row.next_id == null ? null : String(row.next_id),
      parent_id: row.parent_id == null ? null : String(row.parent_id),
    });
  }
  return out;
}
