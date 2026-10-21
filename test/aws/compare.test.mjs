// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { WRITE_MARGIN_MS, createHandler } from "../../packages/aws/compare.mjs";
import { createCompareStore } from "../core/compareFakeStore.mjs";
import { compareProvider, compareSeed } from "../core/compareFixture.mjs";

function setup({ clock = () => 0 } = {}) {
  const store = createCompareStore(compareSeed());
  const { provider, prompts } = compareProvider();
  const lines = [];
  const handler = createHandler({
    providerFor: () => provider,
    openDb: () => store,
    now: clock,
    log: (line) => lines.push(JSON.parse(line)),
  });
  return { handler, store, prompts, lines };
}

describe("the compare handler", () => {
  it("runs one corpus, logs each stage and the result, and closes the database", async () => {
    const { handler, store, lines } = setup();
    const result = await handler({ corpus: "grenfell" });
    expect(result).toMatchObject({
      corpus: "grenfell",
      status: "complete",
      runId: expect.any(String),
      counts: { pairs: 9, rules: 7, modelCalls: 1, written: 9 },
    });
    expect(store.closed).toBe(1);
    expect(lines.at(-1)).toMatchObject({ corpus: "grenfell", status: "complete", written: 9 });
    expect(lines.map((l) => l.stage).filter(Boolean)).toContain("pairs-aligned");
  });

  it("writes nothing on a second invocation over the same assertions", async () => {
    const { handler, store, prompts } = setup();
    await handler({ corpus: "grenfell" });
    const rows = store.tables.assertion_comparisons.length;
    const again = await handler({ corpus: "grenfell" });
    expect(again.status).toBe("skipped");
    expect(store.tables.assertion_comparisons).toHaveLength(rows);
    expect(prompts).toHaveLength(1);
  });

  it("stops before a model call when less than the write margin remains, then resumes", async () => {
    const { handler } = setup();
    const short = { getRemainingTimeInMillis: () => WRITE_MARGIN_MS - 1 };
    const first = await handler({ corpus: "grenfell" }, short);
    expect(first).toMatchObject({
      status: "partial",
      counts: { claimsEmbedded: 0, modelCalls: 0, written: 0 },
    });
    const long = { getRemainingTimeInMillis: () => 15 * 60_000 };
    const second = await handler({ corpus: "grenfell" }, long);
    expect(second).toMatchObject({
      status: "complete",
      runId: first.runId,
      counts: { written: 9 },
    });
  });

  it("refuses an unknown corpus before it opens the database", async () => {
    const { handler, store } = setup();
    await expect(handler({ corpus: "nowhere" })).rejects.toThrow(/unknown corpus nowhere/);
    await expect(handler({})).rejects.toThrow(/unknown corpus/);
    expect(store.closed).toBe(0);
  });
});
