// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Ingest: statement pages into the documents, witnesses, chunks and provenance tables.
//
// Locator mapping, scheme 'page-paragraph':
// - A paragraph is a numbered block of the statement. A line that starts "N. ", where N is the
//   next number in sequence, opens it; the paragraph runs to the line that opens the next one.
// - A paragraph is located by the page on which its number line appears. A paragraph that runs
//   onto later pages keeps that start page, because that is where the reader finds the number.
// - A page with no numbered line holds the continuation of the paragraph open at its top, so its
//   text belongs to that paragraph and cites that paragraph's start page.
// - Text before the first numbered paragraph (a cover sheet, a title) is a section with
//   paragraph null, located on the page where it starts.
// - Passages and sentences inherit page and paragraph from their section. The document chunk
//   carries page 1 and paragraph null.
// - A document with no numbered paragraph is located by page alone: one section per page or
//   per cut of a long page, each with paragraph null.
//
// A document whose pages carry no text layer (a scan) is refused. OCR is a horizon; candidates are
// Amazon Textract and a page-image pass through a vision model.
//
// Library: ingestDocument() takes extracted pages, so a test needs no PDF.
// CLI: node packages/core/ingest/run.mjs --corpus grenfell
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildHeader } from "../chunking/header.mjs";
import { slidingPassages } from "../chunking/passages.mjs";
import { splitNumberedParagraphs } from "../chunking/sections.mjs";
import { splitSentences } from "../chunking/sentences.mjs";
import { InvalidReplyError } from "../providers/jsonReply.mjs";
import { sha256File } from "./hash.mjs";
import { pdfToPages } from "./pdfText.mjs";

export const PIPELINE_VERSION = "ingest-v2";
export const CONTEXT_PROMPT_VERSION = "context-v1";
export const ABSTRACT_PROMPT_VERSION = "abstract-v1";
export const EMBED_BATCH_SIZE = 32;
export const ABSTRACT_INPUT_CHARS = 12000;
export const ABSTRACT_TAIL_CHARS = 2000;
export const CONTEXT_CHECKPOINT_SECTIONS = 25;
export const MIN_TEXT_PAGE_FRACTION = 0.25;
export const LEVEL_BATCH_BYTES = 60 * 1024;
export const LEVELS = Object.freeze(["document", "section", "passage", "sentence"]);

const INGEST_TOOL = "concordance-ingest";
const LOCATOR_SCHEME = "page-paragraph";

const CORPORA = Object.freeze({
  grenfell: Object.freeze({ label: "Grenfell Inquiry", eventDate: "2017-06-14" }),
  ucpi: Object.freeze({ label: "Undercover Policing Inquiry", eventDate: null }),
});

const CONTEXT_SCHEMA = Object.freeze({
  type: "object",
  properties: { context: { type: "string" } },
  required: ["context"],
});

const ABSTRACT_SCHEMA = Object.freeze({
  type: "object",
  properties: { abstract: { type: "string" } },
  required: ["abstract"],
});

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..", "..");
const execFileAsync = promisify(execFile);

/** @param {string} corpus */
export function corpusInfo(corpus) {
  const info = CORPORA[corpus];
  if (!info) throw new Error(`unknown corpus ${corpus}; known: ${Object.keys(CORPORA).join(", ")}`);
  return info;
}

/** @param {string} text */
export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Formats a vector as a pgvector halfvec literal with five significant digits a value. Throws
 * on a wrong length or a value that is not a finite number.
 * @param {number[]} vector
 * @param {number} dim
 */
