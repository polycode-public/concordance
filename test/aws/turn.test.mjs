// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../../packages/aws/turn.mjs";
import { sessionIdFor } from "../../packages/core/sessions.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { PROMPT_VERSION, answerMessages } from "../../packages/core/prompt.mjs";
import { checkAnswer } from "../../packages/core/query.mjs";

const TOKENS = ["The stairs were dark ", "[E1]. ", "Nobody ", "came."];

const DOCUMENT = {
  title: "Witness statement of IWS1",
  witnessId: "IWS1",
  cipherOnly: false,
  role: "Resident",
  statementDate: "2018-02-14",
  type: "pdf",
  pages: 9,
};

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
    document: DOCUMENT,
  },
];

const queried = [];

/** A runQuery that reads its evidence from the db and answers with the provider. */
async function stubQuery({ question, corpus, provider, db, signal, onStage, onEvidence, onToken }) {
  queried.push(corpus);
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
    writes: [],
    query: async (text, params) => {
      if (/^INSERT/.test(text)) {
        db.writes.push({ text, params });
        return { rows: [] };
      }
      if (/DISTINCT corpus FROM documents/.test(text)) return { rows: [{ corpus: "grenfell" }] };
      return { rows: BLOCKS };
    },
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
    corpus: "grenfell",
  },
  connectionId: "c1",
  domainName: "abc.execute-api.eu-west-2.amazonaws.com",
  stage: "prod",
  userId: "sub-1",
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
        document: DOCUMENT,
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

  it("writes the session and the turn with every frame it posted at done", async () => {
    const { handler, db, frames } = setup();
    await handler(EVENT);
    const sessionId = sessionIdFor("c1", "grenfell");
    expect(frames.at(-1).sessionId).toBe(sessionId);
    expect(queried.at(-1)).toBe("grenfell");
    expect(db.writes).toHaveLength(2);
    expect(db.writes[0].text).toMatch(/^INSERT INTO sessions/);
    expect(db.writes[0].params).toEqual([sessionId, "sub-1", "grenfell"]);
    expect(db.writes[1].text).toMatch(/^INSERT INTO session_turns/);
    const [session, thread, turnId, userText, promptVersion, modelId, rawOutput, checks, stored] =
      db.writes[1].params;
    expect([session, thread, turnId, userText, promptVersion, modelId, rawOutput]).toEqual([
      sessionId,
      "t1",
      "u1",
      "Were the stairs dark?",
      PROMPT_VERSION,
      "fake-chat",
      TOKENS.join(""),
    ]);
    expect(JSON.parse(checks)).toMatchObject({ sentences: 2, supported: 1, abstained: false });
    const storedFrames = JSON.parse(stored);
    expect(storedFrames.at(-1)).toEqual(frames.at(-1));
    expect(storedFrames.filter((f) => f.type === "token")).toEqual([
      { type: "token", thread: "t1", turnId: "u1", text: TOKENS.join("") },
    ]);
    expect(storedFrames).toHaveLength(frames.length - TOKENS.length + 1);
  });

  it("finishes the turn and logs the cause when the session log write fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, db, frames, cancels } = setup();
    const query = db.query;
    db.query = async (text, params) => {
      if (/^INSERT/.test(text)) throw new Error("the cluster is resuming");
      return query(text, params);
    };
    await handler(EVENT);
    expect(frames.at(-1).type).toBe("done");
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(/^session log: turn u1 of session .* was not written$/),
      expect.objectContaining({ message: "the cluster is resuming" }),
    );
    expect(cancels.finished).toEqual([["c1#t1", "u1"]]);
    expect(db.closed).toBe(true);
    errors.mockRestore();
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

  it("refuses a corpus with no documents before it asks the model", async () => {
    const { handler, frames, provider, db } = setup();
    const before = queried.length;
    await handler({ ...EVENT, frame: { ...EVENT.frame, corpus: "ucpi" } });
    expect(frames.at(-1)).toEqual({
      type: "error",
      thread: "t1",
      turnId: "u1",
      message: "The corpus ucpi has no documents yet.",
    });
    expect(queried.length).toBe(before);
    expect(provider.calls).toHaveLength(0);
    expect(db.writes[0].params).toEqual([sessionIdFor("c1", "ucpi"), "sub-1", "ucpi"]);
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
