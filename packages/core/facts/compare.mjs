// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One comparison run over a corpus: load the assertions and accepted facts, align them into
// candidate pairs, label what the rules decide, then label the rest through the model in batches,
// writing each batch as it is labelled. The run is keyed on the pipeline version, the model and a
// hash of its input: a complete run with the same key returns at once and inserts nothing, and a
// partial run (stopped by its deadline) resumes where it stopped, because a pair already labelled
// under this pipeline version and model is skipped. Nothing here writes accepted_facts.

import { sha256Text } from "../ingest/run.mjs";
import { byteBatches } from "./extract.mjs";
import {
  alignAssertions,
  alignFacts,
  claimText,
  eligible,
  embedTexts,
  factText,
  pairKey,
} from "./align.mjs";
import {
  NLI_PROMPT_VERSION,
  PAIRS_PER_CALL,
  RULES_MODEL,
  checkLabel,
  nliPrompt,
  nliSchema,
  rulesLabel,
} from "./nli.mjs";

export const COMPARE_PIPELINE_VERSION = "compare-v3";
/** A running row older than this belongs to an invocation that died; the Lambda timeout is 15. */
export const LEASE_MINUTES = 16;
const ASSERTION_PAGE = 400;
const LABELLED_PAGE = 2000;

export const RUN_SQL = Object.freeze({
  assertions: `
  SELECT a.id, a.witness_id, a.source_chunk_id, a.event_id, a.subject_text, a.subject_kind,
         a.claim_kind, a.subject_entity_id, sw.id AS subject_witness_id,
         a.predicate, a.object_text, a.object_entity_id, oe.kind AS object_entity_kind,
         a.time_text, a.place_text, a.place_entity_id, a.polarity, a.modality, a.confidence,
         c.document_id, c.text AS sentence,
         to_char(d.statement_date, 'YYYY-MM-DD') AS statement_date
    FROM assertions a
    JOIN chunks c ON c.id = a.source_chunk_id
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN entities oe ON oe.id = a.object_entity_id
    LEFT JOIN entities se ON se.id = a.subject_entity_id AND se.kind = 'person'
    LEFT JOIN witnesses sw ON sw.id = se.canonical
   WHERE d.corpus = $1 AND a.id > $2::bigint
   ORDER BY a.id LIMIT $3`,
  facts: `SELECT id, assertion_id, text, is_hypothesis FROM accepted_facts ORDER BY id`,
  findRun: `
  SELECT id, status, counts, started_at FROM comparison_runs
   WHERE corpus = $1 AND pipeline_version = $2 AND input_sha256 = $3 AND model = $4`,
  insertRun: `
  INSERT INTO comparison_runs (corpus, pipeline_version, prompt_version, input_sha256, model)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (corpus, pipeline_version, input_sha256, model) DO NOTHING
  RETURNING id`,
  claimRun: `
  UPDATE comparison_runs SET status = 'running', started_at = now(), finished_at = NULL
   WHERE id = $1::bigint
     AND (status <> 'running' OR started_at < now() - make_interval(mins => $2::int))
  RETURNING id`,
  labelled: `
  SELECT c.id, c.kind, c.assertion_a, c.assertion_b, c.accepted_fact_id
    FROM assertion_comparisons c JOIN comparison_runs r ON r.id = c.run_id
   WHERE r.corpus = $1 AND r.pipeline_version = $2 AND r.model = $3 AND c.id > $4::bigint
   ORDER BY c.id LIMIT $5`,
  insertComparisons: `
  INSERT INTO assertion_comparisons (run_id, model, kind, assertion_a, assertion_b,
                                     accepted_fact_id, label, reason, span_a, span_b,
                                     event_id, topic, similarity)
  SELECT $1::bigint, u.model, u.kind, u.a, u.b, u.fact, u.label, u.reason, u.span_a, u.span_b,
         u.event, u.topic, u.similarity
    FROM unnest($2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::text[],
                $8::text[], $9::text[], $10::text[], $11::bigint[], $12::text[], $13::real[])
      AS u(model, kind, a, b, fact, label, reason, span_a, span_b, event, topic, similarity)
  ON CONFLICT DO NOTHING`,
  finishRun: `
  UPDATE comparison_runs SET status = $2, counts = $3::jsonb, finished_at = now()
   WHERE id = $1::bigint`,
});

