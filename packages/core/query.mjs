// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The query pipeline: hybrid retrieval, fusion, expansion, a closed-world answer,
// the citation check, and the map from [En] to the locator stored at ingest.
import { citationTags, markUnsupported } from "./checks/citations.mjs";
import { ABSTAIN_PHRASE, PROMPT_VERSION, answerMessages } from "./prompt.mjs";
import {
  buildEvidence,
  loadDocuments,
  neighbourIds,
  withDocuments,
  MAX_HITS,
} from "./retrieval/expand.mjs";
import { loadChunks, retrieve } from "./retrieval/hybrid.mjs";

/** A response with more flagged sentences than this ratio carries a warning. */
export const WARNING_RATIO = 0.3;

export const NO_EVIDENCE_ANSWER = "The corpus does not say.";

/**
 * The citation locator for an evidence block: the document id and the page and
 * paragraph stored in the chunk row, in that key order.
 * @param {{ documentId: string, locator: { page?: unknown, paragraph?: unknown } }} block
 */
export function citationLocator(block) {
  return {
    document: block.documentId,
    page: block.locator.page ?? null,
    paragraph: block.locator.paragraph ?? null,
  };
}

/**
 * Checks the answer sentence by sentence and resolves its [En] tags. A tag that
 * names no evidence block does not count as support and is dropped.
 * @param {string} answer
 * @param {{ evidence: number, documentId: string, locator: object }[]} blocks
 */
export function checkAnswer(answer, blocks) {
  const byNumber = new Map(blocks.map((b) => [b.evidence, b]));
  const marked = markUnsupported(answer);
  const citations = [];
  const cited = new Set();
  let droppedCitations = 0;
  const marks = marked.sentences.map((s) => {
    const tags = s.tags.filter((n) => byNumber.has(n));
    droppedCitations += s.tags.length - tags.length;
    for (const n of tags) {
      if (cited.has(n)) continue;
      cited.add(n);
      citations.push({ evidence: n, locator: citationLocator(byNumber.get(n)) });
    }
    return { text: s.text, supported: tags.length > 0, tags };
  });
  const supported = marks.filter((m) => m.supported).length;
  const flaggedRatio = marks.length ? (marks.length - supported) / marks.length : 0;
  return {
    citations,
    checks: {
      sentences: marks.length,
      supported,
      flaggedRatio,
      warning: flaggedRatio > WARNING_RATIO,
      droppedCitations,
      marks,
    },
  };
}

/**
 * True when no evidence was retrieved, or the answer carries the closed-world phrase and cites
 * nothing. An answer that cites evidence and abstains for part of the question keeps its
 * citations and its checks.
 */
export const isAbstention = (answer, blocks) =>
  blocks.length === 0 ||
  (answer.toLowerCase().includes(ABSTAIN_PHRASE) && citationTags(answer).length === 0);

/**
 * Runs one question through the pipeline.
 * @param {object} args
 * @param {string} args.question
 * @param {import('./providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {{ query: Function }} args.db
 * @param {AbortSignal} [args.signal]
 * @param {(text: string) => void} [args.onToken]
 * @param {(stage: 'rewriting' | 'retrieving' | 'answering' | 'checking') => void} [args.onStage]
 * @param {(blocks: object[]) => void} [args.onEvidence]
 * @returns {Promise<{ answer: string, abstained: boolean,
 *   citations: { evidence: number, locator: { document: string, page: unknown, paragraph: unknown } }[],
 *   checks: { sentences: number, supported: number, flaggedRatio: number, warning: boolean,
 *     droppedCitations: number, marks: object[], model: string | null, promptVersion: string,
 *     usage: { inputTokens: number, outputTokens: number } | null,
 *     timings: { rewriting: number, retrieving: number, answering: number, checking: number } },
 *   evidenceBlocks: object[], retrievedIds: string[] }>}
 */
export async function runQuery({ question, provider, db, signal, onToken, onStage, onEvidence }) {
  if (!db) throw new Error("runQuery needs a database");
  const timings = {};
  let stageStart = performance.now();
  const endStage = (name) => {
    const now = performance.now();
    timings[name] = now - stageStart;
    stageStart = now;
  };
  onStage?.("rewriting");
  endStage("rewriting");
  onStage?.("retrieving");
  const { fused } = await retrieve({ question, provider, db, signal });
  const hitIds = fused.slice(0, MAX_HITS).map((f) => f.id);
  const rows = await loadChunks(db, hitIds);
  for (const [id, r] of await loadChunks(db, neighbourIds([...rows.values()], rows))) {
    rows.set(id, r);
  }
  signal?.throwIfAborted();
  const built = buildEvidence(hitIds, rows);
  const evidenceBlocks = withDocuments(
    built,
    await loadDocuments(
      db,
      built.map((b) => b.documentId),
    ),
  );
  onEvidence?.(evidenceBlocks);
  endStage("retrieving");

  onStage?.("answering");
  let answer;
  let model = null;
  let usage = null;
  if (evidenceBlocks.length === 0) {
    answer = NO_EVIDENCE_ANSWER;
    onToken?.(answer);
  } else {
    const result = await provider.chat({
      messages: answerMessages(question, evidenceBlocks),
      signal,
      temperature: 0,
      promptVersion: PROMPT_VERSION,
      onToken,
    });
    answer = result.text;
    model = result.model;
    usage = result.usage ?? null;
  }
  signal?.throwIfAborted();
  endStage("answering");

  onStage?.("checking");
  const abstained = isAbstention(answer, evidenceBlocks);
  const scored = checkAnswer(answer, evidenceBlocks);
  const citations = abstained ? [] : scored.citations;
  const checks = abstained
    ? {
        ...scored.checks,
        abstained: true,
        sentences: 0,
        supported: 0,
        flaggedRatio: 0,
        warning: false,
        droppedCitations: 0,
        marks: [],
      }
    : scored.checks;
  endStage("checking");
  return {
    answer,
    abstained,
    citations,
    checks: { ...checks, model, promptVersion: PROMPT_VERSION, usage, timings },
    evidenceBlocks,
    retrievedIds: fused.map((f) => f.id),
  };
}
