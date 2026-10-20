// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One Map item of the extraction pass of the ingest state machine: the sentence chunks of one
// ingested document into its assertions. A throw fails this item only. A run that reaches the
// write margin returns status "partial" with the windows it stored; the next execution of the
// state machine resumes the document.

import { extractAssertions } from "../core/facts/extract.mjs";
import { corpusInfo, parseManifest } from "../core/ingest/run.mjs";

/** The time kept back from the model calls so the window in hand can write before the timeout. */
export const WRITE_MARGIN_MS = 60_000;

/**
 * @param {{ providerFor: () => Promise<object> | object, openDb: () => Promise<object> | object,
 *   now?: () => number, log?: (line: string) => void }} deps
 */
export function createHandler({ providerFor, openDb, now = Date.now, log = console.log }) {
  return async (event, context) => {
    const started = now();
    corpusInfo(event?.corpus);
    const [row] = parseManifest(JSON.stringify(event?.row ?? null), "the Map item row");
    const remaining = context?.getRemainingTimeInMillis?.();
    const signal =
      remaining === undefined
        ? undefined
        : AbortSignal.timeout(Math.max(remaining - WRITE_MARGIN_MS, 0));
    const provider = await providerFor();
    const db = await openDb();
    try {
      const { status, counts, windows } = await extractAssertions({
        documentId: row.evidence_id,
        provider,
        db,
        signal,
        log,
        now,
      });
      log(
        JSON.stringify({
          evidenceId: row.evidence_id,
          status,
          ...counts,
          windowsDone: windows.done,
          windowsTotal: windows.total,
          ms: now() - started,
        }),
      );
      return { evidenceId: row.evidence_id, status, counts, windows };
    } finally {
      await db.close();
    }
  };
}

export const handler = createHandler({
  providerFor: async () => (await import("../core/providers/index.mjs")).providerFromEnv(),
  openDb: async () => (await import("../core/db.mjs")).openDbFromEnv(),
});