export function toHalfvecLiteral(vector, dim) {
  if (!Array.isArray(vector) || vector.length !== dim) {
    throw new Error(`embedding has length ${vector?.length}; expected ${dim}`);
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`embedding holds a value that is not a finite number: ${value}`);
    }
  }
  // halfvec stores fp16 (about 3.3 significant digits), so five digits keep every stored value
  // and cut the literal, and the Data API request that carries it, to about 40 per cent.
  return `[${vector.map((value) => String(Number(value.toPrecision(5)))).join(",")}]`;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function batches(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("batch size must be >= 1");
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The bytes a value adds to a Data API request as one element of a Postgres array literal
 * inside the request JSON.
 * @param {string | null | undefined} value
 */
function arrayElementBytes(value) {
  if (value == null) return 5;
  return Buffer.byteLength(JSON.stringify(`"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`)) + 1;
}

/**
 * The serialised bytes of one chunk row in an INSERT_LEVEL statement: its text, header,
 * context line, locator and halfvec literal as array elements, and room for its ordinal and
 * parent id.
 * @param {{ text: string, header?: string | null, context?: string | null, locator: object,
 *   embedding: string }} row
 */
export function levelRowBytes(row) {
  return (
    arrayElementBytes(row.text) +
    arrayElementBytes(row.header) +
    arrayElementBytes(row.context) +
    arrayElementBytes(JSON.stringify(row.locator)) +
    arrayElementBytes(row.embedding) +
    32
  );
}

/**
 * Splits one level's rows into INSERT_LEVEL batches whose serialised rows stay within
 * maxBytes, because the RDS Data API refuses a request over 64 KB. A row larger than
 * maxBytes goes in a batch of its own. Order is kept.
 * @template {Parameters<typeof levelRowBytes>[0]} T
 * @param {T[]} rows
 * @param {number} [maxBytes]
 * @returns {T[][]}
 */
export function levelBatches(rows, maxBytes = LEVEL_BATCH_BYTES) {
  const out = [];
  let current = [];
  let size = 0;
  for (const row of rows) {
    const bytes = levelRowBytes(row);
    if (current.length && size + bytes > maxBytes) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Splits vectors into INSERT batches whose serialised literals stay within maxBytes, because the
 * RDS Data API refuses a request over 64 KB. A vector larger than maxBytes goes in a batch of its
 * own. Order is kept.
 * @param {{ idx: number, literal: string }[]} items
 * @param {number} [maxBytes]
 */
export function vectorBatches(items, maxBytes = LEVEL_BATCH_BYTES) {
  const out = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const bytes = arrayElementBytes(item.literal) + 16;
    if (current.length && size + bytes > maxBytes) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses manifest.jsonl: one JSON object a line with url, sha256, bytes, fetched_at, licence
 * and evidence_id. Blank lines are allowed; any other bad line throws with its line number.
 * @param {string} text
 * @param {string} [source]
 */
export function parseManifest(text, source = "manifest.jsonl") {
  const rows = [];
  const seen = new Set();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${source}:${i + 1}`;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`${where}: invalid JSON`, { cause: err });
    }
    const fail = (field) => {
      throw new Error(`${where}: ${field} is missing or invalid`);
    };
    if (typeof row?.url !== "string" || !row.url) fail("url");
    if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) fail("sha256");
    if (!Number.isInteger(row.bytes) || row.bytes < 0) fail("bytes");
    if (typeof row.fetched_at !== "string" || Number.isNaN(Date.parse(row.fetched_at))) {
      fail("fetched_at");
    }
    if (typeof row.licence !== "string" || !row.licence) fail("licence");
    if (typeof row.evidence_id !== "string" || !row.evidence_id) fail("evidence_id");
    if (seen.has(row.evidence_id)) throw new Error(`${where}: duplicate ${row.evidence_id}`);
    seen.add(row.evidence_id);
    rows.push(row);
  });
  return rows;
}

/** @param {string} file */
export async function readManifest(file) {
  return parseManifest(await readFile(file, "utf8"), file);
}

/**
 * Parses sources.json: an array of { evidence_id, url, role, floor, statement_date, file },
 * optionally with witness_id, witness (the name) and cipher_only. Returns a Map keyed by evidence id.
 * @param {string} text
 * @param {string} [source]
 */
export function parseSources(text, source = "sources.json") {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: invalid JSON`, { cause: err });
  }
  if (!Array.isArray(entries)) throw new Error(`${source}: expected an array`);
  const out = new Map();
  entries.forEach((entry, i) => {
    const where = `${source}[${i}]`;
    const optionalString = (field) => {
      if (entry[field] != null && typeof entry[field] !== "string") {
        throw new Error(`${where}: ${field} must be a string`);
      }
    };
    if (typeof entry?.evidence_id !== "string" || !entry.evidence_id) {
      throw new Error(`${where}: evidence_id is missing`);
    }
    for (const field of ["url", "role", "file", "witness_id", "witness"]) optionalString(field);
    if (entry.floor != null && !["string", "number"].includes(typeof entry.floor)) {
      throw new Error(`${where}: floor must be a string or a number`);
    }
    if (entry.cipher_only != null && typeof entry.cipher_only !== "boolean") {
      throw new Error(`${where}: cipher_only must be a boolean`);
    }
    if (entry.statement_date != null && !ISO_DATE.test(entry.statement_date)) {
      throw new Error(`${where}: statement_date must be YYYY-MM-DD`);
    }
    if (out.has(entry.evidence_id)) throw new Error(`${where}: duplicate ${entry.evidence_id}`);
    out.set(entry.evidence_id, entry);
  });
  return out;
}

/**
 * Reads sources.json. A missing file gives an empty Map; any other read error throws.
 * @param {string} file
 */
export async function readSources(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }
  return parseSources(text, file);
}

/** "resident" and floor 18 become "resident, floor 18". */
export function roleText({ role, floor } = {}) {
  const parts = [role, floor != null && floor !== "" && `floor ${floor}`].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Builds ingestDocument() meta from a manifest row and its sources entry. The witness id is
 * the sources witness_id, else the evidence id, until the witness register maps them. The
 * witness name becomes the witness's alias, except for a cipher-only witness, whose aliases
 * hold ciphers only.
 * @param {string} corpus
 * @param {object} row  a manifest row
 * @param {object} [source]  the sources.json entry for the row
 */
export function documentMeta(corpus, row, source) {
  return {
    evidenceId: row.evidence_id,
    corpus,
    sourceUrl: row.url,
    fetchedAt: row.fetched_at,
    sha256: row.sha256,
    licence: row.licence,
    witnessId: source?.witness_id ?? row.evidence_id,
    role: roleText(source),
    cipherOnly: source?.cipher_only ?? false,
    witnessName: source?.cipher_only ? null : source?.witness?.trim() || null,
    statementDate: source?.statement_date ?? null,
  };
}

/**
 * Merges one witness row into the witnesses table. A cipher-only witness loses every alias;
 * any other witness keeps its aliases and gains the new ones.
 */
export const WITNESS_UPSERT_SQL = `INSERT INTO witnesses (id, role, cipher_only, aliases) VALUES ($1, $2, $3, $4::text[])
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, cipher_only = EXCLUDED.cipher_only,
           aliases = CASE WHEN EXCLUDED.cipher_only THEN '{}'::text[]
                          ELSE ARRAY(SELECT DISTINCT a FROM unnest(witnesses.aliases || EXCLUDED.aliases) a
                                      ORDER BY a) END`;

/**
 * The witnesses row that documentMeta() gives: the witness name is the only alias, and a
 * cipher-only witness has none.
 * @param {{ witnessId: string, role: string | null, cipherOnly?: boolean, witnessName: string | null }} meta
 */
export function witnessRow(meta) {
  const cipherOnly = meta.cipherOnly ?? false;
  return {
    id: meta.witnessId,
    role: meta.role,
    cipherOnly,
    aliases: cipherOnly || !meta.witnessName ? [] : [meta.witnessName],
  };
}

/** @param {{ id: string, role: string | null, cipherOnly: boolean, aliases: string[] }} row */
export function witnessUpsertParams(row) {
  return [row.id, row.role, row.cipherOnly, row.aliases];
}

/**
 * Splits pages into sections (numbered paragraphs, or pages when none is numbered), passages and sentences with their
 * locators. Passage and sentence ordinals run across the whole document.
 * @param {{ page: number, text: string }[]} pages
 */
export function planChunks(pages) {
  const sections = splitNumberedParagraphs(pages);
  let passageOrdinal = 0;
  let sentenceOrdinal = 0;
  return sections.map((section, ordinal) => {
    const locator = { page: section.page, paragraph: section.paragraph };
    const sentences = splitSentences(section.text);
    return {
      ordinal,
      text: section.text,
      heading: section.heading,
      locator,
      passages: slidingPassages(sentences).map((p) => ({
        ordinal: passageOrdinal++,
        text: p.text,
        locator,
      })),
      sentences: sentences.map((text) => ({ ordinal: sentenceOrdinal++, text, locator })),
    };
  });
}

export function contextPrompt({ header, previous, text }) {
  return [
    "You write one sentence of context for a paragraph of a witness statement, so that a search can find the paragraph.",
    "Say who is speaking and what the paragraph is about: places, times and people it names.",
    "Use only facts in the paragraph, the previous paragraph and the header. Do not judge or interpret the witness.",
    'Reply as JSON: {"context": "<one sentence>"}.',
    "",
    `Header: ${header}`,
    `Previous paragraph: ${previous ?? "(none)"}`,
    `Paragraph: ${text}`,
  ].join("\n");
}

export function abstractPrompt({ header, text }) {
  return [
    "You write an abstract of about 200 words of a witness statement, so that a search can find the statement.",
    'Report what the witness states, as "The witness states ...". Name places, times and people the statement names.',
    "Use only facts in the statement text. Do not judge or interpret the witness.",
    'Reply as JSON: {"abstract": "<the abstract>"}.',
    "",
    `Header: ${header}`,
    `Statement text: ${text}`,
  ].join("\n");
}

/**
 * The text the abstract prompt sees: the start of the statement and, when the statement is
 * longer than that, the last page, where a signature and a date sit.
 * @param {string} text  the sections joined
 * @param {string} lastPage
 */
export function abstractInput(text, lastPage) {
  const head = text.slice(0, ABSTRACT_INPUT_CHARS);
  if (text.length <= ABSTRACT_INPUT_CHARS) return head;
  return `${head}\n[...]\n${lastPage.trim().slice(-ABSTRACT_TAIL_CHARS)}`;
}

async function extractString(provider, { prompt, schema }, field) {
  const result = await provider.extractJson({ prompt, schema });
  const value = result?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`extraction model returned no ${field}: ${JSON.stringify(result)}`);
  }
  return value.trim();
}

