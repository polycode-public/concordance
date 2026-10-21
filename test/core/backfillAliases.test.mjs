// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WITNESS_UPSERT_SQL, parseSources } from "../../packages/core/ingest/run.mjs";
import { main, parseArgs, witnessAliasRows } from "../../scripts/backfill-aliases.mjs";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "backfill",
);

const manifestRow = (evidenceId) => ({
  url: `https://example.org/${evidenceId}.pdf`,
  sha256: "0".repeat(64),
  bytes: 1,
  fetched_at: "2026-01-01T00:00:00Z",
  licence: "OGL-3.0",
  evidence_id: evidenceId,
});

describe("witnessAliasRows", () => {
  it("gives the trimmed witness name as the alias", () => {
    const sources = parseSources(
      JSON.stringify([{ evidence_id: "D1", witness_id: "W1", witness: "  Ada Example \n" }]),
    );
    expect(witnessAliasRows("grenfell", [manifestRow("D1")], sources)).toEqual([
      { id: "W1", role: null, cipherOnly: false, aliases: ["Ada Example"] },
    ]);
  });

  it("gives a cipher-only witness no aliases, even when its entry holds a name", () => {
    const sources = parseSources(
      JSON.stringify([
        { evidence_id: "D1", witness_id: "C1", witness: "Cipher Person", cipher_only: true },
        { evidence_id: "D2", witness_id: "C1", witness: "Another Name" },
      ]),
    );
    const rows = witnessAliasRows("grenfell", [manifestRow("D1"), manifestRow("D2")], sources);
    expect(rows).toEqual([{ id: "C1", role: null, cipherOnly: true, aliases: [] }]);
  });

  it("merges the names of one witness's documents and keeps the last role", () => {
    const sources = parseSources(
      JSON.stringify([
        { evidence_id: "D1", witness_id: "W1", witness: "B Name", role: "resident", floor: 3 },
        { evidence_id: "D2", witness_id: "W1", witness: "A Name", role: "resident", floor: 4 },
        { evidence_id: "D3", witness_id: "W1", witness: "A Name" },
      ]),
    );
    const rows = witnessAliasRows(
      "grenfell",
      [manifestRow("D1"), manifestRow("D2"), manifestRow("D3")],
      sources,
    );
    expect(rows).toEqual([
      { id: "W1", role: null, cipherOnly: false, aliases: ["A Name", "B Name"] },
    ]);
  });

  it("uses the evidence id and no alias for a document with no sources entry", () => {
    expect(witnessAliasRows("grenfell", [manifestRow("D9")], new Map())).toEqual([
      { id: "D9", role: null, cipherOnly: false, aliases: [] },
    ]);
  });
});

describe("parseArgs", () => {
  it("needs a corpus and refuses an unknown argument", () => {
    expect(parseArgs(["--corpus=grenfell"])).toEqual({ corpus: "grenfell", apply: false });
    expect(parseArgs(["--corpus=grenfell", "--apply"]).apply).toBe(true);
    expect(() => parseArgs([])).toThrow(/--corpus is required/);
    expect(() => parseArgs(["--corpus=grenfell", "--force"])).toThrow(/unknown argument --force/);
  });
});

describe("main", () => {
  const argv = ["--corpus=grenfell", `--root=${fixtureRoot}`];

  it("prints one line per witness and the count, and opens no store on a dry run", async () => {
    const lines = [];
    await main({
      argv,
      env: {},
      log: (line) => lines.push(line),
      openDb: () => {
        throw new Error("a dry run opened the store");
      },
    });
    expect(lines).toEqual([
      "C1: ",
      "DOC4: ",
      "W1: A. Example, Ada Example",
      "3 witnesses, 1 with aliases",
      "dry run; --apply writes these rows",
    ]);
  });

  it("runs the ingest's witness merge once per witness on --apply, then closes the store", async () => {
    const calls = [];
    let closed = false;
    const db = {
      query: async (text, params) => calls.push({ text, params }),
      close: async () => {
        closed = true;
      },
    };
    await main({ argv: [...argv, "--apply"], env: {}, log: () => {}, openDb: async () => db });
    expect(calls.every((c) => c.text === WITNESS_UPSERT_SQL)).toBe(true);
    expect(calls.map((c) => c.params)).toEqual([
      ["C1", "firefighter", true, []],
      ["DOC4", null, false, []],
      ["W1", "resident, floor 4", false, ["A. Example", "Ada Example"]],
    ]);
    expect(closed).toBe(true);
  });
});
