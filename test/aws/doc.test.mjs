// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/doc.mjs";

const handler = createHandler({
  originals: {
    exists: async (key) => key === "grenfell/raw/IWS1.pdf",
    presign: async (key) => `https://bucket.s3.eu-west-2.amazonaws.com/${key}?X-Amz-Expires=600`,
  },
});

const get = (id) => handler({ pathParameters: { id } });

describe("document route", () => {
  it("redirects to a presigned URL of the original", async () => {
    expect(await get("IWS1")).toEqual({
      statusCode: 302,
      headers: {
        location:
          "https://bucket.s3.eu-west-2.amazonaws.com/grenfell/raw/IWS1.pdf?X-Amz-Expires=600",
        "cache-control": "no-store",
      },
    });
  });

  it("answers 404 when the original is absent", async () => {
    expect(await get("NOPE")).toEqual({ statusCode: 404 });
  });

  it("answers 400 for an id that is not one safe segment", async () => {
    for (const id of ["../grenfell/raw/IWS1", "a/b", "a%2Fb", "a\\b", "", ".hidden", undefined]) {
      expect(await get(id)).toEqual({ statusCode: 400 });
    }
  });
});