/**
 * Returns true when the document is stored with this sha256 and pipeline version.
 * @param {{ query: Function }} db
 */
export async function isIngested(db, { evidenceId, sha256, pipelineVersion = PIPELINE_VERSION }) {
  const { rows } = await db.query(
    "SELECT 1 FROM documents WHERE id = $1 AND sha256 = $2 AND pipeline_version = $3",
    [evidenceId, sha256, pipelineVersion],
  );
  return rows.length > 0;
}

const INSERT_LEVEL = `
  INSERT INTO chunks (document_id, level, ordinal, text, header, context_line, locator, parent_id,
                      embedding, embedding_model, embedding_dim, pipeline_version)
  SELECT $1, $2::chunk_level, u.ordinal, u.text, u.header, u.context_line, u.locator, u.parent_id,
         COALESCE(u.embedding::halfvec,
                  (SELECT v.embedding FROM ingest_vectors v
                    WHERE v.document_id = $1 AND v.idx = u.vector_index)),
         $3, $4, $5
    FROM unnest($6::int[], $7::text[], $8::text[], $9::text[], $10::jsonb[], $11::bigint[], $12::text[],
                $13::int[])
      AS u(ordinal, text, header, context_line, locator, parent_id, embedding, vector_index)
  RETURNING id, ordinal`;

