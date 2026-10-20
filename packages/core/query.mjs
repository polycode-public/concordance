// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The query pipeline: hybrid retrieval, fusion, expansion, a closed-world answer with tools
// over the store, the citation check, and the map from [En] to the locator stored at ingest.
import { citationTags, markUnsupported } from "./checks/citations.mjs";
import { ABSTAIN_PHRASE, PROMPT_VERSION, answerMessages, toolResultText } from "./prompt.mjs";
import { retrieveEvidence } from "./retrieval/evidence.mjs";
import { buildTools } from "./tools/index.mjs";

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
 * The turn's evidence blocks: the retrieved blocks, then each tool's new blocks under the next
 * numbers. A chunk that already has a block keeps its number.
 * @param {{ evidence: number, chunkId: string }[]} retrieved
 */
export function evidenceRegistry(retrieved) {
  const blocks = [...retrieved];
  const numbers = new Map(retrieved.map((b) => [b.chunkId, b.evidence]));
  return {
    blocks,
    /**
     * Numbers a tool's blocks and returns the number of each chunk id and the blocks it named.
     * @param {{ chunkId: string }[]} evidence
     */
    add(evidence) {
      const named = [];
      for (const block of evidence) {
        let n = numbers.get(block.chunkId);
        if (n === undefined) {
          n = blocks.length + 1;
          numbers.set(block.chunkId, n);
          blocks.push({ ...block, evidence: n });
        }
        named.push(blocks[n - 1]);
      }
      return { numbers, named: [...new Set(named)].sort((x, y) => x.evidence - y.evidence) };
    },
  };
}

/**
 * A tool's rows as the model reads them: every chunk id becomes the evidence number that
 * holds it, and no locator is left.
 * @param {unknown} value
 * @param {Map<string, number>} numbers
 */
export function citeRows(value, numbers) {
  if (Array.isArray(value)) return value.map((v) => citeRows(v, numbers));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "locator") continue;
    if (key === "chunkId") {
      const n = numbers.get(item);
      if (n === undefined) throw new Error(`a tool row names chunk ${item} with no evidence block`);
      out.evidence = `E${n}`;
    } else {
      out[key] = citeRows(item, numbers);
    }
  }
  return out;
}

/**
 * The store tools as the provider runs them: each result's blocks join the registry, its rows
 * name them by number, and onTool hears the tool's name and row count.
 * @param {import('./tools/index.mjs').StoreTool[]} tools
 * @param {ReturnType<typeof evidenceRegistry>} registry
 * @param {(call: { name: string, rows: number, added: boolean }) => void} onTool
 * @returns {import('./providers/toolLoop.mjs').ChatTool[]}
 */
export function chatTools(tools, registry, onTool) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async run(input) {
      const { rows, evidence, ...fields } = await tool.run(input);
      const before = registry.blocks.length;
      const { numbers, named } = registry.add(evidence);
      onTool({ name: tool.name, rows: rows.length, added: registry.blocks.length > before });
      return {
        content: toolResultText({ rows: citeRows(rows, numbers), ...fields }, named),
        rows: rows.length,
      };
    },
  }));
}

/**
 * Runs one question through the pipeline.
 * @param {object} args
 * @param {string} args.question
 * @param {string} args.corpus the corpus the evidence comes from
 * @param {import('./providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {{ query: Function }} args.db
 * @param {AbortSignal} [args.signal]
 * @param {(text: string) => void} [args.onToken]
 * @param {(stage: 'rewriting' | 'retrieving' | 'answering' | 'checking' | 'tool',
 *   tool?: { name: string, rows: number }) => void} [args.onStage]
 *   A tool call during the answer comes as the stage 'tool' with its name and row count.
 * @param {(blocks: object[]) => void} [args.onEvidence]
 *   Hears the retrieved blocks, then the whole list again each time a tool adds blocks.
 * @returns {Promise<{ answer: string, abstained: boolean,
 *   citations: { evidence: number, locator: { document: string, page: unknown, paragraph: unknown } }[],
 *   checks: { sentences: number, supported: number, flaggedRatio: number, warning: boolean,
 *     droppedCitations: number, marks: object[], model: string | null, promptVersion: string,
 *     usage: { inputTokens: number, outputTokens: number } | null,
 *     tools: { name: string, input: object, rows: number, ms: number }[],
 *     timings: { rewriting: number, retrieving: number, answering: number, checking: number } },
 *   evidenceBlocks: object[], retrievedIds: string[] }>}
 */
export async function runQuery({
  question,
  corpus,
  provider,
  db,
  signal,
  onToken,
  onStage,
  onEvidence,
}) {
  if (!db) throw new Error("runQuery needs a database");
  if (!corpus) throw new Error("runQuery needs a corpus");
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
  const { fused, blocks: retrieved } = await retrieveEvidence({
    question,
    corpus,
    provider,
    db,
    signal,
  });
  onEvidence?.(retrieved);
  endStage("retrieving");

  onStage?.("answering");
  const registry = evidenceRegistry(retrieved);
  let answer;
  let model = null;
  let usage = null;
  let toolCalls = [];
  if (retrieved.length === 0) {
    answer = NO_EVIDENCE_ANSWER;
    onToken?.(answer);
  } else {
    const tools = chatTools(
      buildTools({ db, corpus, provider, signal }),
      registry,
      ({ name, rows, added }) => {
        onStage?.("tool", { name, rows });
        if (added) onEvidence?.(registry.blocks);
      },
    );
    const result = await provider.chat({
      messages: answerMessages(question, retrieved),
      signal,
      temperature: 0,
      promptVersion: PROMPT_VERSION,
      onToken,
      tools,
    });
    answer = result.text;
    model = result.model;
    usage = result.usage ?? null;
    toolCalls = result.toolCalls ?? [];
  }
  const evidenceBlocks = registry.blocks;
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
    checks: { ...checks, model, promptVersion: PROMPT_VERSION, usage, tools: toolCalls, timings },
    evidenceBlocks,
    retrievedIds: fused.map((f) => f.id),
  };
}