const id = (v) => (v === null || v === undefined ? null : String(v));

/** An assertion row of RUN_SQL.assertions in the shape alignment reads. */
export function assertionFromRow(r) {
  return {
    id: String(r.id),
    witnessId: r.witness_id ?? null,
    documentId: r.document_id,
    statementDate: r.statement_date ?? null,
    chunkId: id(r.source_chunk_id),
    eventId: id(r.event_id),
    subjectText: r.subject_text ?? null,
    subjectKind: r.subject_kind ?? null,
    claimKind: r.claim_kind ?? null,
    subjectEntityId: id(r.subject_entity_id),
    subjectWitnessId: r.subject_witness_id ?? null,
    predicate: r.predicate,
    objectText: r.object_text ?? null,
    objectEntityId: id(r.object_entity_id),
    objectEntityKind: r.object_entity_kind ?? null,
    timeText: r.time_text ?? null,
    placeText: r.place_text ?? null,
    placeEntityId: id(r.place_entity_id),
    polarity: r.polarity,
    modality: r.modality ?? null,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    sentence: r.sentence,
  };
}

async function loadAssertions(db, corpus) {
  const out = [];
  for (;;) {
    const after = out.at(-1)?.id ?? "0";
    const { rows } = await db.query(RUN_SQL.assertions, [corpus, after, ASSERTION_PAGE]);
    out.push(...rows.map(assertionFromRow));
    if (rows.length < ASSERTION_PAGE) return out;
  }
}

async function loadLabelled(db, corpus, pipelineVersion, model) {
  const keys = new Set();
  let after = "0";
  for (;;) {
    const { rows } = await db.query(RUN_SQL.labelled, [
      corpus,
      pipelineVersion,
      model,
      after,
      LABELLED_PAGE,
    ]);
    for (const r of rows) {
      keys.add(
        pairKey({
          kind: r.kind,
          a: { id: String(r.assertion_a) },
          b: r.assertion_b ? { id: String(r.assertion_b) } : null,
          fact: r.accepted_fact_id ? { id: String(r.accepted_fact_id) } : null,
        }),
      );
      after = String(r.id);
    }
    if (rows.length < LABELLED_PAGE) return keys;
  }
}

/** The hash of what a run reads: every assertion's compared fields and every accepted fact. */
export function inputHash(assertions, facts) {
  return sha256Text(
    JSON.stringify({
      assertions: assertions.map((a) => [
        a.id,
        a.witnessId,
        a.chunkId,
        a.eventId,
        a.subjectText,
        a.subjectKind,
        a.claimKind,
        a.subjectEntityId,
        a.subjectWitnessId,
        a.predicate,
        a.objectText,
        a.objectEntityId,
        a.objectEntityKind,
        a.timeText,
        a.placeText,
        a.placeEntityId,
        a.polarity,
        a.confidence,
      ]),
      facts: facts.map((f) => [f.id, f.assertionId, f.text]),
    }),
  );
}

const COLUMNS = [
  "model",
  "kind",
  "a",
  "b",
  "fact",
  "label",
  "reason",
  "span_a",
  "span_b",
  "event",
  "topic",
  "similarity",
];

const rowOf = (pair, model, label) => ({
  model,
  kind: pair.kind,
  a: pair.a.id,
  b: pair.b?.id ?? null,
  fact: pair.fact?.id ?? null,
  label: label.label,
  reason: label.reason,
  span_a: label.spanA,
  span_b: label.spanB,
  event: pair.eventId,
  topic: pair.topic,
  similarity: Math.round(pair.similarity * 1e4) / 1e4,
});