const SELECT_PROGRESS = `
  SELECT source_sha256, pipeline_version, model, prompt_version, section_count, contexts
    FROM ingest_progress WHERE document_id = $1`;

const START_PROGRESS = `
  INSERT INTO ingest_progress (document_id, source_sha256, pipeline_version, model,
                               prompt_version, section_count, contexts)
  VALUES ($1, $2, $3, $4, $5, $6, '[]')
  ON CONFLICT (document_id) DO UPDATE SET
    source_sha256 = EXCLUDED.source_sha256, pipeline_version = EXCLUDED.pipeline_version,
    model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version,
    section_count = EXCLUDED.section_count, contexts = '[]', updated_at = now()`;

const APPEND_PROGRESS = `
  UPDATE ingest_progress SET contexts = contexts || $2::jsonb, updated_at = now()
   WHERE document_id = $1 AND jsonb_array_length(contexts) = $3::int`;

const COUNT_VECTORS = "SELECT count(*)::int AS n FROM ingest_vectors WHERE document_id = $1";

const CLEAR_VECTORS = "DELETE FROM ingest_vectors WHERE document_id = $1";

const APPEND_VECTORS = `
  INSERT INTO ingest_vectors (document_id, idx, embedding)
  SELECT $1, u.idx, u.embedding::halfvec
    FROM unnest($2::int[], $3::text[]) AS u(idx, embedding)
  ON CONFLICT (document_id, idx) DO NOTHING`;

