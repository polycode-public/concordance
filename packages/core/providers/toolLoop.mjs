// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The parts of the chat tool loop that every provider shares: the round cap, the call of one
// tool by name, the sum of the usage over the rounds and the text that joins two rounds.

/** The model may ask for tools in this many replies; the reply after them answers. */
export const MAX_TOOL_ROUNDS = 4;

/** The instruction added to the last tool results when the round cap is reached. */
export const LAST_ROUND_TEXT =
  "The tool limit is reached. Answer now from the evidence blocks you have, and call no tool.";

/** The text between the answer text of two replies. */
export const ROUND_SEPARATOR = "\n\n";

/**
 * @typedef {object} ChatTool
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema  A JSON schema of the input object.
 * @property {(input: object) => Promise<{ content: string, rows: number }>} run
 *   The text the model receives and the number of rows it holds.
 */

/**
 * Runs the tool that the model named. A name that no tool has, or a tool that throws, fails the
 * chat.
 * @param {ChatTool[]} tools
 * @param {string} name
 * @param {unknown} input
 * @returns {Promise<{ content: string, call: { name: string, input: object, rows: number, ms: number } }>}
 */
export async function runToolCall(tools, name, input) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`the model asked for ${JSON.stringify(name)}, which is not a tool`);
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const started = performance.now();
  const { content, rows } = await tool.run(args);
  return { content, call: { name, input: args, rows, ms: performance.now() - started } };
}

/** The sum of two usage records; null only when both are null. */
export function addUsage(total, usage) {
  if (!usage) return total;
  if (!total) return { ...usage };
  const sum = {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
  };
  for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
    if (field in total || field in usage) sum[field] = (total[field] ?? 0) + (usage[field] ?? 0);
  }
  return sum;
}

/**
 * Streams the answer text of every reply through one onToken, with ROUND_SEPARATOR between the
 * text of two replies.
 * @param {(text: string) => void} [onToken]
 */
export function answerStream(onToken) {
  let text = "";
  let roundHasText = false;
  return {
    startRound() {
      roundHasText = false;
    },
    push(piece) {
      if (!piece) return;
      if (!roundHasText && text) {
        text += ROUND_SEPARATOR;
        onToken?.(ROUND_SEPARATOR);
      }
      roundHasText = true;
      text += piece;
      onToken?.(piece);
    },
    get text() {
      return text;
    },
  };
}
