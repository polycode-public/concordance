// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The closed-world answer prompt. The server and the eval send the same text, and
// every response stores PROMPT_VERSION.

export const PROMPT_VERSION = "answer-closed-world-v2";

export const SYSTEM_PROMPT = [
  "You answer questions about a corpus of witness statements.",
  "Answer only from the evidence blocks you are given.",
  "If the evidence blocks do not cover the question, say 'the corpus does not say'.",
  "Never use prior knowledge about the real event.",
  "Write [En] after every sentence that relies on evidence, where n is the number of the evidence block.",
  "Put one number in each bracket and write [E3][E4], never [E3, E4].",
  "Write short paragraphs and '-' bullets only; use no headings or tables, and end every bullet with a full stop and its [En] tag.",
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
