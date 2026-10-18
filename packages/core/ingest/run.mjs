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
// - A document with no numbered paragraph fails, because this scheme cannot locate its text.
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
import { sha256File } from "./hash.mjs";
import { pdfToPages } from "./pdfText.mjs";

export const PIPELINE_VERSION = "ingest-v1";
export const CONTEXT_PROMPT_VERSION = "context-v1";
export const ABSTRACT_PROMPT_VERSION = "abstract-v1";
export const EMBED_BATCH_SIZE = 32;
export const ABSTRACT_INPUT_CHARS = 12000;
export const LEVELS = Object.freeze(["document", "section", "passage", "sentence"]);

const INGEST_TOOL = "concordance-ingest";
const LOCATOR_SCHEME = "page-paragraph";

const CORPORA = Object.freeze({
  grenfell: Object.freeze({ label: "Grenfell Inquiry", eventDate: "2017-06-14" }),
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
 * Formats a vector as a pgvector halfvec literal. Throws on a wrong length or a value that
 * is not a finite number.
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
  return `[${vector.join(",")}]`;
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
 * optionally with witness_id. Returns a Map keyed by evidence id.
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
    for (const field of ["url", "role", "file", "witness_id"]) optionalString(field);
    if (entry.floor != null && !["string", "number"].includes(typeof entry.floor)) {
      throw new Error(`${where}: floor must be a string or a number`);
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
 * the sources witness_id, else the evidence id, until the witness register maps them.
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
    statementDate: source?.statement_date ?? null,
  };
}

/**
 * Splits pages into sections (numbered paragraphs), passages and sentences with their
 * locators. Passage and sentence ordinals run across the whole document.
 * @param {{ page: number, text: string }[]} pages
 */
export function planChunks(pages) {
  const sections = splitNumberedParagraphs(pages);
  if (!sections.some((s) => s.paragraph != null)) {
    throw new Error(
      "no numbered paragraph found; the page-paragraph locator cannot place the text",
    );
  }
  let passageOrdinal = 0;
  let sentenceOrdinal = 0;
  return sections.map((section, ordinal) => {
    const locator = { page: section.page, paragraph: section.paragraph };
    const sentences = splitSentences(section.text);
    return {
      ordinal,
      text: section.text,
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
         u.embedding::halfvec, $3, $4, $5
    FROM unnest($6::int[], $7::text[], $8::text[], $9::text[], $10::jsonb[], $11::bigint[], $12::text[])
      AS u(ordinal, text, header, context_line, locator, parent_id, embedding)
  RETURNING id, ordinal`;

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
 * @param {object} args
 * @param {{ page: number, text: string }[]} args.pages
 * @param {ReturnType<typeof documentMeta>} args.meta
 * @param {import('../providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {{ pool: { connect: Function }, query: Function }} args.db
 * @param {string} [args.pipelineVersion]
 * @param {string} [args.extractModel]  the model id recorded in provenance
 * @param {{ tool: string, version: string | null }} [args.textTool]  the text extractor
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ status: 'skipped' | 'ingested' | 'replaced', counts: Record<string, number> }>}
 */
export async function ingestDocument({
  pages,
  meta,
  provider,
  db,
  pipelineVersion = PIPELINE_VERSION,
  extractModel = provider.extractModel,
  textTool = { tool: "pdftotext", version: null },
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

  const info = corpusInfo(meta.corpus);
  const headerFor = (locator) =>
    buildHeader({
      corpus: info.label,
      witnessId: meta.witnessId,
      role: meta.role ?? undefined,
      statementDate: meta.statementDate ?? undefined,
      eventDate: info.eventDate,
      locator,
    });

  const sections = planChunks(pages);
  const extractedText = pages.map((p) => p.text).join("\f");

  for (const [i, section] of sections.entries()) {
    section.header = headerFor(section.locator);
    section.context = await extractString(
      provider,
      {
        prompt: contextPrompt({
          header: section.header,
          previous: sections[i - 1]?.text,
          text: section.text,
        }),
        schema: CONTEXT_SCHEMA,
      },
      "context",
    );
  }
  const documentHeader = headerFor(undefined);
  const abstract = await extractString(
    provider,
    {
      prompt: abstractPrompt({
        header: documentHeader,
        text: sections
          .map((s) => s.text)
          .join("\n")
          .slice(0, ABSTRACT_INPUT_CHARS),
      }),
      schema: ABSTRACT_SCHEMA,
    },
    "abstract",
  );

  const rows = {
    document: [
      {
        ordinal: 0,
        text: abstract,
        header: documentHeader,
        context: null,
        locator: { page: pages[0]?.page ?? 1, paragraph: null },
      },
    ],
    section: sections.map((s) => ({ ...s, parent: 0 })),
    passage: sections.flatMap((s) =>
      s.passages.map((p) => ({ ...p, header: s.header, context: s.context, parent: s.ordinal })),
    ),
    sentence: sections.flatMap((s) =>
      s.sentences.map((p) => ({ ...p, header: s.header, context: s.context, parent: s.ordinal })),
    ),
  };

  const all = LEVELS.flatMap((level) => rows[level]);
  for (const batch of batches(all, EMBED_BATCH_SIZE)) {
    const vectors = await provider.embed(
      batch.map((r) => `${r.header}\n${r.context ? `${r.context}\n` : ""}${r.text}`),
    );
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error(`${id}: embed returned ${vectors?.length} vectors for ${batch.length} texts`);
    }
    batch.forEach((r, i) => {
      r.embedding = toHalfvecLiteral(vectors[i], provider.embedDim);
    });
  }

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
      await client.query(
        "INSERT INTO witnesses (id, role) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [meta.witnessId, meta.role],
      );
    }
    await client.query(
      `INSERT INTO documents (id, corpus, source_url, fetched_at, sha256, licence, format,
                              witness_id, role, statement_date, event_date, page_count,
                              locator_scheme, abstract, pipeline_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'pdf', $7, $8, $9, $10, $11, $12, $13, $14)`,
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
      const levelRows = rows[level];
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
        levelRows.map((r) => r.embedding),
      ]);
      idsByLevel[level] = new Map(inserted.map((r) => [r.ordinal, r.id]));
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
      ...sections.map((s) => [
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
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const counts = Object.fromEntries(LEVELS.map((l) => [l, rows[l].length]));
  log(`${status.padEnd(8)}${id} ${LEVELS.map((l) => `${l}=${counts[l]}`).join(" ")}`);
  return { status, counts };
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
