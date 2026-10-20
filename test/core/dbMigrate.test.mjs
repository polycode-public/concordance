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

  it("splits 0002_session_frames.sql into its statements and names the view", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0002_session_frames.sql"), "utf8");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(
      /ALTER TABLE session_turns ADD COLUMN frames jsonb NOT NULL DEFAULT '\[\]'::jsonb$/,
    );
    expect(statements[1]).toMatch(/ALTER COLUMN model_id DROP NOT NULL$/);
    expect(statements[2]).toMatch(/^(--[^\n]*\n)*CREATE VIEW conversations AS/);
    for (const column of ["AS session_id", "t.thread", "AS first_question", "AS last_turn_at"])
      expect(statements[2]).toContain(column);
    expect(statements[2]).toContain("AS turn_count");
  });

  it("splits 0003_fact_registers.sql into the pairing table, the name indexes and the cascades", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0003_fact_registers.sql"), "utf8");
    const statements = splitStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)*\s*/, ""));
    expect(statements).toHaveLength(10);
    const pairs = statements[0];
    expect(pairs).toMatch(/^CREATE TABLE identity_revealing_pairs \(/);
    for (const column of [
      "document_a  text NOT NULL",
      "document_b  text NOT NULL",
      "reason      text NOT NULL",
      "marked_by   text NOT NULL",
    ])
      expect(pairs).toContain(column);
    expect(pairs).toContain("PRIMARY KEY (document_a, document_b)");
    expect(pairs).toContain("CHECK (document_a < document_b)");
    expect(pairs).not.toMatch(/REFERENCES/);
    expect(statements.slice(1, 4)).toEqual([
      "CREATE UNIQUE INDEX entities_kind_canonical_idx ON entities (kind, lower(canonical))",
      "CREATE UNIQUE INDEX events_name_idx ON events (lower(name))",
      "CREATE INDEX assertions_source_chunk_idx ON assertions (source_chunk_id)",
    ]);
    const cascades = statements.slice(4).join("\n");
    for (const [table, column, target] of [
      ["assertions", "source_chunk_id", "chunks"],
      ["assertion_comparisons", "assertion_a", "assertions"],
      ["assertion_comparisons", "assertion_b", "assertions"],
    ]) {
      expect(cascades).toContain(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_${column}_fkey`);
      expect(cascades).toMatch(
        new RegExp(`FOREIGN KEY \\(${column}\\) REFERENCES ${target} \\(id\\) ON DELETE CASCADE`),
      );
    }
    expect(sql).not.toMatch(/accepted_facts\s+(DROP|ADD)/);
  });

  it("splits 0004_reports.sql into the reports table, unique per user, filename and version", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0004_reports.sql"), "utf8");
    const statements = splitStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)*\s*/, ""));
    expect(statements).toHaveLength(1);
    const [reports] = statements;
    expect(reports).toMatch(/^CREATE TABLE reports \(/);
    for (const column of [
      "id              bigserial PRIMARY KEY",
      "session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE",
      "user_id         text NOT NULL",
      "filename        text NOT NULL",
      "version         int NOT NULL",
      "title           text NOT NULL",
      "topic           text NOT NULL",
      "document_ids    text[] NOT NULL DEFAULT '{}'",
      "body_markdown   text NOT NULL",
      "citations       jsonb NOT NULL DEFAULT '[]'",
      "checks          jsonb NOT NULL DEFAULT '{}'",
      "prompt_version  text NOT NULL",
      "model_id        text",
      "created_at      timestamptz NOT NULL DEFAULT now()",
    ])
      expect(reports).toContain(column);
    expect(reports).toContain("UNIQUE (user_id, filename, version)");
    expect(reports).toContain("UNIQUE (session_id, filename, version)");
    expect(reports).toContain("CHECK (filename ~ '^[a-z0-9][a-z0-9-]*\\.md$')");
  });

  it("splits 0006_extraction_progress.sql into one table keyed by document", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0006_extraction_progress.sql"), "utf8");
    const statements = splitStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)*\s*/, ""));
    expect(statements).toHaveLength(1);
    const [progress] = statements;
    expect(progress).toMatch(/^CREATE TABLE extraction_progress \(/);
    for (const column of [
      "document_id     text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE",
      "source_sha256   char(64) NOT NULL",
      "window_size     int NOT NULL",
      "windows_done    int NOT NULL",
    ])
      expect(progress).toContain(column);
  });

  it("splits 0007_assertion_subjects.sql into one change that adds the subject columns", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0007_assertion_subjects.sql"), "utf8");
    const statements = splitStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)*\s*/, ""));
    expect(statements).toHaveLength(1);
    const [alter] = statements;
    expect(alter).toMatch(/^ALTER TABLE assertions/);
    for (const part of [
      "ADD COLUMN subject_text  text,",
      "ADD COLUMN subject_kind  text CHECK (subject_kind IN ('witness', 'person', 'group', 'thing'))",
      "CHECK ((subject_text IS NULL) = (subject_kind IS NULL))",
    ])
      expect(alter).toContain(part);
  });

  it("splits 0008_accepted_fact_sources.sql into one change that detaches a fact from its source on delete", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0008_accepted_fact_sources.sql"), "utf8");
    const statements = splitStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)*\s*/, ""));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE accepted_facts/);
    expect(statements[0]).toContain("DROP CONSTRAINT accepted_facts_assertion_id_fkey");
    expect(statements[0]).toContain("REFERENCES assertions (id) ON DELETE SET NULL");
  });

  it("splits 0005_comparisons.sql into the run table, the comparison columns and the indexes", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0005_comparisons.sql"), "utf8");
    const statements = splitStatements(sql).map((s) => s.replace(/^(\s*--[^\n]*\n)*\s*/, ""));
    expect(statements).toHaveLength(9);
    const [runs, alter, unique] = statements;
    expect(runs).toMatch(/^CREATE TABLE comparison_runs \(/);
    expect(runs).toContain("UNIQUE (corpus, pipeline_version, input_sha256, model)");
    expect(runs).toContain("CHECK (status IN ('running', 'partial', 'complete'))");
    expect(alter).toMatch(/^ALTER TABLE assertion_comparisons/);
    for (const column of [
      "run_id            bigint REFERENCES comparison_runs (id) ON DELETE CASCADE",
      "accepted_fact_id  bigint REFERENCES accepted_facts (id) ON DELETE CASCADE",
      "event_id          bigint REFERENCES events (id) ON DELETE SET NULL",
      "decided_by        text",
      "overrides         bigint REFERENCES assertion_comparisons (id) ON DELETE CASCADE",
    ])
      expect(alter).toContain(column);
    expect(alter).toContain(
      "CHECK ((model = 'operator') = (decided_by IS NOT NULL AND run_id IS NULL))",
    );
    expect(alter).toContain("CHECK ((kind = 'accepted') = (accepted_fact_id IS NOT NULL))");
    expect(unique).toMatch(/^CREATE UNIQUE INDEX assertion_comparisons_run_pair_idx/);
    expect(unique).toMatch(/WHERE run_id IS NOT NULL$/);
    expect(statements.slice(3).every((s) => s.startsWith("CREATE INDEX "))).toBe(true);
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
