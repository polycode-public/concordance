// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate, splitStatements } from "../../scripts/db-migrate.mjs";

describe("splitStatements", () => {
  it("splits 0001_initial.sql into its 24 statements", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0001_initial.sql"), "utf8");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(24);
    expect(statements[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS vector$/);
    expect(statements.find((s) => s.includes("COMMENT ON TABLE witnesses"))).toMatch(
      /is stored; for cipher_only/,
    );
    for (const s of statements) expect(s.endsWith(";")).toBe(false);
  });

  it("does not split on a ; inside a string literal or an identifier", () => {
    expect(splitStatements(`SELECT 'a;b', 'it''s; x', E'q\\'; r', "c;d"; SELECT 2`)).toEqual([
      `SELECT 'a;b', 'it''s; x', E'q\\'; r', "c;d"`,
      "SELECT 2",
    ]);
  });

  it("does not split on a ; inside a comment", () => {
    const sql = "SELECT 1 -- one; two\n; /* three; /* nested; */ four; */ SELECT 2;";
    expect(splitStatements(sql)).toEqual([
      "SELECT 1 -- one; two",
      "/* three; /* nested; */ four; */ SELECT 2",
    ]);
  });

  it("does not split inside a dollar-quoted body", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT $1";
    expect(splitStatements(sql)).toEqual([
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
      "SELECT $1",
    ]);
  });

  it("drops empty and comment-only statements", () => {
    expect(splitStatements(";; -- only a comment\n; /* and this */ ;\n")).toEqual([]);
  });

  it("throws on an unterminated string", () => {
    expect(() => splitStatements("SELECT 'open")).toThrow(/unterminated/);
  });
});

describe("migrate", () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "migrate-"));
    await writeFile(
      path.join(dir, "0001_a.sql"),
      "CREATE TABLE a (x int);\nCREATE INDEX a_x ON a (x);\n",
    );
    await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE b (y text DEFAULT ';');");
    await writeFile(path.join(dir, "notes.txt"), "not a migration");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeClient({ applied = [], failOn } = {}) {
    const calls = [];
    return {
      calls,
      query: async (text, params) => {
        calls.push(params ? [text, params] : [text]);
        if (failOn && text.includes(failOn)) throw new Error("boom");
        if (text.startsWith("SELECT filename"))
          return { rows: applied.map((filename) => ({ filename })) };
        return { rows: [] };
      },
    };
  }

  it("runs each file statement by statement in a transaction and records it", async () => {
    const client = fakeClient();
    const done = await migrate(client, { dir, log: () => {} });
    expect(done).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(client.calls.slice(2)).toEqual([
      ["BEGIN"],
      ["CREATE TABLE a (x int)"],
      ["CREATE INDEX a_x ON a (x)"],
      ["INSERT INTO schema_migrations (filename) VALUES ($1)", ["0001_a.sql"]],
      ["COMMIT"],
      ["BEGIN"],
      ["CREATE TABLE b (y text DEFAULT ';')"],
      ["INSERT INTO schema_migrations (filename) VALUES ($1)", ["0002_b.sql"]],
      ["COMMIT"],
    ]);
    expect(client.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/);
  });

  it("skips applied files", async () => {
    const client = fakeClient({ applied: ["0001_a.sql"] });
    expect(await migrate(client, { dir, log: () => {} })).toEqual(["0002_b.sql"]);
    expect(client.calls.some(([t]) => t.startsWith("CREATE TABLE a"))).toBe(false);
  });

  it("rolls back and throws when a statement fails", async () => {
    const client = fakeClient({ failOn: "CREATE INDEX" });
    await expect(migrate(client, { dir, log: () => {} })).rejects.toThrow(
      /migration 0001_a.sql failed: boom/,
    );
    expect(client.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(client.calls.some(([t]) => t.startsWith("INSERT INTO schema_migrations"))).toBe(false);
  });
});