async function insertRows(db, runId, rows) {
  let written = 0;
  for (const batch of byteBatches(rows)) {
    const result = await db.query(RUN_SQL.insertComparisons, [
      runId,
      ...COLUMNS.map((c) => batch.map((r) => r[c])),
    ]);
    written += result.rowCount ?? batch.length;
  }
  return written;
}

/** Splits pairs into model batches of one family, witness pairs first. */
export function modelBatches(pairs, size = PAIRS_PER_CALL) {
  const out = [];
  for (const family of [
    pairs.filter((p) => p.kind !== "accepted"),
    pairs.filter((p) => p.kind === "accepted"),
  ]) {
    for (let i = 0; i < family.length; i += size) out.push(family.slice(i, i + size));
  }
  return out;
}

/**
 * Runs alignment and labelling over one corpus.
 * @param {object} args
 * @param {string} args.corpus
 * @param {{ query: Function }} args.db
 * @param {import('../providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {string} [args.pipelineVersion]
 * @param {number} [args.deadline] epoch ms after which no model call starts
 * @param {AbortSignal} [args.signal]
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {object} [args.bounds] alignment bounds, for tests
 */
export async function runComparison({
  corpus,
  db,
  provider,
  pipelineVersion = COMPARE_PIPELINE_VERSION,
  deadline = Infinity,
  signal,
  log = console.log,
  now = Date.now,
  bounds,
}) {
  if (!corpus) throw new Error("corpus is required");
  const model = provider.extractModel;
  if (!model) throw new Error("the model id for labelling is unknown");
  const started = now();
  const stage = (name, count, extra = {}) =>
    log(JSON.stringify({ corpus, stage: name, count, ...extra, ms: now() - started }));

  const assertions = await loadAssertions(db, corpus);
  const facts = (await db.query(RUN_SQL.facts)).rows.map((f) => ({
    id: String(f.id),
    assertionId: id(f.assertion_id),
    text: f.text,
    isHypothesis: Boolean(f.is_hypothesis),
  }));
  stage("assertions-loaded", assertions.length, { facts: facts.length });
  const hash = inputHash(assertions, facts);

  const key = [corpus, pipelineVersion, hash, model];
  let found = (await db.query(RUN_SQL.findRun, key)).rows[0];
  if (found?.status === "complete") {
    stage("skipped", 0, { runId: String(found.id) });
    return { status: "skipped", runId: String(found.id), counts: found.counts };
  }
  let owned = false;
  if (!found) {
    const inserted = await db.query(RUN_SQL.insertRun, [
      corpus,
      pipelineVersion,
      NLI_PROMPT_VERSION,
      hash,
      model,
    ]);
    owned = inserted.rows.length > 0;
    found = (await db.query(RUN_SQL.findRun, key)).rows[0];
    if (!found) throw new Error(`${corpus}: the comparison run row was not stored`);
  }
  const runId = String(found.id);
  if (!owned) {
    const claimed = await db.query(RUN_SQL.claimRun, [runId, LEASE_MINUTES]);
    if (claimed.rows.length === 0) {
      const startedAt =
        found.started_at instanceof Date
          ? found.started_at.toISOString()
          : String(found.started_at);
      stage("held", 0, { runId, startedAt });
      return { status: "running", runId, startedAt };
    }
  }
  const progress = { counts: {} };
  try {
    return await labelRun({
      corpus,
      db,
      provider,
      pipelineVersion,
      deadline,
      signal,
      log,
      now,
      bounds,
      model,
      stage,
      assertions,
      facts,
      runId,
      progress,
    });
  } catch (error) {
    // Best effort: the original error is the one that surfaces, and a stale lease frees the row
    // if this write fails too.
    try {
      await db.query(RUN_SQL.finishRun, [runId, "partial", progress.counts]);
    } catch (finishError) {
      stage("finish-failed", 0, { runId, error: String(finishError?.message ?? finishError) });
    }
    throw error;
  }
}

