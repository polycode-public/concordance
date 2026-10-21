// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Hybrid retrieval over the chunks table: lexical (tsvector) and vector (HNSW,
// cosine) rankings at passage and section level, fused by reciprocal rank. Every ranking reads
// one corpus.
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

/** Collects the parameters of one statement and names each one `$n` in the order it is added. */
function sqlParams() {
  const values = [];
  return {
    values,
    /** @param {unknown} value @param {string} [cast] */
    p: (value, cast = "") => {
      values.push(value);
      return `$${values.length}${cast}`;
    },
  };
}

/**
 * @typedef {{ witnesses?: string[], role?: string, from?: string, to?: string }} RetrievalFilters
 *   `witnesses` are witness ids; `role` is a substring of the role the page shows, without case;
 *   `from` and `to` bound the statement date, both ends included, as YYYY-MM-DD.
 * @typedef {{ corpus: string, documentIds?: string[] | null, filters?: RetrievalFilters | null }}
 *   RankingScope
 */

/**
 * The predicates that hold a ranking to its corpus and, when named, to its documents and to the
 * documents that pass the filters. A cipher-only witness shows no role, so a role filter never
 * matches its documents.
 * @param {RankingScope} scope
 */
function scopePredicates({ corpus, documentIds = null, filters = null }, p) {
  requireCorpus(corpus);
  const where = [`corpus = ${p(corpus)}`];
  if (documentIds?.length > 0) where.push(`document_id = ANY(${p(documentIds, "::text[]")})`);
  const kept = [];
  if (filters?.witnesses?.length > 0) {
    kept.push(`d.witness_id = ANY(${p(filters.witnesses, "::text[]")})`);
  }
  if (filters?.role) {
    kept.push(
      `NOT coalesce(w.cipher_only, false)`,
      `strpos(lower(coalesce(d.role, w.role, '')), lower(${p(filters.role)})) > 0`,
    );
  }
  if (filters?.from) kept.push(`d.statement_date >= ${p(filters.from, "::date")}`);
  if (filters?.to) kept.push(`d.statement_date <= ${p(filters.to, "::date")}`);
  if (kept.length) {
    where.push(
      `document_id IN (SELECT d.id FROM documents d LEFT JOIN witnesses w ON w.id = d.witness_id
                        WHERE d.corpus = ${p(corpus)} AND ${kept.join(" AND ")})`,
    );
  }
  return where;
}

/** Chunk ids that match one tsquery, best ts_rank first. */
async function tsqueryRanking(db, tsquery, level, limit, scope) {
  const { values, p } = sqlParams();
  const where = scopePredicates(scope, p);
  const q = tsquery(p);
  const { rows } = await db.query(
    `SELECT id FROM chunks, (SELECT ${q} AS q) AS search
      WHERE ${where.join(" AND ")} AND level = ${p(level, "::chunk_level")} AND tsv @@ search.q
      ORDER BY ts_rank(tsv, search.q) DESC, id
      LIMIT ${p(limit)}`,
    values,
  );
  return rows.map((r) => String(r.id));
}

/**
 * Chunk ids of one corpus at one level, best lexical match first. Any word of the query may
 * match, and ts_rank puts the chunks that match more of them first; each group of witness names
 * must match by one of its names.
 * @param {{ query: Function }} db
 * @param {string} query
 * @param {string} level
 * @param {number} limit
 * @param {RankingScope} scope
 * @param {string[][]} [nameGroups]  the id and aliases of each witness the query names
 */
export function lexicalRanking(db, query, level, limit, scope, nameGroups = []) {
  const plain = (p, text) => `plainto_tsquery('english', ${p(text)})`;
  const anyWord = words(query)
    .filter((w) => w !== "or")
    .join(" or ");
  return tsqueryRanking(
    db,
    (p) =>
      [
        `websearch_to_tsquery('english', ${p(anyWord)})`,
        ...nameGroups.map((names) => `(${names.map((n) => plain(p, n)).join(" || ")})`),
      ].join(" && "),
    level,
    limit,
    scope,
  );
}

/**
 * Chunk ids of one corpus at one level that hold every phrase with its words in order, best
 * match first.
 * @param {{ query: Function }} db
 * @param {string[]} phrases
 * @param {string} level
 * @param {number} limit
 * @param {RankingScope} scope
 */
export function phraseRanking(db, phrases, level, limit, scope) {
  if (!phrases.length) throw new Error("a phrase ranking needs a phrase");
  return tsqueryRanking(
    db,
    (p) => phrases.map((phrase) => `phraseto_tsquery('english', ${p(phrase)})`).join(" && "),
    level,
    limit,
    scope,
  );
}

const QUOTED = /"([^"]+)"|\u201c([^\u201d]+)\u201d/g;

/**
 * The phrases a query puts in straight or curly double quotes, trimmed, without empty ones.
 * @param {string} query
 */
export function quotedPhrases(query) {
  return [...query.matchAll(QUOTED)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);
}

/**
 * The witnesses that have a document in one corpus, each with its id, aliases and role. A
 * cipher-only witness shows no role.
 * @param {{ query: Function }} db
 * @param {string} corpus
 * @returns {Promise<{ id: string, names: string[], role: string | null }[]>}
 */
