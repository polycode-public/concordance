// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Applies db/migrations/*.sql in filename order. Each file runs in its own
// transaction and is recorded in schema_migrations; applied files are skipped.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DEFAULT_URL = "postgres://concordance:concordance@localhost:5432/concordance";
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "..", "db", "migrations");

/**
 * Applies pending migrations on a connected client.
 * @param {pg.Client} client
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<string[]>} the files applied by this run
 */
export async function migrate(client, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = [];
  for (const file of files) {
    if (applied.has(file)) {
      log(`skip    ${file}`);
      continue;
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    }
    log(`applied ${file}`);
    done.push(file);
  }
  return done;
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL || DEFAULT_URL });
  await client.connect();
  try {
    await migrate(client);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
