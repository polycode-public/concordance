// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/doc.mjs";

const CORPORA = { IWS1: "grenfell", UCPI0000001: "ucpi", NOPE: "grenfell", BAD: "../x" };
let closed = 0;
const handler = createHandler({
  openDb: async () => ({
    query: async (text, [id]) => {
      expect(text).toBe("SELECT corpus FROM documents WHERE id = $1");
      return { rows: CORPORA[id] ? [{ corpus: CORPORA[id] }] : [] };
    },
    close: async () => {
      closed += 1;
    },
  }),
  originals: {
    exists: async (key) => ["grenfell/raw/IWS1.pdf", "ucpi/raw/UCPI0000001.pdf"].includes(key),
    presign: async (key) => `https://bucket.s3.eu-west-2.amazonaws.com/${key}?X-Amz-Expires=600`,
  },
});

const get = (id) => handler({ pathParameters: { id } });

describe("document route", () => {
  it("redirects to a presigned URL of the original under the document's corpus", async () => {
    const before = closed;
    expect(await get("IWS1")).toEqual({
      statusCode: 302,
      headers: {
        location:
          "https://bucket.s3.eu-west-2.amazonaws.com/grenfell/raw/IWS1.pdf?X-Amz-Expires=600",
        "cache-control": "no-store",
      },
    });
    expect((await get("UCPI0000001")).headers.location).toContain("/ucpi/raw/UCPI0000001.pdf");
    expect(closed - before).toBe(2);
  });

  it("answers 404 when the store has no such document or the original is absent", async () => {
    expect(await get("NOPE")).toEqual({ statusCode: 404 });
    expect(await get("UNKNOWN")).toEqual({ statusCode: 404 });
  });

  it("refuses a corpus name that is not one safe segment", async () => {
    await expect(get("BAD")).rejects.toThrow(/unsafe corpus/);
  });

  it("answers 400 for an id that is not one safe segment", async () => {
    for (const id of ["../grenfell/raw/IWS1", "a/b", "a%2Fb", "a\\b", "", ".hidden", undefined]) {
      expect(await get(id)).toEqual({ statusCode: 400 });
    }
  });
});
