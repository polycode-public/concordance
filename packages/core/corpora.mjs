// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The corpus a request names. A corpus id is one path segment of the originals bucket, so it is
// a short lower-case name; the corpora a turn may search are the ones with documents in the store.

const CORPUS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class CorpusError extends Error {
  name = "CorpusError";
}

/** True when a value can name a corpus. */
export const isCorpusId = (value) => typeof value === "string" && CORPUS_ID.test(value);

/**
 * The corpus id of a request, or a CorpusError.
 * @param {unknown} value
 * @returns {string}
 */
export function requireCorpusId(value) {
  if (value === undefined || value === null || value === "") {
    throw new CorpusError("The request needs a corpus.");
  }
  if (!isCorpusId(value)) throw new CorpusError(`${JSON.stringify(value)} is not a corpus id.`);
  return value;
}

/**
 * The corpora that have documents in the store, by id.
 * @param {{ query: Function }} db
 * @returns {Promise<string[]>}
 */
export async function knownCorpora(db) {
  const { rows } = await db.query("SELECT DISTINCT corpus FROM documents ORDER BY corpus");
  return rows.map((r) => r.corpus);
}

/**
 * Checks that a corpus has documents in the store, and returns its id.
 * @param {{ query: Function }} db
 * @param {unknown} value
 */
export async function requireKnownCorpus(db, value) {
  const corpus = requireCorpusId(value);
  const known = await knownCorpora(db);
  if (!known.includes(corpus)) {
    throw new CorpusError(`The corpus ${corpus} has no documents yet.`);
  }
  return corpus;
}
