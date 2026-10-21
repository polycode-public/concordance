// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Writes the witness aliases that the ingest gives each witness of one corpus, from the
// committed manifest and sources.json. The ingest skips a document that it already holds, so
// a witness ingested before its sources entry named it has no aliases until this runs.
// Default is a dry run that prints the rows; --apply merges them into the store that the
// environment names (DB_RESOURCE_ARN for the Data API, DATABASE_URL for Postgres).
// Usage: node scripts/backfill-aliases.mjs --corpus=grenfell [--root=<dir>] [--apply]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  WITNESS_UPSERT_SQL,
  corpusInfo,
  documentMeta,
  readManifest,
  readSources,
  witnessRow,
  witnessUpsertParams,
} from "../packages/core/ingest/run.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One witnesses row for each witness that has a document in the manifest, in id order. The
 * rows merge as the ingest merges them: a witness with one cipher-only document has no
 * aliases; the role is the role of its last document.
 * @param {string} corpus
 * @param {object[]} manifest  the manifest rows
 * @param {Map<string, object>} sources  the sources entries by evidence id
 * @returns {{ id: string, role: string | null, cipherOnly: boolean, aliases: string[] }[]}
 */
export function witnessAliasRows(corpus, manifest, sources) {
  const byId = new Map();
  for (const row of manifest) {
    const next = witnessRow(documentMeta(corpus, row, sources.get(row.evidence_id)));
    const prev = byId.get(next.id);
    const cipherOnly = next.cipherOnly || (prev?.cipherOnly ?? false);
    const aliases = cipherOnly ? [] : [...new Set([...(prev?.aliases ?? []), ...next.aliases])];
    byId.set(next.id, { ...next, cipherOnly, aliases: aliases.sort() });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv) {
    const eq = /^--(corpus|root)=(.+)$/.exec(arg);
    if (eq) args[eq[1]] = eq[2];
    else if (arg === "--apply") args.apply = true;
    else {
      throw new Error(
        `unknown argument ${arg}; usage: backfill-aliases.mjs --corpus=<name> [--root=<dir>] [--apply]`,
      );
    }
  }
  if (!args.corpus) throw new Error("--corpus is required");
  return args;
}

async function openStore(env) {
  const { openDbFromEnv } = await import("../packages/core/db.mjs");
  return openDbFromEnv(env);
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>,
 *   log?: (line: string) => void, openDb?: typeof openStore }} [options]
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  openDb = openStore,
} = {}) {
  const { corpus, root = path.join(REPO_ROOT, "corpora"), apply } = parseArgs(argv);
  corpusInfo(corpus);
  const corpusDir = path.join(root, corpus);
  const manifest = await readManifest(path.join(corpusDir, "manifest.jsonl"));
  const sources = await readSources(path.join(corpusDir, "sources.json"));
  const rows = witnessAliasRows(corpus, manifest, sources);
  for (const row of rows) log(`${row.id}: ${row.aliases.join(", ")}`);
  const named = rows.filter((r) => r.aliases.length).length;
  log(`${rows.length} witnesses, ${named} with aliases`);
  if (!apply) {
    log("dry run; --apply writes these rows");
    return;
  }
  const db = await openDb(env);
  try {
    for (const row of rows) await db.query(WITNESS_UPSERT_SQL, witnessUpsertParams(row));
  } finally {
    await db.close();
  }
  log(`applied ${rows.length} witnesses`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exitCode = 1;
  });
}
