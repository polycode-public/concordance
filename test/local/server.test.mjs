// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer } from "../../packages/local/server.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { PROMPT_VERSION, SYSTEM_PROMPT, answerMessages } from "../../packages/core/prompt.mjs";
import { checkAnswer } from "../../packages/core/query.mjs";

const TOKENS = ["The stairs were dark ", "[E1]. ", "Nobody ", "came."];

let app;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames = [];
    const waiters = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      for (const w of [...waiters]) {
        if (w.match(frame)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    });
    const until = (match, timeoutMs = 3000) => {
      const found = frames.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error("timed out waiting for frame")), timeoutMs);
        waiters.push({ match, resolve: (f) => (clearTimeout(timer), res(f)) });
      });
    };
    ws.on("open", () => resolve({ ws, frames, until, send: (f) => ws.send(JSON.stringify(f)) }));
    ws.on("error", reject);
  });
}

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

/** A runQuery that skips retrieval and answers over fixed blocks. */
function stubQuery(blocks = BLOCKS) {
  return async ({ question, provider, signal, onStage, onEvidence, onToken }) => {
    onStage("rewriting");
    onStage("retrieving");
    onEvidence(blocks);
    onStage("answering");
    const result = await provider.chat({
      messages: answerMessages(question, blocks),
      signal,
      temperature: 0,
      promptVersion: PROMPT_VERSION,
      onToken,
    });
    onStage("checking");
    const { citations, checks } = checkAnswer(result.text, blocks);
    return {
      answer: result.text,
      abstained: false,
      citations,
      checks: { ...checks, model: result.model, promptVersion: PROMPT_VERSION },
    };
  };
}

/** A db whose documents table holds the given rows by id. */
const fakeDb = (documents = {}) => ({
  query: async (text, params) => {
    if (/FROM documents/.test(text)) {
      const doc = documents[params[0]];
      return { rows: doc ? [doc] : [] };
    }
    return { rows: [] };
  },
});

const turnServer = (provider, options = {}) =>
  createServer({ provider, db: fakeDb(), runQuery: stubQuery(), ...options });

