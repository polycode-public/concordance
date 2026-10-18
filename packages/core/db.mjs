// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://concordance:concordance@localhost:5432/concordance";

/**
 * Creates a connection pool. The pool connects on the first query.
 * @param {string} [connectionString]
 */
export function createDb(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  return {
    pool,
    /** @param {string} text @param {unknown[]} [params] */
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}