const LINK_NEIGHBOURS = `
  UPDATE chunks c SET prev_id = n.prev_id, next_id = n.next_id
    FROM (SELECT id,
                 lag(id) OVER (PARTITION BY level ORDER BY ordinal) AS prev_id,
                 lead(id) OVER (PARTITION BY level ORDER BY ordinal) AS next_id
            FROM chunks WHERE document_id = $1) n
   WHERE c.id = n.id`;

/**
 * Ingests one document's pages. Model calls run before the transaction; every row is written
 * in one transaction, so a failure leaves nothing behind. A stored document with the same
 * sha256 and pipeline version is skipped; one with another sha256 or version is replaced.
 * The context lines are stored in batches as they are made, then the vectors of the section,
 * passage and sentence rows are stored in ingest_vectors after each embed call. When the abort
 * signal fires the run keeps what it stored and returns status "partial"; the next run resumes
 * after the last stored line and the last stored vector. The chunk rows are written in one
 * transaction at the end, so a document is invisible to retrieval until it is complete. A context
 * call that answers prose twice stores an empty line and counts in contextsSkipped.
 * @param {object} args
 * @param {{ page: number, text: string }[]} args.pages
 * @param {ReturnType<typeof documentMeta>} args.meta
 * @param {import('../providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {{ pool: { connect: Function }, query: Function }} args.db
 * @param {string} [args.pipelineVersion]
 * @param {string} [args.extractModel]  the model id recorded in provenance
 * @param {{ tool: string, version: string | null }} [args.textTool]  the text extractor
 * @param {AbortSignal} [args.signal]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ status: 'skipped' | 'ingested' | 'replaced' | 'partial',
 *   counts: Record<string, number>, contexts?: { done: number, total: number },
 *   embeddings?: { done: number, total: number }, contextsSkipped?: number }>}
 */
