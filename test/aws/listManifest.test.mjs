// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler, STATE_LIMIT_BYTES } from "../../packages/aws/listManifest.mjs";

const row = (i) => ({
  url: `https://example.test/IWS${i}.pdf`,
  sha256: "a".repeat(64),
  bytes: 10,
  fetched_at: "2026-10-18T12:00:00Z",
  licence: "OGL-3.0",
  evidence_id: `IWS${i}`,
});
const manifest = (n) =>
  new TextEncoder().encode(
    Array.from({ length: n }, (_, i) => JSON.stringify(row(i))).join("\n") + "\n",
  );

const handlerOver = (objects) => {
  const reads = [];
  const handler = createHandler({
    s3GetObject: async (key) => {
      reads.push(key);
      return objects[key] ?? null;
    },
  });
  return { handler, reads };
};

describe("listManifest handler", () => {
  it("returns the corpus and the parsed rows of <corpus>/manifest.jsonl", async () => {
    const { handler, reads } = handlerOver({ "grenfell/manifest.jsonl": manifest(2) });
    expect(await handler({ corpus: "grenfell" })).toEqual({
      corpus: "grenfell",
      items: [row(0), row(1)],
    });
    expect(reads).toEqual(["grenfell/manifest.jsonl"]);
  });

  it("throws when the manifest is absent or has a bad line", async () => {
    await expect(handlerOver({}).handler({ corpus: "grenfell" })).rejects.toThrow(
      "grenfell/manifest.jsonl is not in the corpus bucket",
    );
    const bad = new TextEncoder().encode("{bad\n");
    await expect(
      handlerOver({ "grenfell/manifest.jsonl": bad }).handler({ corpus: "grenfell" }),
    ).rejects.toThrow("grenfell/manifest.jsonl:1: invalid JSON");
  });

  it("throws when the items and their results would pass the state limit", async () => {
    const { handler } = handlerOver({ "grenfell/manifest.jsonl": manifest(400) });
    await expect(handler({ corpus: "grenfell" })).rejects.toThrow(
      new RegExp(`400 rows; .* over the ${STATE_LIMIT_BYTES}-byte state limit`),
    );
  });

  it("throws on an unknown corpus", async () => {
    await expect(handlerOver({}).handler({ corpus: "../x" })).rejects.toThrow(/unknown corpus/);
  });
});
