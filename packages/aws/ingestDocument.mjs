// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// One Map item of the ingest state machine: one manifest row of one corpus, from the original
// PDF in the corpus bucket to its chunks in the store. A throw fails this item only. A run that
// reaches the margin before the context lines are done returns status "partial" with the lines
// it stored; the state machine invokes the item again until the status is not "partial".

import { createHash } from "node:crypto";
import {
  corpusInfo,
  documentMeta,
  ingestDocument,
  parseManifest,
  parseSources,
} from "../core/ingest/run.mjs";
import { pdfjsTool, pdfToPagesFromBuffer } from "../core/ingest/pdfText.mjs";
import { corpusObjects } from "./listManifest.mjs";

/** The time kept back from the model calls for the abstract, the embeddings and the write. */
export const FINISH_MARGIN_MS = 6 * 60_000;

/** The bucket key of a corpus document's original. */
export const originalKey = (corpus, evidenceId) => `${corpus}/raw/${evidenceId}.pdf`;

/**
 * @param {{ s3GetObject: (key: string) => Promise<Uint8Array | null>,
 *   providerFor: () => Promise<object> | object, openDb: () => Promise<object> | object,
 *   extractPages: (bytes: Uint8Array) => Promise<{ page: number, text: string }[]>,
 *   textTool: () => Promise<{ tool: string, version: string | null }>,
 *   now?: () => number, log?: (line: string) => void }} deps
 */
export function createHandler({
  s3GetObject,
  providerFor,
  openDb,
  extractPages,
  textTool,
  now = Date.now,
  log = console.log,
}) {
  return async (event, context) => {
    const started = now();
    const corpus = event?.corpus;
    corpusInfo(corpus);
    const [row] = parseManifest(JSON.stringify(event?.row ?? null), "the Map item row");
    const key = originalKey(corpus, row.evidence_id);

    const bytes = await s3GetObject(key);
    if (!bytes) throw new Error(`${key} is not in the corpus bucket`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== row.sha256) {
      throw new Error(`${key} has sha256 ${sha256}; the manifest records ${row.sha256}`);
    }

    // A corpus without sources.json ingests with no role or statement date, as on the laptop.
    const sourcesKey = `${corpus}/sources.json`;
    const sourcesBytes = await s3GetObject(sourcesKey);
    const sources = sourcesBytes
      ? parseSources(new TextDecoder().decode(sourcesBytes), sourcesKey)
      : new Map();

    const remaining = context?.getRemainingTimeInMillis?.();
    const budget = remaining === undefined ? undefined : remaining - FINISH_MARGIN_MS;
    const signal =
      budget === undefined
        ? undefined
        : budget <= 0
          ? AbortSignal.abort()
          : AbortSignal.timeout(budget);
    const pages = await extractPages(bytes);
    const meta = documentMeta(corpus, row, sources.get(row.evidence_id));
    const provider = await providerFor();
    const db = await openDb();
    try {
      const { status, counts, contexts } = await ingestDocument({
        pages,
        meta,
        provider,
        db,
        textTool: await textTool(),
        signal,
        log,
      });
      log(JSON.stringify({ evidenceId: row.evidence_id, status, ms: now() - started }));
      return { evidenceId: row.evidence_id, status, counts, ...(contexts && { contexts }) };
    } finally {
      await db.close();
    }
  };
}

let objects;
export const handler = createHandler({
  s3GetObject: (key) => (objects ??= corpusObjects())(key),
  providerFor: async () => (await import("../core/providers/index.mjs")).providerFromEnv(),
  openDb: async () => (await import("../core/db.mjs")).openDbFromEnv(),
  extractPages: pdfToPagesFromBuffer,
  textTool: pdfjsTool,
});