export async function ingestDocument({
  pages,
  meta,
  provider,
  db,
  pipelineVersion = PIPELINE_VERSION,
  extractModel = provider.extractModel,
  textTool = { tool: "pdftotext", version: null },
  signal,
  log = console.log,
}) {
  const id = meta.evidenceId;
  if (!id) throw new Error("meta.evidenceId is required");
  if (!SHA256.test(meta.sha256 ?? "")) throw new Error(`${id}: meta.sha256 is not a SHA-256`);
  if (!extractModel) throw new Error(`${id}: the extraction model id is unknown`);
  if (!Number.isInteger(provider.embedDim) || !provider.embedModel) {
    throw new Error(`${id}: provider ${provider.name} has no embedModel or embedDim`);
  }

  const zero = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  if (await isIngested(db, { evidenceId: id, sha256: meta.sha256, pipelineVersion })) {
    log(`skip    ${id}`);
    return { status: "skipped", counts: zero };
  }

  const emptyPages = pages.filter((p) => !p.text?.trim()).length;
  if (!pages.length || pages.length - emptyPages < pages.length * MIN_TEXT_PAGE_FRACTION) {
    throw new Error(
      `${id}: no text layer; ${emptyPages} of ${pages.length} pages have no text (scanned pages need OCR)`,
    );
  }

  const info = corpusInfo(meta.corpus);
  const headerFor = (locator, heading) =>
    buildHeader({
      corpus: info.label,
      witnessId: meta.witnessId,
      role: meta.role ?? undefined,
      statementDate: meta.statementDate ?? undefined,
      eventDate: info.eventDate,
      heading,
      locator,
    });

  const started = Date.now();
  const stage = (name, count) =>
    log(JSON.stringify({ evidenceId: id, stage: name, count, ms: Date.now() - started }));
  stage("text-extracted", pages.length);
  const sections = planChunks(pages);
  const extractedText = pages.map((p) => p.text).join("\f");
  stage("sections-split", sections.length);

  for (const section of sections) section.header = headerFor(section.locator, section.heading);

  const progressKey = [
    meta.sha256,
    pipelineVersion,
    extractModel,
    CONTEXT_PROMPT_VERSION,
    sections.length,
  ];
  const { rows: progressRows } = await db.query(SELECT_PROGRESS, [id]);
  const saved = progressRows[0];
  const savedContexts =
    saved && typeof saved.contexts === "string" ? JSON.parse(saved.contexts) : saved?.contexts;
  const resumes =
    saved &&
    saved.source_sha256 === progressKey[0] &&
    saved.pipeline_version === progressKey[1] &&
    saved.model === progressKey[2] &&
    saved.prompt_version === progressKey[3] &&
    saved.section_count === progressKey[4] &&
    Array.isArray(savedContexts);
  const contexts = resumes ? [...savedContexts] : [];
  if (!resumes) {
    await db.query(START_PROGRESS, [id, ...progressKey]);
    await db.query(CLEAR_VECTORS, [id]);
  }
  let contextsSkipped = 0;
  const contextFor = async (i) => {
    const args = {
      prompt: contextPrompt({
        header: sections[i].header,
        previous: sections[i - 1]?.text,
        text: sections[i].text,
      }),
      schema: CONTEXT_SCHEMA,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await extractString(provider, args, "context");
      } catch (err) {
        if (!(err instanceof InvalidReplyError)) throw err;
      }
    }
    contextsSkipped++;
    log(JSON.stringify({ evidenceId: id, stage: "context-line-skipped", section: i }));
    return "";
  };
  let stored = contexts.length;
  const checkpoint = async () => {
    if (contexts.length === stored) return;
    await db.query(APPEND_PROGRESS, [id, JSON.stringify(contexts.slice(stored)), stored]);
    stored = contexts.length;
  };
  for (let i = contexts.length; i < sections.length; i++) {
    if (signal?.aborted) {
      await checkpoint();
      log(JSON.stringify({ evidenceId: id, stage: "context-lines-partial", count: i }));
      return {
        status: "partial",
        counts: zero,
        contexts: { done: i, total: sections.length },
      };
    }
    contexts.push(await contextFor(i));
    if (contexts.length - stored >= CONTEXT_CHECKPOINT_SECTIONS) await checkpoint();
  }
  await checkpoint();
  sections.forEach((section, i) => {
    section.context = contexts[i] || null;
  });
  stage("context-lines-done", sections.length);
  const embedInput = (r) => `${r.header}\n${r.context ? `${r.context}\n` : ""}${r.text}`;
  const embedBatch = async (batch) => {
    const vectors = await provider.embed(batch.map(embedInput));
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error(`${id}: embed returned ${vectors?.length} vectors for ${batch.length} texts`);
    }
    return vectors.map((vector) => toHalfvecLiteral(vector, provider.embedDim));
  };

  const body = {
    section: sections.map((s) => ({ ...s, parent: 0 })),
    passage: sections.flatMap((s) =>
      s.passages.map((p) => ({ ...p, header: s.header, context: s.context, parent: s.ordinal })),
    ),
    sentence: sections.flatMap((s) =>
      s.sentences.map((p) => ({ ...p, header: s.header, context: s.context, parent: s.ordinal })),
    ),
  };
  const bodyRows = ["section", "passage", "sentence"].flatMap((level) => body[level]);
  bodyRows.forEach((r, i) => {
    r.vectorIndex = i;
  });
  const { rows: countRows } = await db.query(COUNT_VECTORS, [id]);
  let embedded = Math.min(Number(countRows[0]?.n ?? 0), bodyRows.length);
  while (embedded < bodyRows.length) {
    if (signal?.aborted) {
      log(JSON.stringify({ evidenceId: id, stage: "embeddings-partial", count: embedded }));
      return {
        status: "partial",
        counts: zero,
        contexts: { done: sections.length, total: sections.length },
        embeddings: { done: embedded, total: bodyRows.length },
        contextsSkipped,
      };
    }
    const batch = bodyRows.slice(embedded, embedded + EMBED_BATCH_SIZE);
    const literals = await embedBatch(batch);
    const items = batch.map((r, i) => ({ idx: r.vectorIndex, literal: literals[i] }));
    for (const part of vectorBatches(items)) {
      await db.query(APPEND_VECTORS, [id, part.map((x) => x.idx), part.map((x) => x.literal)]);
    }
    embedded += batch.length;
  }
  stage("embeddings-done", bodyRows.length);

  const documentHeader = headerFor(undefined);
  const abstract = await extractString(
    provider,
    {
      prompt: abstractPrompt({
        header: documentHeader,
        text: abstractInput(sections.map((s) => s.text).join("\n"), pages.at(-1).text),
      }),
      schema: ABSTRACT_SCHEMA,
    },
    "abstract",
  );
  stage("abstract-done", 1);
  const documentRow = {
    ordinal: 0,
    text: abstract,
    header: documentHeader,
    context: null,
    locator: { page: pages[0]?.page ?? 1, paragraph: null },
  };
  [documentRow.embedding] = await embedBatch([documentRow]);
  const rows = { document: [documentRow], ...body };
  const all = LEVELS.flatMap((level) => rows[level]);

  const client = await db.pool.connect();
  let status = "ingested";
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM documents WHERE id = $1 FOR UPDATE", [id]);
    if (existing.rows.length) {
      await client.query("DELETE FROM documents WHERE id = $1", [id]);
      status = "replaced";
    }
    if (meta.witnessId) {
      await client.query(WITNESS_UPSERT_SQL, witnessUpsertParams(witnessRow(meta)));
    }
    await client.query(
      `INSERT INTO documents (id, corpus, source_url, fetched_at, sha256, licence, format,
                              witness_id, role, statement_date, event_date, page_count,
                              locator_scheme, abstract, pipeline_version)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, 'pdf', $7, $8, $9::date, $10::date, $11,
               $12, $13, $14)`,
      [
        id,
        meta.corpus,
        meta.sourceUrl,
        meta.fetchedAt,
        meta.sha256,
        meta.licence,
        meta.witnessId,
        meta.role,
        meta.statementDate,
        info.eventDate,
        pages.length,
        LOCATOR_SCHEME,
        abstract,
        pipelineVersion,
      ],
    );

    const idsByLevel = {};
    for (const level of LEVELS) {
      const parents =
        level === "document"
          ? null
          : level === "section"
            ? idsByLevel.document
            : idsByLevel.section;
      idsByLevel[level] = new Map();
      for (const levelRows of levelBatches(rows[level])) {
        const { rows: inserted } = await client.query(INSERT_LEVEL, [
          id,
          level,
          provider.embedModel,
          provider.embedDim,
          pipelineVersion,
          levelRows.map((r) => r.ordinal),
          levelRows.map((r) => r.text),
          levelRows.map((r) => r.header),
          levelRows.map((r) => r.context),
          levelRows.map((r) => JSON.stringify(r.locator)),
          levelRows.map((r) => (parents ? parents.get(r.parent) : null)),
          levelRows.map((r) => r.embedding ?? null),
          levelRows.map((r) => r.vectorIndex ?? null),
        ]);
        for (const r of inserted) idsByLevel[level].set(r.ordinal, r.id);
      }
    }
    await client.query(LINK_NEIGHBOURS, [id]);

    const provenance = [
      [sha256Text(extractedText), "extract-text", textTool.tool, textTool.version, null, null],
      [
        sha256Text(abstract),
        "abstract",
        INGEST_TOOL,
        pipelineVersion,
        extractModel,
        ABSTRACT_PROMPT_VERSION,
      ],
      ...sections
        .filter((s) => s.context)
        .map((s) => [
          sha256Text(s.context),
          "context-line",
          INGEST_TOOL,
          pipelineVersion,
          extractModel,
          CONTEXT_PROMPT_VERSION,
        ]),
    ];
    await client.query(
      `INSERT INTO provenance (derived_sha256, source_sha256, step, tool, tool_version, model, prompt_version)
       SELECT u.derived, $1, u.step, u.tool, u.tool_version, u.model, u.prompt_version
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
           AS u(derived, step, tool, tool_version, model, prompt_version)`,
      [meta.sha256, ...[0, 1, 2, 3, 4, 5].map((col) => provenance.map((p) => p[col]))],
    );
    await client.query("DELETE FROM ingest_progress WHERE document_id = $1", [id]);
    await client.query(CLEAR_VECTORS, [id]);
    await client.query("COMMIT");
    stage("rows-written", all.length);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const counts = Object.fromEntries(LEVELS.map((l) => [l, rows[l].length]));
  log(`${status.padEnd(8)}${id} ${LEVELS.map((l) => `${l}=${counts[l]}`).join(" ")}`);
  return { status, counts, ...(contextsSkipped && { contextsSkipped }) };
}

