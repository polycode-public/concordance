// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Assertion extraction: the sentence chunks of one document into the assertions table, with
// the entities and events they name. A witness assertion is never a fact; nothing here writes
// accepted_facts.
//
// One model call covers a window of consecutive sentences, with the sentence before and the
// sentence after the window as context, so a document of 700 sentences fits one Lambda run.
// Every text value the model returns must be a span of the target sentence it names; a value
// that is not is rejected in code, and the row is dropped, counted and logged. The model never
// names a chunk: source_chunk_id comes from the sentence the code numbered.

import { sha256Text } from "../ingest/run.mjs";
import { loadRegisters, normaliseSpan } from "./registers.mjs";

export const EXTRACT_PROMPT_VERSION = "assertions-v1";
export const EXTRACT_PIPELINE_VERSION = "facts-v1";
export const EXTRACT_STEP = "extract-assertions";
export const EXTRACT_WINDOW = 10;
export const ENTITY_KINDS = Object.freeze(["person", "place", "vehicle", "unit"]);
export const SPAN_FIELDS = Object.freeze([
  "predicate",
  "object_text",
  "event_text",
  "time_text",
  "place_text",
  "modality",
]);
export const WRITE_BATCH_BYTES = 48 * 1024;
const SENTENCE_PAGE = 500;
const EXTRACT_TOOL = "concordance-facts";

const nullableString = { type: ["string", "null"] };

export const ASSERTION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    assertions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "integer" },
          predicate: { type: "string" },
          object_text: nullableString,
          object_kind: { enum: [...ENTITY_KINDS, null] },
          event_text: nullableString,
          time_text: nullableString,
          place_text: nullableString,
          modality: nullableString,
          polarity: { enum: ["positive", "negative"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["sentence", "predicate", "polarity"],
      },
    },
  },
  required: ["assertions"],
});

/**
 * Splits sentences into windows of `size` targets, each with the sentence before and the
 * sentence after it as context.
 * @template T
 * @param {T[]} sentences
 * @param {number} size
 * @returns {{ before: T | null, targets: T[], after: T | null }[]}
 */
export function sentenceWindows(sentences, size = EXTRACT_WINDOW) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("window size must be >= 1");
  const out = [];
  for (let i = 0; i < sentences.length; i += size) {
    out.push({
      before: sentences[i - 1] ?? null,
      targets: sentences.slice(i, i + size),
      after: sentences[i + size] ?? null,
    });
  }
  return out;
}

/**
 * The extraction prompt for one window. A header line and a context line are printed each
 * time they change, so the model reads where in the statement each sentence sits.
 * @param {{ before: object | null, targets: { ordinal: number, text: string,
 *   header?: string | null, context_line?: string | null }[], after: object | null }} window
 */
export function extractPrompt({ before, targets, after }) {
  const lines = [
    "You extract the assertions a witness makes in a statement. An assertion is one claim the witness makes: what happened, or what the witness did, saw, heard or knew.",
    "Extract assertions only from the target sentences, which are numbered [Sn]. The context sentences help you read the targets; extract nothing from them.",
    "Copy every text value exactly as it appears in its own target sentence, with the same words, spelling and case. Do not paraphrase, resolve pronouns or add words. Use null when the sentence does not state the value.",
    "Fields: sentence is the number n of the target sentence. predicate is the verb phrase of the claim. object_text is what the claim is about; object_kind is person, place, vehicle or unit when object_text names one, else null. event_text names the event the claim is about. time_text is the time or date stated. place_text is the place stated. modality is the words that hedge the claim, such as 'I think' or 'about'. polarity is negative when the witness denies the claim, else positive. confidence is from 0 to 1.",
    "Do not judge or interpret the witness.",
    'Reply as JSON: {"assertions": [...]}, with an empty array when the targets make no assertion.',
    "",
  ];
  lines.push(`Context before: ${before?.text ?? "(none)"}`);
  let header;
  let context;
  for (const s of targets) {
    if ((s.header ?? null) !== header) {
      header = s.header ?? null;
      if (header) lines.push(`Header: ${header}`);
    }
    if ((s.context_line ?? null) !== context) {
      context = s.context_line ?? null;
      if (context) lines.push(`Paragraph context: ${context}`);
    }
    lines.push(`[S${s.ordinal}] ${s.text}`);
  }
  lines.push(`Context after: ${after?.text ?? "(none)"}`);
  return lines.join("\n");
}

