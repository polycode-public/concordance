// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer } from "../../packages/local/server.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { PROMPT_VERSION, SYSTEM_PROMPT, answerMessages } from "../../packages/core/prompt.mjs";
import { checkAnswer } from "../../packages/core/query.mjs";
import { createReportsStore } from "../core/reportsFakeStore.mjs";

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
      checks: {
        ...checks,
        model: result.model,
        promptVersion: PROMPT_VERSION,
        usage: result.usage,
        timings: { rewriting: 0, retrieving: 1, answering: 2, checking: 0 },
      },
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

  it("serves a config.json that points the page at its own WebSocket without sign-in", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
    const res = await fetch(`http://127.0.0.1:${app.port}/config.json`);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      wsUrl: `ws://127.0.0.1:${app.port}/ws`,
      httpUrl: "",
      auth: null,
      corpus: { id: "grenfell", title: "Grenfell Tower Inquiry", subtitle: "witness statements" },
      spendUrl: "/spend",
      conversationsUrl: "/conversations",
      reportsUrl: "/reports",
      exportUrl: "/export",
    });
  });

  it("answers /spend with null, because the laptop has no budget", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
    const res = await fetch(`http://127.0.0.1:${app.port}/spend`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toBeNull();
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

  it("serves PDF.js and the faces from the site", async () => {
    app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
    const base = `http://127.0.0.1:${app.port}`;
    const lib = await fetch(`${base}/vendor/pdf.min.mjs`);
    expect(lib.status).toBe(200);
    expect(lib.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect((await fetch(`${base}/vendor/pdf.worker.min.mjs`)).status).toBe(200);
    const face = await fetch(`${base}/fonts/source-sans-3-latin-400-normal.woff2`);
    expect(face.status).toBe(200);
    expect(face.headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${base}/fonts/missing.woff2`)).status).toBe(404);
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
        document: DOCUMENT,
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
    expect(done.checks.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.keys(done.checks.timings)).toEqual([
      "rewriting",
      "retrieving",
      "answering",
      "checking",
    ]);
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

  describe("the session log and the conversations", () => {
    /** A db that keeps the sessions and session_turns rows the server writes. */
    function storeDb() {
      const sessions = [];
      const turns = [];
      return {
        sessions,
        turns,
        query: async (text, params) => {
          if (/^INSERT INTO sessions/.test(text)) {
            sessions.push({ id: params[0], user_id: params[1] });
            return { rows: [] };
          }
          if (/^INSERT INTO session_turns/.test(text)) {
            const [session_id, thread, turn_id, user_text, prompt_version, model_id] = params;
            turns.push({
              session_id,
              thread,
              turn_id,
              user_text,
              prompt_version,
              model_id,
              raw_output: params[6],
              checks: JSON.parse(params[7]),
              frames: JSON.parse(params[8]),
              created_at: "2026-10-19T09:30:00.000Z",
            });
            return { rows: [] };
          }
          if (/FROM conversations/.test(text)) {
            return {
              rows: sessions
                .filter((s) => s.user_id === params[0])
                .flatMap((s) => {
                  const own = turns.filter((t) => t.session_id === s.id);
                  return own.length
                    ? [
                        {
                          session_id: s.id,
                          thread: own[0].thread,
                          first_question: own[0].user_text,
                          turn_count: own.length,
                          last_turn_at: own.at(-1).created_at,
                        },
                      ]
                    : [];
                }),
            };
          }
          if (/FROM sessions WHERE/.test(text)) {
            return { rows: sessions.filter((s) => s.id === params[0] && s.user_id === params[1]) };
          }
          if (/FROM session_turns/.test(text)) {
            return {
              rows: turns.filter(
                (t) => t.session_id === params[0] && (params[1] === null || t.thread === params[1]),
              ),
            };
          }
          return { rows: [] };
        },
      };
    }

    const waitFor = async (check) => {
      for (let i = 0; i < 100 && !check(); i++) await sleep(10);
      expect(check()).toBe(true);
    };

    it("writes a sessions row on connect and a session_turns row with the turn's frames", async () => {
      const db = storeDb();
      app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 2 }), { db });
      const client = await connect(app.port);
      client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Were the stairs dark?" });
      await client.until((f) => f.type === "done");
      await waitFor(() => db.turns.length === 1);
      client.ws.close();

      expect(db.sessions).toHaveLength(1);
      expect(db.sessions[0].user_id).toBe("laptop");
      expect(db.sessions[0].id).toMatch(/^[0-9a-f-]{36}$/);
      const [turn] = db.turns;
      expect(turn).toMatchObject({
        session_id: db.sessions[0].id,
        thread: "t1",
        turn_id: "u1",
        user_text: "Were the stairs dark?",
        prompt_version: PROMPT_VERSION,
        model_id: "fake-chat",
        raw_output: TOKENS.join(""),
      });
      expect(turn.checks).toMatchObject({ sentences: 2, supported: 1, abstained: false });
      expect(turn.frames.map((f) => f.type)).toEqual([
        "status",
        "status",
        "evidence",
        "status",
        "token",
        "status",
        "done",
      ]);
      expect(turn.frames.find((f) => f.type === "token").text).toBe(TOKENS.join(""));
      expect(turn.frames.at(-1)).toEqual(client.frames.find((f) => f.type === "done"));
    });

    it("writes a cancelled turn without a model result", async () => {
      const db = storeDb();
      app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 60 }), { db });
      const client = await connect(app.port);
      client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Question?" });
      await client.until((f) => f.type === "token");
      client.send({ type: "cancel", thread: "t1", turnId: "u1" });
      await client.until((f) => f.type === "cancelled");
      await waitFor(() => db.turns.length === 1);
      client.ws.close();
      expect(db.turns[0]).toMatchObject({ model_id: null, raw_output: null, checks: {} });
      expect(db.turns[0].frames.at(-1)).toEqual({
        type: "cancelled",
        thread: "t1",
        turnId: "u1",
      });
    });

    it("keeps the turn when the session log cannot be written", async () => {
      const errors = [];
      const log = console.error;
      console.error = (...args) => errors.push(args);
      try {
        const db = fakeDb();
        const query = db.query;
        db.query = async (text, params) => {
          if (/^INSERT INTO session/.test(text)) throw new Error("disk full");
          return query(text, params);
        };
        app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 2 }), { db });
        const client = await connect(app.port);
        client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Dark?" });
        await client.until((f) => f.type === "done");
        await waitFor(() => errors.length === 2);
        client.ws.close();
      } finally {
        console.error = log;
      }
      expect(errors.map((e) => e[0])).toEqual([
        expect.stringMatching(/^session log: session .* was not written$/),
        expect.stringMatching(/^session log: turn u1 of session .* was not written$/),
      ]);
      expect(errors[0][1].message).toBe("disk full");
    });

    it("lists the conversations and answers one session's turns with their frames", async () => {
      const db = storeDb();
      app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 2 }), { db });
      const client = await connect(app.port);
      client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Were the stairs dark?" });
      await client.until((f) => f.type === "done");
      await waitFor(() => db.turns.length === 1);
      client.ws.close();
      const base = `http://127.0.0.1:${app.port}/conversations`;

      const list = await fetch(base);
      expect(list.headers.get("content-type")).toMatch(/^application\/json/);
      const sessionId = db.sessions[0].id;
      expect(await list.json()).toEqual({
        conversations: [
          {
            sessionId,
            thread: "t1",
            firstQuestion: "Were the stairs dark?",
            lastTurnAt: "2026-10-19T09:30:00.000Z",
            turnCount: 1,
          },
        ],
      });

      const one = await (await fetch(`${base}/${sessionId}?thread=t1`)).json();
      expect(one.sessionId).toBe(sessionId);
      expect(one.turns).toHaveLength(1);
      expect(one.turns[0]).toMatchObject({
        thread: "t1",
        turnId: "u1",
        userText: "Were the stairs dark?",
        promptVersion: PROMPT_VERSION,
        modelId: "fake-chat",
      });
      expect(one.turns[0].frames).toEqual(db.turns[0].frames);

      expect((await fetch(`${base}/not-a-uuid`)).status).toBe(400);
      expect((await fetch(`${base}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    });

    it("writes the thread as Markdown under the corpus notes, refuses an overwrite and serves it", async () => {
      const corpora = await mkdtemp(path.join(tmpdir(), "concordance-notes-"));
      try {
        const db = storeDb();
        app = await turnServer(createFakeProvider({ tokens: TOKENS, delayMs: 2 }), {
          db,
          corporaDir: corpora,
          now: () => new Date("2026-10-19T10:00:00.000Z"),
        });
        const client = await connect(app.port);
        client.send({ type: "turn", thread: "t1", turnId: "u1", text: "Were the stairs dark?" });
        const done = await client.until((f) => f.type === "done");
        await waitFor(() => db.turns.length === 1);
        client.ws.close();
        const sessionId = db.sessions[0].id;
        expect(done.sessionId).toBe(sessionId);
        const post = (body) =>
          fetch(`http://127.0.0.1:${app.port}/export`, {
            method: "POST",
            body: JSON.stringify(body),
          });

        const res = await post({ sessionId, thread: "t1" });
        expect(res.status).toBe(200);
        const { key, bytes, url } = await res.json();
        expect(key).toMatch(new RegExp(`^notes/${sessionId}/t1-2026-10-19t10-00-00\\.000z\\.md$`));
        expect(url).toBe(`/${key}`);
        const file = path.join(corpora, "grenfell", key);
        const text = await readFile(file, "utf8");
        expect(Buffer.byteLength(text)).toBe(bytes);
        expect(text).toContain("You asked:");
        expect(text).toContain("> Were the stairs dark?");
        expect(text).toContain("[^1-E1]: IWS1, page 3, paragraph 11");

        const served = await fetch(`http://127.0.0.1:${app.port}${url}`);
        expect(served.status).toBe(200);
        expect(await served.text()).toBe(text);
        expect((await fetch(`http://127.0.0.1:${app.port}/notes/..%2Fx`)).status).toBe(400);

        expect((await post({ sessionId, thread: "nothread" })).status).toBe(404);
        expect((await post({ sessionId: "nope", thread: "t1" })).status).toBe(400);
        expect((await post({ sessionId, thread: "T 1" })).status).toBe(400);
        await writeFile(file, "kept");
        expect((await post({ sessionId, thread: "t1" })).status).toBe(409);
        expect(await readFile(file, "utf8")).toBe("kept");
      } finally {
        await rm(corpora, { recursive: true, force: true });
      }
    });

    it("answers 503 for the conversations when no database is configured", async () => {
      app = await createServer({ provider: createFakeProvider({ tokens: [] }) });
      const base = `http://127.0.0.1:${app.port}/conversations`;
      expect((await fetch(base)).status).toBe(503);
      expect((await fetch(`${base}/00000000-0000-4000-8000-000000000000`)).status).toBe(503);
    });
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

describe("generated reports on the laptop", () => {
  const OUTLINE = {
    title: "Smoke on the stairs",
    sections: [
      { heading: "The stairs", evidence: [1] },
      { heading: "The lift", evidence: [2] },
    ],
  };
  /** A fake provider whose chat answers each section in turn, for every report it writes. */
  const reportProvider = () => {
    let n = 0;
    const texts = ["The stairs were dark [E1].", "The lift stopped [E2]."];
    return {
      ...createFakeProvider({ tokens: [], delayMs: 0, embedDim: 1024, extractJson: () => OUTLINE }),
      chat: (args) =>
        createFakeProvider({ tokens: [texts[n++ % texts.length]], delayMs: 0 }).chat(args),
    };
  };
  const request = (extra = {}) => ({
    type: "report",
    thread: "t1",
    requestId: "r1",
    topic: "The stairs and the lift",
    documentIds: ["IWS1", "IWS2"],
    filename: "stairs.md",
    ...extra,
  });

  it("streams the report stages, stores it and answers reportDone", async () => {
    const db = createReportsStore();
    app = await createServer({ provider: reportProvider(), db });
    const client = await connect(app.port);
    client.send(request());
    const done = await client.until((f) => f.type === "reportDone");
    expect(client.frames.filter((f) => f.type === "reportStatus").map((f) => f.stage)).toEqual([
      "drafting",
      "writing",
      "reviewing",
      "done",
    ]);
    expect(done).toMatchObject({
      thread: "t1",
      requestId: "r1",
      report: {
        filename: "stairs.md",
        version: 1,
        title: "Smoke on the stairs",
        citations: [
          { evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } },
          { evidence: 2, locator: { document: "IWS2", page: 2, paragraph: 4 } },
        ],
        checks: { sentences: 2, supported: 2 },
      },
    });
    expect(db.reports[0]).toMatchObject({ user_id: "laptop", document_ids: ["IWS1", "IWS2"] });
    client.ws.close();
  });

  it("stores an edit as version 2, lists, reads and deletes the report over HTTP", async () => {
    const db = createReportsStore();
    app = await createServer({ provider: reportProvider(), db });
    const client = await connect(app.port);
    client.send(request());
    await client.until((f) => f.type === "reportDone" && f.requestId === "r1");
    client.send(request({ requestId: "r2", topic: "Say more about the lift.", documentIds: [] }));
    const second = await client.until((f) => f.type === "reportDone" && f.requestId === "r2");
    expect(second.report.version).toBe(2);
    client.ws.close();

    const base = `http://127.0.0.1:${app.port}/reports`;
    const list = await fetch(base);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({
      reports: [
        {
          filename: "stairs.md",
          title: "Smoke on the stairs",
          versions: [1, 2],
          updatedAt: expect.any(String),
        },
      ],
    });
    const { versions } = await (await fetch(`${base}/stairs.md`)).json();
    expect(versions.map((v) => [v.version, v.changePrompt])).toEqual([
      [1, null],
      [2, "Say more about the lift."],
    ]);
    expect(versions[1].documentIds).toEqual(["IWS1", "IWS2"]);
    expect(versions[1].bodyMarkdown).toMatch(/^# Smoke on the stairs\n\n## The stairs\n\n/);

    expect((await fetch(`${base}/Stairs.md`)).status).toBe(400);
    expect((await fetch(`${base}/stairs.md`, { method: "POST" })).status).toBe(405);
    const deleted = await fetch(`${base}/stairs.md`, { method: "DELETE" });
    expect(await deleted.json()).toEqual({ filename: "stairs.md", deleted: 2 });
    expect((await fetch(`${base}/stairs.md`)).status).toBe(404);
  });

  it("answers a report with an error frame when no database is configured", async () => {
    app = await createServer({ provider: reportProvider() });
    const client = await connect(app.port);
    client.send(request());
    expect(await client.until((f) => f.type === "error")).toEqual({
      type: "error",
      thread: "t1",
      requestId: "r1",
      message: "the database is not configured",
    });
    expect((await fetch(`http://127.0.0.1:${app.port}/reports`)).status).toBe(503);
    client.ws.close();
  });

  it("refuses a report frame whose filename is not a lower-case .md name", async () => {
    app = await createServer({ provider: reportProvider(), db: createReportsStore() });
    const client = await connect(app.port);
    client.send(request({ filename: "Stairs.MD" }));
    const error = await client.until((f) => f.type === "error");
    expect(error.message).toMatch(/filename/);
    client.ws.close();
  });
});