export async function corpusWitnesses(db, corpus) {
  requireCorpus(corpus);
  const { rows } = await db.query(
    `SELECT w.id, w.aliases, w.role, w.cipher_only FROM witnesses w
      WHERE EXISTS (SELECT 1 FROM documents d WHERE d.witness_id = w.id AND d.corpus = $1)
      ORDER BY w.id`,
    [corpus],
  );
  return rows.map((r) => ({
    id: String(r.id),
    names: [String(r.id), ...(r.aliases ?? [])],
    role: r.cipher_only || r.role == null ? null : String(r.role),
  }));
}

const words = (text) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** The surname and, for a name of three or more words, the first and last words of a name. */
const nameParts = (nameWords) =>
  nameWords.length < 2
    ? []
    : [
        nameWords.slice(-1),
        ...(nameWords.length > 2 ? [[nameWords[0], nameWords[nameWords.length - 1]]] : []),
      ];

/** The flat numbers that a text names as "flat <number>". */
const flatNumbers = (textWords) =>
  textWords.flatMap((w, i) =>
    w === "flat" && /^\d+$/.test(textWords[i + 1] ?? "") ? [textWords[i + 1]] : [],
  );

/**
 * Finds the witnesses a query names by id, by any alias, by the surname of an alias or by the
 * first and last words of an alias, compared word by word without case. The longest name is
 * matched first, a full name before a part of a name of the same length, and each word of the
 * query is part of at most one name; a name that several witnesses share names them all. When
 * the query names "flat <number>", the witnesses whose role names that flat are named too, as
 * one group; the flat words stay in the query.
 * @param {string} query
 * @param {{ id: string, names: string[], role?: string | null }[]} witnesses
 * @returns {{ rest: string, nameGroups: string[][], witnessIds: string[] }}
 *   `rest` is the query without the matched names; each group holds every name of one witness
 *   that a name matches, or of every witness of one flat; `witnessIds` holds the id of each
 *   named witness once.
 */
export function namedWitnesses(query, witnesses) {
  const queryWords = words(query);
  const used = new Array(queryWords.length).fill(false);
  const full = new Map();
  const parts = new Map();
  const add = (byName, nameWords, w) => {
    const k = nameWords.join(" ");
    if (!byName.has(k)) byName.set(k, { nameWords, holders: [] });
    if (!byName.get(k).holders.includes(w)) byName.get(k).holders.push(w);
  };
  for (const w of witnesses) {
    for (const name of w.names) {
      const nameWords = words(name);
      if (!nameWords.length) continue;
      add(full, nameWords, w);
      for (const part of nameParts(nameWords)) add(parts, part, w);
    }
  }
  for (const k of full.keys()) parts.delete(k);
  const byLength = (a, b) => b.nameWords.length - a.nameWords.length;
  const names = [...full.values(), ...parts.values()].sort(byLength);
  const matched = new Map();
  for (const { nameWords, holders } of names) {
    for (let i = 0; i + nameWords.length <= queryWords.length; i++) {
      const span = nameWords.every((w, j) => !used[i + j] && queryWords[i + j] === w);
      if (!span) continue;
      for (let j = 0; j < nameWords.length; j++) used[i + j] = true;
      for (const w of holders) matched.set(w.id, w.names);
    }
  }
  const nameGroups = [...matched.values()];
  const witnessIds = [...matched.keys()];
  for (const flat of new Set(flatNumbers(queryWords))) {
    const residents = witnesses.filter((w) => w.role && flatNumbers(words(w.role)).includes(flat));
    if (!residents.length) continue;
    nameGroups.push(residents.flatMap((w) => w.names));
    for (const w of residents) if (!witnessIds.includes(w.id)) witnessIds.push(w.id);
  }
  return {
    rest: queryWords.filter((_, i) => !used[i]).join(" "),
    nameGroups,
    witnessIds,
  };
}

/**
 * Chunk ids of one corpus at one level, nearest embedding first. Only rows embedded by the
 * same model take part.
 * @param {{ query: Function }} db
 * @param {string} literal
 * @param {string} embedModel
 * @param {string} level
 * @param {number} limit
 * @param {RankingScope} scope
 */
export async function vectorRanking(db, literal, embedModel, level, limit, scope) {
  const { values, p } = sqlParams();
  const where = scopePredicates(scope, p);
  const distance = `embedding <=> ${p(literal, "::halfvec")}`;
  // The HNSW index filters after its candidate list, so a few documents' rows would mostly
  // fall outside it; "+ 0" keeps the planner off the index and the scan exact.
  const order = where.length > 1 ? `(${distance}) + 0` : distance;
  const { rows } = await db.query(
    `SELECT id FROM chunks
      WHERE ${where.join(" AND ")} AND level = ${p(level, "::chunk_level")}
        AND embedding IS NOT NULL AND embedding_model = ${p(embedModel)}
      ORDER BY ${order}
      LIMIT ${p(limit)}`,
    values,
  );
  return rows.map((r) => String(r.id));
}

