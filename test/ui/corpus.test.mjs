// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  chooseCorpus,
  configCorpora,
  readStoredCorpus,
  storeCorpus,
  withCorpus,
} from "../../packages/ui/corpus.mjs";

const CORPORA = [
  { id: "grenfell", name: "Grenfell Tower Inquiry" },
  { id: "ucpi", name: "Undercover Policing Inquiry" },
];

describe("the page's corpus", () => {
  it("reads the corpora of config.json and refuses a list without ids or names", () => {
    expect(configCorpora({ corpora: CORPORA })).toBe(CORPORA);
    expect(() => configCorpora({})).toThrow(/no corpora/);
    expect(() => configCorpora({ corpora: [{ id: "x" }] })).toThrow(/an id and a name/);
  });

  it("keeps a stored choice the list still has, else takes the first", () => {
    expect(chooseCorpus(CORPORA, "ucpi")).toBe("ucpi");
    expect(chooseCorpus(CORPORA, "gone")).toBe("grenfell");
    expect(chooseCorpus(CORPORA, null)).toBe("grenfell");
  });

  it("puts the corpus in a relative or an absolute route's query", () => {
    const page = "http://127.0.0.1:8787/";
    expect(withCorpus("/reports", "ucpi", page)).toBe("/reports?corpus=ucpi");
    expect(withCorpus("/facts/matrix?event=7", "ucpi", page)).toBe(
      "/facts/matrix?event=7&corpus=ucpi",
    );
    expect(withCorpus("https://api.example/conversations/x?thread=t", "grenfell", page)).toBe(
      "https://api.example/conversations/x?thread=t&corpus=grenfell",
    );
  });

  it("stores the choice and reads it back, and survives storage that throws", () => {
    const map = new Map();
    const storage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
    };
    storeCorpus("ucpi", storage);
    expect(map.get(STORAGE_KEY)).toBe("ucpi");
    expect(readStoredCorpus(storage)).toBe("ucpi");
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readStoredCorpus(blocked)).toBeNull();
    expect(() => storeCorpus("ucpi", blocked)).not.toThrow();
  });
});
