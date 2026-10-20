// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One comparison run over a corpus: alignment and labelling of its assertions, started by hand
// or by a state machine with { corpus }. A run that reaches its deadline returns "partial"; the
// next invocation with the same input resumes it, and one over a complete run returns "skipped"
// and writes nothing.

import { runComparison } from "../core/facts/compare.mjs";
import { corpusInfo } from "../core/ingest/run.mjs";

/** The time kept back after the last model call starts, so its labels are written in time. */
export const WRITE_MARGIN_MS = 90_000;

/**
 * @param {{ providerFor: () => Promise<object> | object, openDb: () => Promise<object> | object,
 *   now?: () => number, log?: (line: string) => void }} deps
 */
export function createHandler({ providerFor, openDb, now = Date.now, log = console.log }) {
  return async (event, context) => {
    const started = now();
    const corpus = event?.corpus;
    corpusInfo(corpus);
    const remaining = context?.getRemainingTimeInMillis?.();
    const deadline = remaining === undefined ? Infinity : started + remaining - WRITE_MARGIN_MS;
    const signal =
      remaining === undefined
        ? undefined
        : AbortSignal.timeout(Math.max(remaining - WRITE_MARGIN_MS / 3, 0));
    const provider = await providerFor();
    const db = await openDb();
    try {
      const { status, runId, counts } = await runComparison({
        corpus,
        db,
        provider,
        deadline,
        signal,
        log,
        now,
      });
      log(JSON.stringify({ corpus, status, runId, ...counts, ms: now() - started }));
      return { corpus, status, runId, counts };
    } finally {
      await db.close();
    }
  };
}

export const handler = createHandler({
  providerFor: async () => (await import("../core/providers/index.mjs")).providerFromEnv(),
  openDb: async () => (await import("../core/db.mjs")).openDbFromEnv(),
});