async function labelRun({
  corpus,
  db,
  provider,
  pipelineVersion,
  deadline,
  signal,
  log,
  now,
  bounds,
  model,
  stage,
  assertions,
  facts,
  runId,
  progress,
}) {
  const labelled = await loadLabelled(db, corpus, pipelineVersion, model);
  stage("run-opened", labelled.size, { runId });

  const compared = assertions.filter(eligible);
  const byId = new Map(assertions.map((a) => [a.id, a]));
  const vectors = await embedTexts(provider, [
    ...compared.map(claimText),
    ...facts.map((f) => factText(f, f.assertionId ? byId.get(f.assertionId) : null)),
  ]);
  stage("claims-embedded", vectors.size, { compared: compared.length });

  const cross = alignAssertions(compared, vectors, bounds);
  const accepted = alignFacts(facts, compared, byId, vectors, bounds);
  const all = [...cross.pairs, ...accepted.pairs];
  const open = all.filter((p) => !labelled.has(pairKey(p)));
  stage("pairs-aligned", all.length, {
    candidates: cross.candidates,
    droppedByBound: cross.dropped,
    accepted: accepted.pairs.length,
    open: open.length,
  });

  const counts = {
    assertions: assertions.length,
    compared: compared.length,
    pairs: all.length,
    alreadyLabelled: all.length - open.length,
    rules: 0,
    modelCalls: 0,
    modelLabelled: 0,
    rejected: 0,
    unanswered: 0,
    written: 0,
    remaining: 0,
  };
  progress.counts = counts;
  const forModel = [];
  const ruled = [];
  for (const pair of open) {
    const label = rulesLabel(pair);
    if (label) ruled.push(rowOf(pair, RULES_MODEL, label));
    else forModel.push(pair);
  }
  counts.rules = ruled.length;
  counts.written += await insertRows(db, runId, ruled);
  stage("rules-labelled", ruled.length);

  const rejected = {};
  const batches = modelBatches(forModel);
  let stopped = false;
  for (let i = 0; i < batches.length; i++) {
    if (now() >= deadline || signal?.aborted) {
      stopped = true;
      counts.remaining = batches.slice(i).reduce((n, b) => n + b.length, 0);
      break;
    }
    const batch = batches[i];
    let reply;
    try {
      reply = await provider.extractJson({
        prompt: nliPrompt(batch),
        schema: nliSchema(batch[0].kind),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        counts.remaining = batches.slice(i).reduce((n, b) => n + b.length, 0);
        break;
      }
      throw err;
    }
    counts.modelCalls++;
    if (!Array.isArray(reply?.labels)) {
      throw new Error(
        `${corpus}: the model returned no labels array: ${JSON.stringify(reply).slice(0, 200)}`,
      );
    }
    const rows = [];
    const done = new Set();
    for (const raw of reply.labels) {
      const checked = checkLabel(raw, batch);
      let reason = checked.ok ? null : checked.reason;
      if (checked.ok && done.has(checked.index)) reason = "duplicate";
      if (reason) {
        rejected[reason] = (rejected[reason] ?? 0) + 1;
        log(
          JSON.stringify({
            corpus,
            stage: "label-rejected",
            reason,
            value: JSON.stringify(checked.value ?? raw?.pair ?? null).slice(0, 200),
          }),
        );
        continue;
      }
      done.add(checked.index);
      rows.push(rowOf(batch[checked.index], model, checked));
    }
    counts.unanswered += batch.length - done.size;
    counts.modelLabelled += rows.length;
    counts.written += await insertRows(db, runId, rows);
  }
  counts.rejected = Object.values(rejected).reduce((a, b) => a + b, 0);
  stage("model-labelled", counts.modelLabelled, {
    calls: counts.modelCalls,
    rejected,
    unanswered: counts.unanswered,
  });

  const status = stopped ? "partial" : "complete";
  await db.query(RUN_SQL.finishRun, [runId, status, counts]);
  stage("run-finished", counts.written, { status });
  return { status, runId, counts };
}