const reject = (field, reason, value) => ({ ok: false, field, reason, value });

/**
 * Checks one assertion the model returned against the target sentences of its window.
 * Returns the row with its sentence chunk id, or the first rule it breaks.
 * @param {unknown} raw
 * @param {Map<number, { id: string, ordinal: number, text: string }>} targets by ordinal
 */
export function checkAssertion(raw, targets) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return reject(null, "not-an-object", raw);
  }
  const sentence = targets.get(raw.sentence);
  if (!sentence) return reject("sentence", "not-a-target-sentence", raw.sentence);
  const haystack = normaliseSpan(sentence.text);
  const row = { sentence: sentence.ordinal, sourceChunkId: sentence.id };
  for (const field of SPAN_FIELDS) {
    const value = raw[field];
    if (value === null || value === undefined || value === "") {
      if (field === "predicate") return reject(field, "missing", value);
      row[field] = null;
      continue;
    }
    if (typeof value !== "string") return reject(field, "not-a-string", value);
    const span = normaliseSpan(value);
    if (!span) {
      if (field === "predicate") return reject(field, "missing", value);
      row[field] = null;
      continue;
    }
    if (!haystack.includes(span)) return reject(field, "not-in-sentence", value);
    row[field] = span;
  }
  if (raw.polarity !== "positive" && raw.polarity !== "negative") {
    return reject("polarity", "not-positive-or-negative", raw.polarity);
  }
  row.polarity = raw.polarity;
  const kind = raw.object_kind ?? null;
  if (kind !== null && !ENTITY_KINDS.includes(kind)) {
    return reject("object_kind", "not-an-entity-kind", kind);
  }
  if (kind !== null && row.object_text === null) {
    return reject("object_kind", "kind-without-object", kind);
  }
  row.objectKind = kind;
  const confidence = raw.confidence ?? null;
  if (
    confidence !== null &&
    (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))
  ) {
    return reject("confidence", "not-in-0-to-1", confidence);
  }
  row.confidence = confidence;
  return { ok: true, row };
}

const assertionKey = (r) =>
  JSON.stringify([
    r.sourceChunkId,
    r.predicate,
    r.object_text,
    r.event_text,
    r.time_text,
    r.place_text,
    r.modality,
    r.polarity,
  ]);

/**
 * Splits items into batches whose JSON stays within maxBytes, because the RDS Data API
 * refuses a request over 64 KB.
 * @template T
 * @param {T[]} items
 * @param {number} [maxBytes]
 * @returns {T[][]}
 */
export function byteBatches(items, maxBytes = WRITE_BATCH_BYTES) {
  const out = [];
  let batch = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) * 2 + 64;
    if (size > maxBytes) throw new Error(`one row of ${size} bytes is over ${maxBytes}`);
    if (bytes + size > maxBytes && batch.length) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

async function loadSentences(db, documentId) {
  const sentences = [];
  for (;;) {
    const after = sentences.at(-1)?.ordinal ?? -1;
    const { rows } = await db.query(
      `SELECT id, ordinal, text, header, context_line FROM chunks
        WHERE document_id = $1 AND level = 'sentence' AND ordinal > $2
        ORDER BY ordinal LIMIT $3`,
      [documentId, after, SENTENCE_PAGE],
    );
    sentences.push(...rows.map((r) => ({ ...r, id: String(r.id), ordinal: Number(r.ordinal) })));
    if (rows.length < SENTENCE_PAGE) return sentences;
  }
}

/**
 * The entity a span names: an entity in the register, the entity named by the witness id a
 * span resolves to, or a new entity of kindHint. A witness's entity is named by its id, which
 * for a cipher-only witness is the cipher.
 */
function entityFor(registers, span, kindHint) {
  if (span === null) return null;
  const match = registers.resolve(span);
  if (match?.type === "entity") return { id: match.id };
  if (match?.type === "witness") return { kind: "person", canonical: match.id };
  return kindHint ? { kind: kindHint, canonical: span } : null;
}

