// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  CorpusError,
  isCorpusId,
  knownCorpora,
  requireCorpusId,
  requireKnownCorpus,
} from "../../packages/core/corpora.mjs";

const store = (corpora) => ({
  calls: 0,
  async query(text) {
    this.calls++;
    expect(text).toBe("SELECT DISTINCT corpus FROM documents ORDER BY corpus");
    return { rows: corpora.map((corpus) => ({ corpus })) };
  },
});

describe("a corpus id", () => {
  it("is a short lower-case name that can be one key segment", () => {
    for (const id of ["grenfell", "ucpi", "a-1"]) expect(isCorpusId(id)).toBe(true);
    for (const id of ["", "Grenfell", "../raw", "a/b", "-x", "x".repeat(65), 3, null]) {
      expect(isCorpusId(id)).toBe(false);
    }
    expect(() => requireCorpusId(undefined)).toThrow(/needs a corpus/);
    expect(() => requireCorpusId("A")).toThrow(CorpusError);
    expect(requireCorpusId("ucpi")).toBe("ucpi");
  });

  it("is known when the store has a document in it", async () => {
    expect(await knownCorpora(store(["grenfell", "ucpi"]))).toEqual(["grenfell", "ucpi"]);
    expect(await requireKnownCorpus(store(["grenfell"]), "grenfell")).toBe("grenfell");
    await expect(requireKnownCorpus(store(["grenfell"]), "ucpi")).rejects.toThrow(
      /ucpi has no documents/,
    );
    const db = store(["grenfell"]);
    await expect(requireKnownCorpus(db, "../x")).rejects.toThrow(CorpusError);
    expect(db.calls).toBe(0);
  });
});
