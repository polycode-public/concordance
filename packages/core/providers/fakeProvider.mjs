// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * A deterministic provider for tests. It streams fixed tokens with a delay per token and
 * honours the abort signal.
 * @param {{ tokens: string[], delayMs?: number }} options
 */
export function createFakeProvider({ tokens, delayMs = 20 }) {
  const calls = [];
  return {
    name: "fake",
    embedModel: "fake-embed",
    embedDim: 4,
    calls,
    async embed(texts) {
      return texts.map(() => [0, 0, 0, 1]);
    },
    async extractJson() {
      return {};
    },
    async chat({ messages, signal, onToken, promptVersion = "unversioned" }) {
      calls.push({ messages });
      let text = "";
      for (const token of tokens) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        signal?.throwIfAborted();
        text += token;
        onToken?.(token);
      }
      return { text, model: "fake-chat", promptVersion };
    },
  };
}
