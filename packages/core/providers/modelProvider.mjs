// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The model provider interface. Every model call in the system goes through an
// object of this shape, so the laptop (Ollama) and AWS (Bedrock) paths differ
// only in which factory MODEL_PROVIDER selects.

/**
 * @typedef {object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {object} ChatResult
 * @property {string} text           The full answer text.
 * @property {string} model          The model id that produced it.
 * @property {string} promptVersion  The prompt version the caller passed, or 'unversioned'.
 */

/**
 * @typedef {object} ModelProvider
 * @property {string} name        Provider name, for example 'laptop' or 'bedrock'.
 * @property {string} embedModel  Embedding model id stored in every chunk row.
 * @property {number} embedDim    Embedding dimension stored in every chunk row.
 * @property {(texts: string[]) => Promise<number[][]>} embed
 *   Returns one vector per input text, in input order.
 * @property {(args: {
 *   messages: ChatMessage[],
 *   signal?: AbortSignal,
 *   temperature?: number,
 *   onToken?: (text: string) => void,
 *   promptVersion?: string,
 * }) => Promise<ChatResult>} chat
 *   Streams the answer. Calls onToken for each piece of text as it arrives.
 *   Temperature defaults to 0. An aborted signal stops the stream and rejects
 *   with an AbortError.
 * @property {(args: { prompt: string, schema?: object, signal?: AbortSignal }) => Promise<object>} extractJson
 *   Returns one JSON object from the extraction model.
 */

/** Names every provider must expose. */
export const PROVIDER_METHODS = Object.freeze(["embed", "chat", "extractJson"]);

/**
 * Throws when an object does not have the provider shape.
 * @param {ModelProvider} provider
 * @returns {ModelProvider}
 */
export function assertProvider(provider) {
  if (!provider || typeof provider.name !== "string") {
    throw new TypeError("provider must have a string name");
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new TypeError(`provider ${provider.name} is missing ${method}()`);
    }
  }
  return provider;
}
