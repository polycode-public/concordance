// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Applies db/migrations/*.sql in filename order. Each file runs in its own
// transaction and is recorded in schema_migrations; applied files are skipped.
// A file runs statement by statement, because the RDS Data API runs one statement per call.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DEFAULT_URL = "postgres://concordance:concordance@localhost:5432/concordance";
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "..", "db", "migrations");

/**
 * Splits a SQL script into statements on `;`. A `;` inside a single-quoted string (with
 * `E'...'` backslash escapes), a double-quoted identifier, a dollar-quoted body, a `--`
 * comment or a block comment does not split. Statements that hold only comments and
 * whitespace are dropped.
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let hasCode = false;
  let i = 0;
  const push = (end) => {
    if (hasCode) statements.push(sql.slice(start, end).trim());
    start = end + 1;
    hasCode = false;
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        const pair = sql.slice(i, i + 2);
        if (pair === "/*" || pair === "*/") {
          depth += pair === "/*" ? 1 : -1;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw new Error("unterminated block comment");
      continue;
    }
    hasCode ||= !/\s/.test(ch) && ch !== ";";
    if (ch === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      i++;
      for (;;) {
        if (i >= sql.length) throw new Error("unterminated string literal");
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) throw new Error("unterminated quoted identifier");
      i = end + 1;
      continue;
    }
    if (ch === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated dollar-quoted body ${tag}`);
        i = end + tag.length;
        continue;
      }
    }
    if (ch === ";") push(i);
    i++;
  }
  push(sql.length);
  return statements;
}

/**
 * Applies pending migrations on a connected client.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: object[] }> }} client
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
      for (const statement of splitStatements(sql)) await client.query(statement);
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
