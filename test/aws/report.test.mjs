// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../../packages/aws/report.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { sessionIdFor } from "../../packages/core/sessions.mjs";
import { createReportsStore } from "../core/reportsFakeStore.mjs";

const TARGET = {
  connectionId: "c1",
  domainName: "abc.execute-api.eu-west-2.amazonaws.com",
  stage: "prod",
};

const FRAME = {
  type: "report",
  thread: "t1",
  requestId: "r1",
  topic: "The stairs and the lift",
  documentIds: [],
  filename: "stairs.md",
  corpus: "grenfell",
};

const OUTLINE = {
  title: "Smoke on the stairs",
  sections: [
    { heading: "The stairs", evidence: [1] },
    { heading: "The lift", evidence: [2] },
  ],
};

/** A fake provider whose chat answers each section in turn. */
function provider(texts = ["The stairs were dark [E1].", "The lift stopped [E2]."]) {
  const queue = [...texts];
  return {
    ...createFakeProvider({ tokens: [], delayMs: 0, embedDim: 1024, extractJson: () => OUTLINE }),
    chat: async (args) => {
      if (!queue.length) throw new Error("the model is unavailable");
      return createFakeProvider({ tokens: [queue.shift()], delayMs: 0 }).chat(args);
    },
  };
}

function setup({ post, chat } = {}) {
  const db = createReportsStore();
  const posted = [];
  let closed = 0;
  const handler = createHandler({
    providerFor: async () => provider(chat),
    openDb: async () => ({ ...db, close: async () => (closed += 1) }),
    postToConnection:
      post ??
      (async (target, frame) => {
        posted.push({ target, frame });
      }),
  });
  return { handler, db, posted, closed: () => closed };
}

const run = (handler, frame = FRAME) => handler({ frame, ...TARGET, userId: "sub-1" });

describe("the report function", () => {
  it("posts each stage, stores the report and posts reportDone with its scores", async () => {
    const { handler, db, posted, closed } = setup();
    await run(handler);
    expect(posted.every((p) => p.target.connectionId === "c1")).toBe(true);
    const frames = posted.map((p) => p.frame);
    expect(frames.slice(0, 4)).toEqual(
      ["drafting", "writing", "reviewing", "done"].map((stage) => ({
        type: "reportStatus",
        thread: "t1",
        requestId: "r1",
        stage,
      })),
    );
    const done = frames[4];
    expect(frames).toHaveLength(5);
    expect(done).toMatchObject({
      type: "reportDone",
      thread: "t1",
      requestId: "r1",
      report: {
        id: "1",
        filename: "stairs.md",
        version: 1,
        title: "Smoke on the stairs",
        citations: [
          { evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } },
          { evidence: 2, locator: { document: "IWS2", page: 2, paragraph: 4 } },
        ],
        checks: { sentences: 2, supported: 2, flagged: 0 },
      },
    });
    expect(done.report.checks.marks).toBeUndefined();
    expect(db.sessions.get(sessionIdFor("c1", "grenfell"))).toBe("sub-1");
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({
      session_id: sessionIdFor("c1", "grenfell"),
      user_id: "sub-1",
      version: 1,
    });
    expect(db.reports[0].checks.marks).toHaveLength(2);
    expect(closed()).toBe(1);
  });

  it("stores version 2 when the filename already has a report", async () => {
    const { handler, db, posted } = setup();
    await run(handler);
    await run(handler, { ...FRAME, requestId: "r2", topic: "Say more about the lift." });
    expect(db.reports.map((r) => [r.version, r.topic, r.change_prompt])).toEqual([
      [1, "The stairs and the lift", null],
      [2, "The stairs and the lift", "Say more about the lift."],
    ]);
    expect(posted.at(-1).frame.report).toMatchObject({ version: 2 });
  });

  it("posts an error frame when the cycle throws and stores nothing", async () => {
    const { handler, db, posted } = setup({ chat: [] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await run(handler);
    error.mockRestore();
    const last = posted.at(-1).frame;
    expect(last).toEqual({
      type: "error",
      thread: "t1",
      requestId: "r1",
      message: "the model is unavailable",
    });
    expect(db.reports).toEqual([]);
  });

  it("keeps writing the report after the connection has gone", async () => {
    const calls = [];
    const { handler, db } = setup({
      post: async (_target, frame) => {
        calls.push(frame.type);
        throw Object.assign(new Error("gone"), { name: "GoneException" });
      },
    });
    await run(handler);
    expect(calls).toEqual(["reportStatus"]);
    expect(db.reports).toHaveLength(1);
  });

  it("refuses a corpus with no documents and stores nothing", async () => {
    const { handler, db, posted } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await run(handler, { ...FRAME, corpus: "ucpi" });
    error.mockRestore();
    expect(posted.at(-1).frame).toMatchObject({
      type: "error",
      message: "The corpus ucpi has no documents yet.",
    });
    expect(db.reports).toEqual([]);
    expect(db.sessions.size).toBe(0);
  });

  it("refuses a request without a user", async () => {
    const { handler, posted, db } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await handler({ frame: FRAME, ...TARGET, userId: undefined });
    error.mockRestore();
    expect(posted.map((p) => p.frame)).toEqual([
      {
        type: "error",
        thread: "t1",
        requestId: "r1",
        message: "the report request has no signed-in user",
      },
    ]);
    expect(db.calls).toEqual([]);
  });
});
