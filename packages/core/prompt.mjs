// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The closed-world answer prompt. The server and the eval send the same text, and
// every response stores PROMPT_VERSION.

export const PROMPT_VERSION = "answer-closed-world-v3";

export const SYSTEM_PROMPT = [
  "You answer questions about a corpus of witness statements.",
  "Answer only from the evidence blocks you are given.",
  "If the evidence blocks do not cover the question, say 'the corpus does not say'.",
  "Never use prior knowledge about the real event.",
  "Write [En] after every sentence that relies on evidence, where n is the number of the evidence block.",
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
