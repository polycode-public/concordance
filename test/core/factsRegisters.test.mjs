// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  DEMONSTRATIVES,
  POSSESSIVES,
  PRONOUNS,
  createRegisters,
  indexicalSpan,
  isIdentityRevealingPair,
  loadRegisters,
  normaliseSpan,
  pairKey,
} from "../../packages/core/facts/registers.mjs";

const WITNESSES = [
  { id: "IWS00001200", cipher_only: false, aliases: ["the resident of flat 113"] },
  { id: "W5", cipher_only: true, aliases: ["Witness W5", "Cipher W5"] },
];

describe("normaliseSpan", () => {
  it("collapses whitespace and trims", () => {
    expect(normaliseSpan("  Flat\n 16 ")).toBe("Flat 16");
  });
});

describe("createRegisters", () => {
  it("resolves a witness by id or alias without case", () => {
    const r = createRegisters({ witnesses: WITNESSES });
    expect(r.resolve("iws00001200")).toEqual({
      type: "witness",
      id: "IWS00001200",
      cipherOnly: false,
    });
    expect(r.resolve("The Resident of  Flat 113")).toMatchObject({ id: "IWS00001200" });
    expect(r.resolve("nobody")).toBeNull();
    expect(r.resolve("")).toBeNull();
  });

  it("resolves an entity by canonical or alias without case", () => {
    const r = createRegisters({
      witnesses: [],
      entities: [{ id: 7, kind: "place", canonical: "Flat 16", aliases: ["flat sixteen"] }],
    });
    expect(r.resolve("FLAT 16")).toEqual({
      type: "entity",
      id: "7",
      kind: "place",
      canonical: "Flat 16",
    });
    expect(r.resolve("Flat Sixteen")).toMatchObject({ id: "7" });
  });

  it("resolves a cipher-only witness to its cipher only", () => {
    const r = createRegisters({ witnesses: WITNESSES });
    for (const span of ["W5", "witness w5", "Cipher W5"]) {
      expect(r.resolve(span)).toEqual({ type: "witness", id: "W5", cipherOnly: true });
    }
  });

  it("never lets an entity attach another name to a cipher", () => {
    const r = createRegisters({
      witnesses: WITNESSES,
      entities: [
        { id: 1, kind: "person", canonical: "W5", aliases: ["John Example"] },
        { id: 2, kind: "person", canonical: "Jane Example", aliases: ["Witness W5"] },
      ],
    });
    expect(r.resolve("W5")).toEqual({ type: "witness", id: "W5", cipherOnly: true });
    expect(r.resolve("Witness W5")).toEqual({ type: "witness", id: "W5", cipherOnly: true });
    expect(r.resolve("John Example")).toBeNull();
    expect(r.resolve("Jane Example")).toBeNull();
    expect(r.ignoredAliases).toEqual([
      { entityId: "1", alias: "john example" },
      { entityId: "2", alias: "jane example" },
    ]);
    r.addEntity({ id: 3, kind: "person", canonical: "cipher w5", aliases: ["J. Example"] });
    expect(r.resolve("J. Example")).toBeNull();
  });

  it("prefers a witness over an entity of the same name", () => {
    const r = createRegisters({
      witnesses: WITNESSES,
      entities: [{ id: 9, kind: "person", canonical: "IWS00001200", aliases: [] }],
    });
    expect(r.resolve("IWS00001200")).toMatchObject({ type: "witness" });
  });

  it("throws when two witnesses share a name", () => {
    expect(() =>
      createRegisters({
        witnesses: [
          { id: "A", cipher_only: false, aliases: ["X"] },
          { id: "B", cipher_only: true, aliases: ["x"] },
        ],
      }),
    ).toThrow("the name x belongs to witnesses A and B");
  });

  it("resolves a name two named witnesses share to neither, and each id to its witness", () => {
    const r = createRegisters({
      witnesses: [
        { id: "IWS1", cipher_only: false, aliases: ["Marion Telfer"] },
        { id: "IWS2", cipher_only: false, aliases: ["marion telfer"] },
        { id: "IWS3", cipher_only: false, aliases: ["Marion  Telfer", "M. Telfer"] },
      ],
    });
    expect(r.resolve("Marion Telfer")).toBeNull();
    expect(r.resolve("M. Telfer")).toMatchObject({ id: "IWS3" });
    expect(r.resolve("IWS2")).toMatchObject({ id: "IWS2" });
    expect(r.ambiguousNames).toEqual(["marion telfer"]);
  });

  it("loads both registers from the store", async () => {
    const db = {
      query: async (text) => ({
        rows: /FROM witnesses/.test(text)
          ? WITNESSES
          : [{ id: "4", kind: "unit", canonical: "Red Watch", aliases: [] }],
      }),
    };
    const r = await loadRegisters(db);
    expect(r.resolve("red watch")).toMatchObject({ id: "4" });
    expect(r.resolve("W5")).toMatchObject({ cipherOnly: true });
  });
});

describe("identity-revealing pairs", () => {
  it("stores a pair with the smaller id first", () => {
    expect(pairKey("IWS2", "IWS1")).toEqual(["IWS1", "IWS2"]);
    expect(() => pairKey("IWS1", "IWS1")).toThrow(/two different/);
  });

  it("finds a pair in either order", async () => {
    const calls = [];
    const db = {
      query: async (text, params) => {
        calls.push(params);
        return { rows: params[0] === "IWS1" && params[1] === "IWS2" ? [{}] : [] };
      },
    };
    expect(await isIdentityRevealingPair(db, "IWS2", "IWS1")).toBe(true);
    expect(await isIdentityRevealingPair(db, "IWS1", "IWS3")).toBe(false);
    expect(calls).toEqual([
      ["IWS1", "IWS2"],
      ["IWS1", "IWS3"],
    ]);
  });
});

describe("indexicalSpan", () => {
  it("is true for a bare pronoun or demonstrative and for a possessive and its noun", () => {
    for (const text of [
      "This",
      "that",
      "It",
      "we",
      "my flat",
      "My  daughter",
      "their son",
      "Our block",
    ]) {
      expect(indexicalSpan(text), text).toBe(true);
    }
  });

  it("is false for a named or described span and for a demonstrative and its noun", () => {
    for (const text of ["the bridgehead", "Flat 16", "my", "this control room", "Mrs Ash", ""]) {
      expect(indexicalSpan(text), text).toBe(false);
    }
  });

  it("keeps the lists apart from the possessives", () => {
    expect(POSSESSIVES).toEqual(["my", "our", "his", "her", "their"]);
    expect(DEMONSTRATIVES).toEqual(["this", "that", "these", "those"]);
    expect(PRONOUNS).toContain("they");
  });
});