const entityKey = (kind, canonical) => `${kind}\u0000${canonical}`;

const INSERT_ENTITIES = `
  INSERT INTO entities (kind, canonical)
  SELECT u.kind, u.canonical FROM unnest($1::text[], $2::text[]) AS u(kind, canonical)
  ON CONFLICT (kind, lower(canonical)) DO NOTHING`;

const SELECT_ENTITIES = `
  SELECT u.kind, u.canonical, e.id
    FROM unnest($1::text[], $2::text[]) AS u(kind, canonical)
    JOIN entities e ON e.kind = u.kind AND lower(e.canonical) = lower(u.canonical)`;

const INSERT_EVENTS = `
  INSERT INTO events (name) SELECT u.name FROM unnest($1::text[]) AS u(name)
  ON CONFLICT (lower(name)) DO NOTHING`;

const SELECT_EVENTS = `
  SELECT u.name, e.id FROM unnest($1::text[]) AS u(name)
    JOIN events e ON lower(e.name) = lower(u.name)`;

const INSERT_ASSERTIONS = `
  INSERT INTO assertions (witness_id, source_chunk_id, event_id, predicate, object_text,
                          object_entity_id, time_text, place_text, place_entity_id, polarity,
                          modality, confidence, extractor, pipeline_version)
  SELECT $1, u.chunk, u.event, u.predicate, u.object_text, u.object_entity, u.time_text,
         u.place_text, u.place_entity, u.polarity, u.modality, u.confidence, $2, $3
    FROM unnest($4::bigint[], $5::bigint[], $6::text[], $7::text[], $8::bigint[], $9::text[],
                $10::text[], $11::bigint[], $12::text[], $13::text[], $14::real[])
      AS u(chunk, event, predicate, object_text, object_entity, time_text, place_text,
           place_entity, polarity, modality, confidence)`;

const DELETE_ASSERTIONS = `
  DELETE FROM assertions a USING chunks c
   WHERE a.source_chunk_id = c.id AND c.document_id = $1`;

const SELECT_PROGRESS = `
  SELECT source_sha256, tool_version, model, prompt_version, window_size, windows_done
    FROM extraction_progress WHERE document_id = $1`;

const UPSERT_PROGRESS = `
  INSERT INTO extraction_progress (document_id, source_sha256, tool_version, model,
                                   prompt_version, window_size, windows_done)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (document_id) DO UPDATE SET
    source_sha256 = EXCLUDED.source_sha256, tool_version = EXCLUDED.tool_version,
    model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version,
    window_size = EXCLUDED.window_size, windows_done = EXCLUDED.windows_done,
    updated_at = now()`;

const DELETE_PROGRESS = "DELETE FROM extraction_progress WHERE document_id = $1";

const ASSERTION_COLUMNS = [
  "chunk",
  "event",
  "predicate",
  "object_text",
  "object_entity",
  "time_text",
  "place_text",
  "place_entity",
  "polarity",
  "modality",
  "confidence",
];