/** Reads the pdftotext version line, e.g. "pdftotext version 24.02.0". */
export async function pdftotextTool() {
  let stderr;
  try {
    ({ stderr } = await execFileAsync("pdftotext", ["-v"], { encoding: "utf8" }));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("pdftotext is not installed; run: brew install poppler", { cause: err });
    }
    throw err;
  }
  const version = /version\s+(\S+)/.exec(stderr)?.[1];
  if (!version) throw new Error(`pdftotext -v printed no version: ${stderr.slice(0, 200)}`);
  return { tool: "pdftotext", version };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = /^--(corpus|root)=(.+)$/.exec(arg);
    if (eq) args[eq[1]] = eq[2];
    else if (arg === "--corpus" || arg === "--root") args[arg.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${arg}; usage: run.mjs --corpus <name> [--root <dir>]`);
  }
  if (!args.corpus) throw new Error("--corpus is required");
  return args;
}

/**
 * Runs the ingest over corpora/<corpus>/manifest.jsonl. A failed document is logged with its
 * evidence id and the run continues. Returns the process exit code.
 * @param {{ argv?: string[], env?: Record<string, string | undefined> }} [options]
 */
export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (env === process.env) {
    try {
      process.loadEnvFile(path.join(REPO_ROOT, ".env"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  const { corpus, root = path.join(REPO_ROOT, "corpora") } = parseArgs(argv);
  corpusInfo(corpus);
  const corpusDir = path.join(root, corpus);
  const manifest = await readManifest(path.join(corpusDir, "manifest.jsonl"));
  const sources = await readSources(path.join(corpusDir, "sources.json"));

  const { providerFromEnv } = await import("../providers/index.mjs");
  const { createDb } = await import("../db.mjs");
  const provider = providerFromEnv(env);
  const extractModel = provider.extractModel ?? env.EXTRACT_MODEL ?? env.CHAT_MODEL;
  if (!extractModel) throw new Error("set EXTRACT_MODEL so provenance can name the model");
  const textTool = await pdftotextTool();
  const db = createDb(env.DATABASE_URL || undefined);

  const started = Date.now();
  const failed = [];
  const tally = { ingested: 0, replaced: 0, skipped: 0 };
  try {
    for (const row of manifest) {
      const source = sources.get(row.evidence_id);
      const meta = documentMeta(corpus, row, source);
      try {
        if (await isIngested(db, { evidenceId: meta.evidenceId, sha256: meta.sha256 })) {
          console.log(`skip    ${meta.evidenceId}`);
          tally.skipped++;
          continue;
        }
        const file = path.join(corpusDir, "raw", source?.file ?? `${row.evidence_id}.pdf`);
        const sha256 = await sha256File(file);
        if (sha256 !== row.sha256) {
          throw new Error(`${file} has sha256 ${sha256}; the manifest records ${row.sha256}`);
        }
        const pages = await pdfToPages(file);
        const result = await ingestDocument({ pages, meta, provider, db, extractModel, textTool });
        tally[result.status]++;
      } catch (err) {
        failed.push(row.evidence_id);
        console.error(`fail    ${row.evidence_id}: ${err.stack ?? err.message}`);
      }
    }
    const { rows } = await db.query(
      `SELECT c.level::text AS level, count(*)::int AS n
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE d.corpus = $1 GROUP BY c.level`,
      [corpus],
    );
    const stored = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    for (const r of rows) stored[r.level] = r.n;
    console.log(
      `documents: ${tally.ingested} ingested, ${tally.replaced} replaced, ${tally.skipped} skipped, ${failed.length} failed`,
    );
    console.log(`chunks in ${corpus}: ${LEVELS.map((l) => `${l}=${stored[l]}`).join(" ")}`);
    console.log(`wall time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (failed.length) console.error(`failed: ${failed.join(", ")}`);
  } finally {
    await db.close();
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err.stack ?? err.message);
      process.exitCode = 1;
    },
  );
}