const requireCorpus = (corpus) => {
  if (typeof corpus !== "string" || !corpus) throw new Error("retrieval needs a corpus");
};

/**
 * The lexical rankings of one query at both levels: the words with the witness names expanded,
 * and, when the query quotes a phrase, the exact phrases beside them.
 */
async function lexicalRankings(db, query, { rest, nameGroups }, scope) {
  const text = nameGroups.length ? rest : query;
  const phrases = quotedPhrases(query);
  const [lexicalPassage, lexicalSection, phrasePassage, phraseSection] = await Promise.all([
    lexicalRanking(db, text, "passage", RANK_LIMITS.passage, scope, nameGroups),
    lexicalRanking(db, text, "section", RANK_LIMITS.section, scope, nameGroups),
    ...(phrases.length
      ? [
          phraseRanking(db, phrases, "passage", RANK_LIMITS.passage, scope),
          phraseRanking(db, phrases, "section", RANK_LIMITS.section, scope),
        ]
      : []),
  ]);
  return {
    lexicalPassage,
    lexicalSection,
    ...(phrases.length ? { phrasePassage, phraseSection } : {}),
  };
}

/**
 * The scope of the added vector rankings when the queries name witnesses: the documents of
 * those witnesses, inside the witnesses that the filters keep. Null when the two share no
 * witness, so that the added vector rankings are empty.
 * @param {RankingScope} scope
 * @param {string[]} witnessIds
 * @returns {RankingScope | null}
 */
export function namedWitnessScope(scope, witnessIds) {
  if (!witnessIds.length) return scope;
  const kept = scope.filters?.witnesses;
  const witnesses = kept?.length ? witnessIds.filter((id) => kept.includes(id)) : witnessIds;
  return witnesses.length ? { ...scope, filters: { ...scope.filters, witnesses } } : null;
}

/**
 * Embeds each query and runs the rankings of each over one corpus, then fuses every ranking of
 * every query by reciprocal rank. A non-empty `documentIds` limits every ranking to those
 * documents, and `filters` to the documents that pass them. When any query names a witness,
 * each query adds vector rankings that read only the documents of the named witnesses beside
 * its vector rankings over the corpus, so that their passages rank first and no document is
 * kept out.
 * @param {{ queries: string[], corpus: string, provider: object, db: { query: Function },
 *   signal?: AbortSignal, documentIds?: string[] | null, filters?: RetrievalFilters | null }} args
 * @returns {Promise<{ fused: { id: string, score: number }[], rankings: Record<string, string[]>[] }>}
 *   `rankings` holds the rankings of each query, in query order.
 */
export async function retrieve({
  queries,
  corpus,
  provider,
  db,
  signal,
  documentIds = null,
  filters = null,
}) {
  requireCorpus(corpus);
  if (!Array.isArray(queries) || !queries.length || !queries.every((q) => typeof q === "string")) {
    throw new Error("retrieval needs one or more query strings");
  }
  if (typeof provider.embedModel !== "string" || !provider.embedModel) {
    throw new Error("provider has no embedModel");
  }
  if (provider.embedDim !== CHUNK_EMBED_DIM) {
    throw new Error(
      `provider ${provider.name} embeds ${provider.embedDim} dimensions; chunks.embedding has ${CHUNK_EMBED_DIM}`,
    );
  }
  const scope = { corpus, documentIds, filters };
  const [{ lexical, namedScope }, vectors] = await Promise.all([
    corpusWitnesses(db, corpus).then(async (witnesses) => {
      const named = queries.map((query) => namedWitnesses(query, witnesses));
      const witnessIds = [...new Set(named.flatMap((n) => n.witnessIds))];
      return {
        lexical: await Promise.all(
          queries.map((query, i) => lexicalRankings(db, query, named[i], scope)),
        ),
        namedScope: witnessIds.length ? namedWitnessScope(scope, witnessIds) : undefined,
      };
    }),
    provider.embed(queries),
  ]);
  signal?.throwIfAborted();
  if (!Array.isArray(vectors) || vectors.length !== queries.length) {
    throw new Error(
      `provider.embed returned ${vectors?.length ?? "no"} vectors for ${queries.length} queries`,
    );
  }
  const rankings = await Promise.all(
    queries.map(async (_, i) => {
      const literal = halfvecLiteral(vectors[i]);
      const vector = (level, vectorScope) =>
        vectorScope
          ? vectorRanking(db, literal, provider.embedModel, level, RANK_LIMITS[level], vectorScope)
          : [];
      if (namedScope === undefined) {
        const [vectorPassage, vectorSection] = await Promise.all([
          vector("passage", scope),
          vector("section", scope),
        ]);
        return { ...lexical[i], vectorPassage, vectorSection };
      }
      const [vectorPassage, vectorSection, namedPassage, namedSection] = await Promise.all([
        vector("passage", scope),
        vector("section", scope),
        vector("passage", namedScope),
        vector("section", namedScope),
      ]);
      return { ...lexical[i], vectorPassage, vectorSection, namedPassage, namedSection };
    }),
  );
  signal?.throwIfAborted();
  const fused = reciprocalRankFusion(rankings.flatMap((r) => Object.values(r)));
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
