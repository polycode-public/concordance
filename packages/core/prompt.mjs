// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The closed-world answer prompt. The server and the eval send the same text, and
// every response stores PROMPT_VERSION.
import { TAG } from "./checks/citations.mjs";

export const PROMPT_VERSION = "answer-closed-world-v5";

export const SYSTEM_PROMPT = [
  "You answer questions about a corpus of witness statements.",
  "Answer only from the evidence blocks you are given.",
  "If the evidence blocks and the tool rows do not cover the question, answer with the one sentence 'the corpus does not say' and write nothing else: no explanation, no offer, no description of the corpus.",
  "Never use prior knowledge about the real event.",
  "Answer only what the question asks: leave out what happened before or after the moments it names, and add no background.",
  "A figure answers the question only when the evidence says it is the figure of the thing the question names.",
  "Write [En] after every sentence that relies on evidence, where n is the number of the evidence block.",
  "Cite the block whose own text states the fact of the sentence; cite a second block only when the sentence states a fact of that block too, and never cite a block for its context.",
  "Put one number in each bracket and write [E3][E4], never [E3, E4].",
  "Write short paragraphs and '-' bullets only; use no headings or tables, and end every bullet with a full stop and its [En] tag.",
  "You may call tools that compute over the stored statements: counts, one witness's claims, a time window, the comparisons between two witnesses, contradictions that several witnesses support, document facts, a search and the system's own usage.",
  "Call every tool you need before you write any text.",
  "A tool result gives rows and new evidence blocks; a row names its evidence as E followed by a number, and you cite it as [En] like any other evidence block.",
  "A tool row records what a statement says, never a fact about the event, and a count is a count of stored statements.",
].join(" ");

export const ABSTAIN_PHRASE = "the corpus does not say";

/**
 * Formats evidence blocks for the prompt as [E1] ... [En].
 * @param {{ header?: string | null, text: string }[]} blocks
 */
export function evidencePrompt(blocks) {
  if (!blocks.length) return "Evidence blocks: none.";
  return blocks.map((b, i) => `[E${i + 1}] ${b.header ?? ""}\n${b.text}`).join("\n\n");
}

/**
 * The text a tool result gives the model: its rows and fields as JSON, then the evidence blocks
 * they name under their own numbers.
 * @param {object} result  the rows, each naming its evidence as "En", and the tool's other fields
 * @param {{ evidence: number, header?: string | null, text: string }[]} blocks
 */
export function toolResultText(result, blocks) {
  const evidence = blocks.length
    ? blocks.map((b) => `[E${b.evidence}] ${b.header ?? ""}\n${b.text}`).join("\n\n")
    : "Evidence blocks: none.";
  return `${JSON.stringify(result)}\n\n${evidence}`;
}

/**
 * The chat messages for one question over a set of evidence blocks.
 * @param {string} question
 * @param {{ header?: string | null, text: string }[]} blocks
 */
export function answerMessages(question, blocks) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${evidencePrompt(blocks)}\n\nQuestion: ${question}` },
  ];
}

export const REWRITE_PROMPT_VERSION = "rewrite-standalone-v1";

/** The most search queries one rewrite returns. */
export const MAX_REWRITES = 3;

/** The characters of an earlier answer that the rewrite reads. */
export const REWRITE_ANSWER_CHARS = 1200;

export const REWRITE_SYSTEM_PROMPT = [
  "You turn the last question of a conversation about witness statements into search queries for a search over those statements.",
  "Each query must stand alone: replace every pronoun and every reference to an earlier turn with the witness id, name, place, time or thing it means.",
  `Write one query when the question asks one thing, and at most ${MAX_REWRITES} when it asks several things.`,
  "Keep every phrase in double quotes, every witness id and every name exactly as written.",
  "Use only words from the conversation and add nothing from prior knowledge.",
  'Answer with exactly one JSON object of the form {"queries": ["..."]} and nothing else.',
].join(" ");

/**
 * The chat messages that ask for the standalone search queries of a question, given the earlier
 * turns of its thread, oldest first. The [En] tags of an earlier answer are removed.
 * @param {string} question
 * @param {{ question: string, answer: string }[]} history
 */
export function rewriteMessages(question, history) {
  const turns = history.map((turn, i) => {
    const answer = turn.answer
      .replace(new RegExp(String.raw`\s*${TAG.source}`, "g"), "")
      .replace(/\s+/g, " ")
      .trim();
    return `Turn ${i + 1} question: ${turn.question}\nTurn ${i + 1} answer: ${answer.slice(0, REWRITE_ANSWER_CHARS)}`;
  });
  return [
    { role: "system", content: REWRITE_SYSTEM_PROMPT },
    { role: "user", content: `${turns.join("\n\n")}\n\nLast question: ${question}` },
  ];
}

export const RERANK_PROMPT_VERSION = "rerank-relevance-v1";

/** The characters of one passage that the reranker reads. */
export const RERANK_PASSAGE_CHARS = 1500;

/**
 * The prompt that asks the extraction model to score each passage against the question.
 * @param {string} question
 * @param {{ header?: string | null, text: string }[]} passages
 */
export function rerankPrompt(question, passages) {
  const listed = passages
    .map((p, i) => `[P${i + 1}] ${p.header ?? ""}\n${p.text.slice(0, RERANK_PASSAGE_CHARS)}`)
    .join("\n\n");
  return [
    "You score how well each passage from a witness statement answers a question.",
    "Judge only from the passage text and use no prior knowledge.",
    "Score 3 when the passage answers the question directly, 2 when it holds part of the answer, 1 when it is on the topic and does not answer, and 0 when it is not relevant.",
    `Give every passage from P1 to P${passages.length} one score, as {"scores": [{"passage": 1, "score": 3}, ...]}.`,
    "",
    `Question: ${question}`,
    "",
    listed,
  ].join("\n");
}
