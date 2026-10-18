// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/turn.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { PROMPT_VERSION, answerMessages } from "../../packages/core/prompt.mjs";
import { checkAnswer } from "../../packages/core/query.mjs";

const TOKENS = ["The stairs were dark ", "[E1]. ", "Nobody ", "came."];

const BLOCKS = [
  {
    evidence: 1,
    chunkId: "7",
    chunkIds: ["6", "7", "8"],
    level: "passage",
    documentId: "IWS1",
    locator: { page: 3, paragraph: 11 },
    header: "[Grenfell Inquiry | Witness IWS1 | p.3 para 11]",
    text: "The stairs were dark.",
  },
];

/** A runQuery that reads its evidence from the db and answers with the provider. */
async function stubQuery({ question, provider, db, signal, onStage, onEvidence, onToken }) {
  onStage("rewriting");
  onStage("retrieving");
  const { rows: blocks } = await db.query("SELECT evidence");
  onEvidence(blocks);
  onStage("answering");
  const result = await provider.chat({
    messages: answerMessages(question, blocks),
    signal,
    temperature: 0,
    promptVersion: PROMPT_VERSION,
    onToken,
  });
  signal.throwIfAborted();
  onStage("checking");
  const { citations, checks } = checkAnswer(result.text, blocks);
  return {
    answer: result.text,
    abstained: false,
    citations,
    checks: {
      ...checks,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      usage: result.usage,
      timings: { rewriting: 0, retrieving: 1, answering: 2, checking: 0 },
    },
  };
}

function fakeDb() {
  const db = {
    closed: false,
    query: async () => ({ rows: BLOCKS }),
    close: async () => {
      db.closed = true;
    },
  };
  return db;
}

function fakeCancels(item) {
  const cancels = {
    item,
    reads: 0,
    finished: [],
    read: async () => {
      cancels.reads += 1;
      return cancels.item;
    },
    finish: async (pk, turnId) => cancels.finished.push([pk, turnId]),
  };
  return cancels;
}

function setup({ tokens = TOKENS, delayMs = 5, item, post } = {}) {
  const provider = createFakeProvider({ tokens, delayMs });
  const db = fakeDb();
  const cancels = fakeCancels(item ?? { turnId: "u1", cancelled: false });
  const frames = [];
  const targets = [];
  const handler = createHandler({
    providerFor: async () => provider,
    openDb: async () => db,
    cancels,
    postToConnection:
      post ??
      (async (target, frame) => {
        targets.push(target);
        frames.push(frame);
      }),
    runQuery: stubQuery,
    pollMs: 0,
  });
  return { handler, provider, db, cancels, frames, targets };
}

const EVENT = {
  frame: {
    type: "turn",
    thread: "t1",
    turnId: "u1",
    text: "Were the stairs dark?",
    attachments: [],
  },
  connectionId: "c1",
  domainName: "abc.execute-api.eu-west-2.amazonaws.com",
  stage: "prod",
};

describe("turn function", () => {
  it("posts the frames of a turn in the laptop server's order", async () => {
    const { handler, db, cancels, frames, targets } = setup();
    await handler(EVENT);

    expect(frames.map((f) => f.type)).toEqual([
      "status",
      "status",
      "evidence",
      "status",
      "token",
      "token",
      "token",
      "token",
      "status",
      "done",
    ]);
    expect(frames.filter((f) => f.type === "status").map((f) => f.stage)).toEqual([
      "rewriting",
      "retrieving",
      "answering",
      "checking",
    ]);
    expect(frames.find((f) => f.type === "evidence").blocks).toEqual([
      {
        evidence: 1,
        documentId: "IWS1",
        locator: { page: 3, paragraph: 11 },
        header: "[Grenfell Inquiry | Witness IWS1 | p.3 para 11]",
        text: "The stairs were dark.",
      },
    ]);
    expect(frames.filter((f) => f.type === "token").map((f) => f.text)).toEqual(TOKENS);
    const done = frames.at(-1);
    expect(done).toMatchObject({ thread: "t1", turnId: "u1" });
    expect(done.checks).toMatchObject({ sentences: 2, supported: 1, abstained: false });
    expect(done.checks.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.keys(done.checks.timings)).toEqual([
      "rewriting",
      "retrieving",
      "answering",
      "checking",
    ]);
    expect(done.citations).toEqual([
      { evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } },
    ]);
    expect(targets[0]).toEqual({
      connectionId: "c1",
      domainName: "abc.execute-api.eu-west-2.amazonaws.com",
      stage: "prod",
    });
    expect(db.closed).toBe(true);
    expect(cancels.finished).toEqual([["c1#t1", "u1"]]);
  });

  it("stops mid-stream and posts cancelled when the thread's item is flagged", async () => {
    const { handler, db, cancels, frames } = setup({ delayMs: 30 });
    const run = handler(EVENT);
    await new Promise((r) => setTimeout(r, 45));
    cancels.item = { turnId: "u1", cancelled: true };
    await run;
    const tokens = frames.filter((f) => f.type === "token").length;
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(TOKENS.length);
    expect(frames.at(-1)).toEqual({ type: "cancelled", thread: "t1", turnId: "u1" });
    expect(frames.some((f) => f.type === "done")).toBe(false);
    expect(db.closed).toBe(true);
  });

  it("stops when a newer turn on the thread supersedes it", async () => {
    const { handler, cancels, frames } = setup({ delayMs: 30 });
    const run = handler(EVENT);
    await new Promise((r) => setTimeout(r, 45));
    cancels.item = { turnId: "u2", cancelled: false };
    await run;
    expect(frames.at(-1)).toEqual({ type: "cancelled", thread: "t1", turnId: "u1" });
  });

  it("stops the turn when the connection is gone", async () => {
    let posts = 0;
    const gone = Object.assign(new Error("gone"), { name: "GoneException" });
    const { handler, provider, db } = setup({
      delayMs: 20,
      post: async (_target, frame) => {
        posts += 1;
        if (frame.type === "token") throw gone;
      },
    });
    await handler(EVENT);
    expect(posts).toBe(5);
    expect(provider.calls).toHaveLength(1);
    expect(db.closed).toBe(true);
  });

  it("posts an error frame when the turn fails", async () => {
    const { handler, frames, db } = setup();
    db.query = async () => {
      throw new Error("the cluster is resuming");
    };
    await handler(EVENT);
    expect(frames.at(-1)).toEqual({
      type: "error",
      thread: "t1",
      turnId: "u1",
      message: "the cluster is resuming",
    });
    expect(db.closed).toBe(true);
  });
});
