// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHandler, originalKey } from "../../packages/aws/ingestDocument.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";

const PDF = new TextEncoder().encode("%PDF-1.4 statement bytes");
const ROW = {
  url: "https://example.test/IWS1.pdf",
  sha256: createHash("sha256").update(PDF).digest("hex"),
  bytes: PDF.length,
  fetched_at: "2026-10-18T12:00:00Z",
  licence: "OGL-3.0",
  evidence_id: "IWS1",
};
const PAGES = [{ page: 1, text: "1. I lived on floor 18. I lived alone.\n2. I woke at 01:00." }];
const SOURCES = JSON.stringify([
  { evidence_id: "IWS1", role: "resident", floor: 18, statement_date: "2019-08-06" },
]);

/** A database that answers the ingest's queries and records statements and closes. */
function fakeDb() {
  const statements = [];
  let nextId = 1;
  const query = async (text, params = []) => {
    statements.push({ text, params });
    if (/INSERT INTO chunks/.test(text)) {
      return { rows: params[5].map((ordinal) => ({ id: String(nextId++), ordinal })) };
    }
    return { rows: [] };
  };
  const db = {
    statements,
    closed: 0,
    query,
    pool: { connect: async () => ({ query, release: () => {} }) },
    close: async () => {
      db.closed++;
    },
  };
  return db;
}

function setup({ objects = {}, failExtract = false } = {}) {
  const reads = [];
  const extracted = [];
  const db = fakeDb();
  const store = {
    [originalKey("grenfell", "IWS1")]: PDF,
    "grenfell/sources.json": new TextEncoder().encode(SOURCES),
    ...objects,
  };
  const handler = createHandler({
    s3GetObject: async (key) => {
      reads.push(key);
      return store[key] ?? null;
    },
    providerFor: () =>
      createFakeProvider({
        tokens: [],
        extractJson: ({ schema }) =>
          schema.required[0] === "context" ? { context: "Context." } : { abstract: "Abstract." },
      }),
    openDb: () => db,
    extractPages: async (bytes) => {
      if (failExtract) throw new Error("bad PDF");
      extracted.push(bytes);
      return PAGES;
    },
    textTool: async () => ({ tool: "pdfjs-dist", version: "6.4.299" }),
    now: () => 0,
    log: () => {},
  });
  return { handler, reads, extracted, db };
}

describe("ingestDocument handler", () => {
  it("reads the original at <corpus>/raw/<evidence_id>.pdf", () => {
    expect(originalKey("grenfell", "IWS1")).toBe("grenfell/raw/IWS1.pdf");
  });

  it("ingests the extracted pages and closes the database", async () => {
    const { handler, reads, extracted, db } = setup();
    const result = await handler({ corpus: "grenfell", row: ROW });
    expect(result).toEqual({
      evidenceId: "IWS1",
      status: "ingested",
      counts: { document: 1, section: 2, passage: 2, sentence: 3 },
    });
    expect(reads).toEqual(["grenfell/raw/IWS1.pdf", "grenfell/sources.json"]);
    expect(extracted).toEqual([PDF]);
    expect(db.closed).toBe(1);
    const documentRow = db.statements.find((s) => /INSERT INTO documents/.test(s.text)).params;
    expect(documentRow).toContain("resident, floor 18");
    expect(documentRow).toContain("2019-08-06");
    const provenance = db.statements.find((s) => /INSERT INTO provenance/.test(s.text)).params;
    expect(provenance[3][0]).toBe("pdfjs-dist");
    expect(provenance[4][0]).toBe("6.4.299");
  });

  it("ingests without sources.json", async () => {
    const { handler, db } = setup({ objects: { "grenfell/sources.json": null } });
    await handler({ corpus: "grenfell", row: ROW });
    const documentRow = db.statements.find((s) => /INSERT INTO documents/.test(s.text)).params;
    expect(documentRow[7]).toBeNull();
  });

  it("throws on a SHA-256 that differs from the manifest, before any extraction", async () => {
    const { handler, extracted, db } = setup({
      objects: { "grenfell/raw/IWS1.pdf": new TextEncoder().encode("changed") },
    });
    await expect(handler({ corpus: "grenfell", row: ROW })).rejects.toThrow(
      /grenfell\/raw\/IWS1.pdf has sha256 [0-9a-f]{64}; the manifest records/,
    );
    expect(extracted).toEqual([]);
    expect(db.statements).toEqual([]);
  });

  it("throws when the original is absent", async () => {
    const { handler } = setup({ objects: { "grenfell/raw/IWS1.pdf": null } });
    await expect(handler({ corpus: "grenfell", row: ROW })).rejects.toThrow(
      "grenfell/raw/IWS1.pdf is not in the corpus bucket",
    );
  });

  it("throws on a malformed row or an unknown corpus", async () => {
    const { handler } = setup();
    await expect(handler({ corpus: "grenfell", row: { ...ROW, sha256: "x" } })).rejects.toThrow(
      /sha256 is missing or invalid/,
    );
    await expect(handler({ corpus: "nope", row: ROW })).rejects.toThrow(/unknown corpus nope/);
  });

  it("lets an extraction failure fail the item", async () => {
    const { handler } = setup({ failExtract: true });
    await expect(handler({ corpus: "grenfell", row: ROW })).rejects.toThrow("bad PDF");
  });
});