/**
 * Extracts the assertions of one ingested document. Each window's rows are written in their
 * own transaction together with a progress row, so a stopped run keeps what it stored and the
 * next run resumes after the last stored window. When the abort signal fires the run stores
 * the window in hand and returns status "partial". The finished provenance row is written in
 * the transaction of the last window. A document whose sentence set was already extracted
 * with this model, prompt and pipeline version is skipped; one extracted under another
 * version, or whose sentences changed, is replaced from the first window.
 * @param {object} args
 * @param {string} args.documentId
 * @param {import('../providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {{ pool: { connect: Function }, query: Function }} args.db
 * @param {number} [args.window]
 * @param {string} [args.pipelineVersion]
 * @param {string} [args.extractModel]
 * @param {AbortSignal} [args.signal]
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 */
export async function extractAssertions({
  documentId,
  provider,
  db,
  window = EXTRACT_WINDOW,
  pipelineVersion = EXTRACT_PIPELINE_VERSION,
  extractModel = provider.extractModel,
  signal,
  log = console.log,
  now = Date.now,
}) {
  if (!documentId) throw new Error("documentId is required");
  if (!extractModel) throw new Error(`${documentId}: the extraction model id is unknown`);
  const started = now();
  const stage = (name, count, extra = {}) =>
    log(
      JSON.stringify({ evidenceId: documentId, stage: name, count, ...extra, ms: now() - started }),
    );

  const {
    rows: [document],
  } = await db.query("SELECT id, witness_id FROM documents WHERE id = $1", [documentId]);
  if (!document) throw new Error(`${documentId} is not ingested`);
  const sentences = await loadSentences(db, documentId);
  if (!sentences.length) throw new Error(`${documentId} has no sentence chunks`);
  stage("sentences-loaded", sentences.length);

  const windows = sentenceWindows(sentences, window);
  const sourceSha256 = sha256Text(JSON.stringify(sentences.map((s) => [s.id, s.text])));
  const zero = { sentences: sentences.length, calls: 0, kept: 0, rejected: 0, written: 0 };
  const done = await db.query(
    `SELECT 1 FROM provenance WHERE source_sha256 = $1 AND step = $2 AND tool_version = $3
        AND model = $4 AND prompt_version = $5`,
    [sourceSha256, EXTRACT_STEP, pipelineVersion, extractModel, EXTRACT_PROMPT_VERSION],
  );
  if (done.rows.length) {
    stage("skipped", 0);
    return {
      status: "skipped",
      counts: zero,
      windows: { done: windows.length, total: windows.length },
    };
  }

  const {
    rows: [progress],
  } = await db.query(SELECT_PROGRESS, [documentId]);
  const resumes =
    progress &&
    progress.source_sha256 === sourceSha256 &&
    progress.tool_version === pipelineVersion &&
    progress.model === extractModel &&
    progress.prompt_version === EXTRACT_PROMPT_VERSION &&
    Number(progress.window_size) === window &&
    Number(progress.windows_done) < windows.length;
  const first = resumes ? Number(progress.windows_done) : 0;
  if (first > 0) stage("resumed", first);

  const registers = await loadRegisters(db);
  if (registers.ignoredAliases.length) {
    stage("cipher-entity-aliases-ignored", registers.ignoredAliases.length);
  }

  const seen = new Set();
  const rejected = {};
  let calls = 0;
  let keptCount = 0;
  let written = 0;
  let entityCount = 0;
  let eventCount = 0;
  let replaced = false;
  let next = first;

  const writeWindow = async (kept, index) => {
    for (const r of kept) {
      r.objectEntity = entityFor(registers, r.object_text, r.objectKind);
      r.placeEntity = entityFor(registers, r.place_text, "place");
    }
    const newEntities = new Map();
    for (const r of kept) {
      for (const e of [r.objectEntity, r.placeEntity]) {
        if (e && !e.id) newEntities.set(entityKey(e.kind, e.canonical.toLowerCase()), e);
      }
    }
    const eventNames = new Map();
    for (const r of kept)
      if (r.event_text) eventNames.set(r.event_text.toLowerCase(), r.event_text);

    const last = index === windows.length - 1;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      if (index === 0) {
        const removed = await client.query(DELETE_ASSERTIONS, [documentId]);
        if (removed.rowCount) replaced = true;
      }
      const entityIds = new Map();
      for (const batch of byteBatches([...newEntities.values()])) {
        const params = [batch.map((e) => e.kind), batch.map((e) => e.canonical)];
        await client.query(INSERT_ENTITIES, params);
        for (const row of (await client.query(SELECT_ENTITIES, params)).rows) {
          entityIds.set(entityKey(row.kind, row.canonical.toLowerCase()), String(row.id));
        }
      }
      const eventIds = new Map();
      for (const batch of byteBatches([...eventNames.values()])) {
        await client.query(INSERT_EVENTS, [batch]);
        for (const row of (await client.query(SELECT_EVENTS, [batch])).rows) {
          eventIds.set(row.name.toLowerCase(), String(row.id));
        }
      }
      const idOf = (e) => {
        if (!e) return null;
        if (e.id) return e.id;
        const id = entityIds.get(entityKey(e.kind, e.canonical.toLowerCase()));
        if (!id) throw new Error(`${documentId}: entity ${e.kind} ${e.canonical} was not stored`);
        return id;
      };
      const rows = kept.map((r) => ({
        chunk: r.sourceChunkId,
        event: r.event_text ? eventIds.get(r.event_text.toLowerCase()) : null,
        predicate: r.predicate,
        object_text: r.object_text,
        object_entity: idOf(r.objectEntity),
        time_text: r.time_text,
        place_text: r.place_text,
        place_entity: idOf(r.placeEntity),
        polarity: r.polarity,
        modality: r.modality,
        confidence: r.confidence,
      }));
      for (const row of rows) {
        if (row.event === undefined) throw new Error(`${documentId}: an event was not stored`);
      }
      let stored = 0;
      for (const batch of byteBatches(rows)) {
        const result = await client.query(INSERT_ASSERTIONS, [
          document.witness_id,
          extractModel,
          pipelineVersion,
          ...ASSERTION_COLUMNS.map((c) => batch.map((r) => r[c])),
        ]);
        stored += result.rowCount ?? batch.length;
      }
      if (last) {
        await client.query(
          `INSERT INTO provenance (derived_sha256, source_sha256, step, tool, tool_version, model, prompt_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sha256Text(JSON.stringify([sourceSha256, window, windows.length])),
            sourceSha256,
            EXTRACT_STEP,
            EXTRACT_TOOL,
            pipelineVersion,
            extractModel,
            EXTRACT_PROMPT_VERSION,
          ],
        );
        await client.query(DELETE_PROGRESS, [documentId]);
      } else {
        await client.query(UPSERT_PROGRESS, [
          documentId,
          sourceSha256,
          pipelineVersion,
          extractModel,
          EXTRACT_PROMPT_VERSION,
          window,
          index + 1,
        ]);
      }
      await client.query("COMMIT");
      written += stored;
      entityCount += newEntities.size;
      eventCount += eventNames.size;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  let stopped = false;
  for (; next < windows.length; next++) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const w = windows[next];
    let result;
    try {
      result = await provider.extractJson({
        prompt: extractPrompt(w),
        schema: ASSERTION_SCHEMA,
        signal,
      });
    } catch (err) {
      if (!signal?.aborted) throw err;
      stopped = true;
      break;
    }
    calls++;
    if (!Array.isArray(result?.assertions)) {
      throw new Error(
        `${documentId}: the extraction model returned no assertions array for sentences ` +
          `${w.targets[0].ordinal}-${w.targets.at(-1).ordinal}: ${JSON.stringify(result).slice(0, 200)}`,
      );
    }
    const kept = [];
    const targets = new Map(w.targets.map((s) => [s.ordinal, s]));
    for (const raw of result.assertions) {
      const checked = checkAssertion(raw, targets);
      let reason = checked.ok ? null : checked.reason;
      if (checked.ok) {
        const k = assertionKey(checked.row);
        if (seen.has(k)) reason = "duplicate";
        else {
          seen.add(k);
          kept.push(checked.row);
        }
      }
      if (reason) {
        rejected[reason] = (rejected[reason] ?? 0) + 1;
        log(
          JSON.stringify({
            evidenceId: documentId,
            stage: "assertion-rejected",
            sentence: raw?.sentence ?? null,
            field: checked.field ?? null,
            reason,
            value: JSON.stringify(checked.value ?? raw?.predicate ?? null).slice(0, 200),
          }),
        );
      }
    }
    keptCount += kept.length;
    await writeWindow(kept, next);
  }
  const rejectedCount = Object.values(rejected).reduce((a, b) => a + b, 0);
  stage("calls-made", calls);
  stage("assertions-kept", keptCount);
  stage("assertions-rejected", rejectedCount, { reasons: rejected });
  stage("rows-written", written, { entities: entityCount, events: eventCount });
  const counts = {
    sentences: sentences.length,
    calls,
    kept: keptCount,
    rejected: rejectedCount,
    written,
  };
  if (stopped) {
    stage("stopped", next, { windows: windows.length });
    return { status: "partial", counts, windows: { done: next, total: windows.length } };
  }
  return {
    status: first === 0 && replaced ? "replaced" : "extracted",
    counts,
    windows: { done: windows.length, total: windows.length },
  };
}