const indexOfFrame = (frames, typeOrStage) =>
  frames.findIndex((f) => f.type === typeOrStage || f.stage === typeOrStage);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("local server", () => {
  it("reports health without a database or Ollama", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
    const res = await fetch(`http://127.0.0.1:${app.port}/health`);
    expect(await res.json()).toEqual({
      ok: true,
      provider: "fake",
      db: "unknown",
      ollama: "unknown",
    });
  });

  it("reports a down Ollama when nothing listens on its URL", async () => {
    app = await createServer({
      provider: createFakeProvider({ tokens: [] }),
      ollamaUrl: "http://127.0.0.1:9",
    });
    const body = await (await fetch(`http://127.0.0.1:${app.port}/health`)).json();
    expect(body.ollama).toBe("down");
  });

  it("serves the UI with the correct content types", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
    const base = `http://127.0.0.1:${app.port}`;
    const html = await fetch(`${base}/`);
    expect(html.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await html.text()).toContain('<script type="module" src="/app.js">');
    expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toMatch(
      /^text\/javascript/,
    );
    expect((await fetch(`${base}/styles.css`)).headers.get("content-type")).toMatch(/^text\/css/);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2fserver.mjs`)).status).toBeGreaterThanOrEqual(400);
  });

  it("streams a turn through the stages and reports citation checks", async () => {
    const provider = createFakeProvider({ tokens: TOKENS, delayMs: 5 });
    app = await turnServer(provider);
    const client = await connect(app.port);
    client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Were the stairs dark?" });
    const done = await client.until((f) => f.type === "done");
    client.ws.close();

    const stages = client.frames.filter((f) => f.type === "status").map((f) => f.stage);
    expect(stages).toEqual(["rewriting", "retrieving", "answering", "checking"]);
    const evidence = client.frames.find((f) => f.type === "evidence");
    expect(evidence.blocks).toEqual([
      {
        evidence: 1,
        documentId: "IWS1",
        locator: { page: 3, paragraph: 11 },
        header: "[Grenfell Inquiry | Witness IWS1 | p.3 para 11]",
        text: "The stairs were dark.",
      },
    ]);
    expect(indexOfFrame(client.frames, "evidence")).toBeLessThan(
      indexOfFrame(client.frames, "answering"),
    );
    const tokens = client.frames.filter((f) => f.type === "token").map((f) => f.text);
    expect(tokens).toEqual(TOKENS);
    const order = client.frames.map((f) => f.type);
    expect(order.indexOf("evidence")).toBeLessThan(order.indexOf("token"));
    expect(order.lastIndexOf("token")).toBeLessThan(order.indexOf("done"));
    expect(done).toMatchObject({ thread: "t1", turnId: "u1" });
    expect(done.checks).toMatchObject({
      sentences: 2,
      supported: 1,
      flaggedRatio: 0.5,
      warning: true,
    });
    expect(done.citations).toEqual([
      { evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } },
    ]);
    expect(provider.calls[0].messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(provider.calls[0].messages[1].content).toContain(
      "[E1] [Grenfell Inquiry | Witness IWS1 | p.3 para 11]\nThe stairs were dark.",
    );
    expect(SYSTEM_PROMPT).toContain("the corpus does not say");
  });

  it("answers a turn with an error frame when no database is configured", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: TOKENS }) });
    const client = await connect(app.port);
    client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Question?" });
    const error = await client.until((f) => f.type === "error");
    client.ws.close();
    expect(error).toMatchObject({ thread: "t1", turnId: "u1" });
    expect(error.message).toMatch(/database is not configured/);
  });

  it("stops the token stream when the client cancels mid-stream", async () => {
    app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 60 }));
    const client = await connect(app.port);
    client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Question?" });
    await client.until((f) => f.type === "token");
    client.send({ type: "cancel", thread: "t1", turnId: "u1" });
    const cancelled = await client.until((f) => f.type === "cancelled");
    expect(cancelled).toMatchObject({ thread: "t1", turnId: "u1" });
    const tokensAtCancel = client.frames.filter((f) => f.type === "token").length;
    await sleep(250);
    client.ws.close();
    expect(client.frames.filter((f) => f.type === "token").length).toBe(tokensAtCancel);
    expect(tokensAtCancel).toBeLessThan(TOKENS.length);
    expect(client.frames.some((f) => f.type === "done")).toBe(false);
  });

  it("cancels the in-flight turn when a new turn arrives on the same thread", async () => {
    app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 30 }));
    const client = await connect(app.port);
    client.send({ type: "turn", thread: "t1", turnId: "u1", text: "First?" });
    await client.until((f) => f.type === "token" && f.turnId === "u1");
    client.send({ type: "turn", thread: "t1", turnId: "u2", text: "Second?" });
    await client.until((f) => f.type === "cancelled" && f.turnId === "u1");
    const done = await client.until((f) => f.type === "done");
    client.ws.close();
    expect(done.turnId).toBe("u2");
    expect(client.frames.some((f) => f.type === "done" && f.turnId === "u1")).toBe(false);
  });

  it("runs turns on different threads independently", async () => {
    app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 5 }));
    const client = await connect(app.port);
    client.send({ type: "turn", thread: "a", turnId: "1", text: "A?" });
    client.send({ type: "turn", thread: "b", turnId: "2", text: "B?" });
    await client.until((f) => f.type === "done" && f.thread === "a");
    await client.until((f) => f.type === "done" && f.thread === "b");
    client.ws.close();
    expect(client.frames.some((f) => f.type === "cancelled")).toBe(false);
  });

  it("answers a malformed frame with an error frame", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
    const client = await connect(app.port);
    client.ws.send("{not json");
    const error = await client.until((f) => f.type === "error");
    client.ws.close();
    expect(error.message).toMatch(/JSON/);
  });

  describe("originals", () => {
    let corpora;
    const PDF = Buffer.from("%PDF-1.4\n%fake\n");
    const docs = {
      IWS1: { corpus: "grenfell", title: "Statement of IWS1" },
      IWS2: { corpus: "grenfell", title: null },
    };
    afterEach(async () => {
      if (corpora) await rm(corpora, { recursive: true, force: true });
      corpora = undefined;
    });
    const withCorpora = async () => {
      corpora = await mkdtemp(path.join(tmpdir(), "concordance-corpora-"));
      await mkdir(path.join(corpora, "grenfell", "raw"), { recursive: true });
      await writeFile(path.join(corpora, "grenfell", "raw", "IWS1.pdf"), PDF);
      return createServer({
        provider: createFakeProvider({ tokens: [] }),
        db: fakeDb(docs),
        corporaDir: corpora,
      });
    };

    it("streams the original PDF of a document", async () => {
      app = await withCorpora();
      const res = await fetch(`http://127.0.0.1:${app.port}/doc/IWS1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF);
    });

    it("answers 404 for an unknown document or a missing file, 400 for a path", async () => {
      app = await withCorpora();
      const base = `http://127.0.0.1:${app.port}/doc`;
      expect((await fetch(`${base}/NOPE`)).status).toBe(404);
      expect((await fetch(`${base}/IWS2`)).status).toBe(404);
      expect((await fetch(`${base}/..%2Fgrenfell%2Fraw%2FIWS1`)).status).toBe(400);
      expect((await fetch(`${base}/a%5Cb`)).status).toBe(400);
      expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
    });

    it("answers 503 for a document when no database is configured", async () => {
      app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
      expect((await fetch(`http://127.0.0.1:${app.port}/doc/IWS1`)).status).toBe(503);
    });

    it("answers an open frame with the URL and page of the original", async () => {
      app = await withCorpora();
      const client = await connect(app.port);
      client.send({ type: "open", docId: "IWS1", locator: { page: 3, paragraph: 11 } });
      const opened = await client.until((f) => f.type === "opened");
      client.send({ type: "open", docId: "IWS2", locator: null });
      const error = await client.until((f) => f.type === "error");
      client.ws.close();
      expect(opened).toEqual({
        type: "opened",
        docId: "IWS1",
        url: "/doc/IWS1",
        title: "Statement of IWS1",
        page: 3,
        locator: { page: 3, paragraph: 11 },
      });
      expect(error.message).toMatch(/no original PDF for IWS2/);
    });
  });
});
