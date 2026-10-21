// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The query rewrite: a follow-up question and the earlier turns of its thread become one to three
// standalone search queries.
import { InvalidReplyError, parseJsonReply } from "../providers/jsonReply.mjs";
import { MAX_REWRITES, REWRITE_PROMPT_VERSION, rewriteMessages } from "../prompt.mjs";

/** The turns of a thread that the rewrite reads. */
export const REWRITE_TURNS = 3;

const MAX_QUERY_CHARS = 500;

/**
 * The search queries of a question. A question with no earlier turn is its own query and costs no
 * model call; otherwise the chat model writes the queries at temperature 0.
 * @param {{ question: string, history?: { question: string, answer: string }[],
 *   provider: import('../providers/modelProvider.mjs').ModelProvider, signal?: AbortSignal }} args
 * @returns {Promise<{ queries: string[], rewrites: string[],
 *   usage: { inputTokens: number, outputTokens: number } | null }>}
 *   `rewrites` is empty when no rewrite ran.
 */
export async function rewriteQueries({ question, history = [], provider, signal }) {
  const turns = history.slice(-REWRITE_TURNS);
  if (!turns.length) return { queries: [question], rewrites: [], usage: null };
  const result = await provider.chat({
    messages: rewriteMessages(question, turns),
    signal,
    temperature: 0,
    promptVersion: REWRITE_PROMPT_VERSION,
  });
  const model = result.model ?? provider.name;
  const reply = parseJsonReply(result.text, model);
  const queries = Array.isArray(reply?.queries)
    ? [...new Set(reply.queries.map((q) => (typeof q === "string" ? q.trim() : "")))]
    : [];
  if (
    !queries.length ||
    queries.length > MAX_REWRITES ||
    queries.some((q) => !q || q.length > MAX_QUERY_CHARS)
  ) {
    throw new InvalidReplyError(
      `${model} returned no list of 1 to ${MAX_REWRITES} queries of at most ${MAX_QUERY_CHARS} characters: ${result.text.slice(0, 200)}`,
    );
  }
  return { queries, rewrites: queries, usage: result.usage ?? null };
}
