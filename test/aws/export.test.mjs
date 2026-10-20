// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it, vi } from "vitest";
import { notesBucket } from "../../packages/aws/clients.mjs";
import { createHandler } from "../../packages/aws/export.mjs";

const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
const NOW = new Date("2026-10-19T10:00:00.000Z");
const KEY = `notes/${SESSION}/main-2026-10-19t10-00-00.000z.md`;
const FRAMES = [
  { type: "token", thread: "main", turnId: "u1", text: "Dark [E1]." },
  {
    type: "done",
    thread: "main",
    turnId: "u1",
    checks: { sentences: 1, supported: 1, droppedCitations: 0, abstained: false },
    citations: [{ evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } }],
  },
];

function fakeDb({ owner = "sub-1", turns = 1 } = {}) {
  const db = {
    closed: 0,
    query: async (text, params) => {
      if (/FROM sessions/.test(text)) {
        return { rows: params[1] === owner && params[2] === "grenfell" ? [{}] : [] };
      }
      return {
        rows: Array.from({ length: turns }, () => ({
          thread: "main",
          turn_id: "u1",
          user_text: "Were the stairs dark?",
          prompt_version: "p1",
          model_id: "m1",
          frames: FRAMES,
          created_at: "2026-10-19T09:30:00.000Z",
        })),
      };
    },
    close: async () => {
      db.closed += 1;
    },
  };
  return db;
}

function setup({ db = fakeDb(), put } = {}) {
  const notes = {
    put: put ?? vi.fn(async () => {}),
    presign: vi.fn(async (key) => `https://bucket.s3.amazonaws.com/${key}?X-Amz-Expires=600`),
  };
  const handler = createHandler({
    openDb: async () => db,
    notes,
    corpora: [
      { id: "grenfell", name: "Grenfell Tower Inquiry" },
      { id: "ucpi", name: "Undercover Policing Inquiry" },
    ],
    now: () => NOW,
  });
  const call = (body, sub = "sub-1") =>
    handler({
      requestContext: { authorizer: { jwt: { claims: sub ? { sub } : {} } } },
      body: typeof body === "string" ? body : JSON.stringify({ corpus: "grenfell", ...body }),
    });
  return { db, notes, call };
}

describe("export route", () => {
  it("writes the thread under notes/ and answers the key, the size and a presigned url", async () => {
    const { notes, call, db } = setup();
    const res = await call({ sessionId: SESSION, thread: "main" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(notes.put).toHaveBeenCalledTimes(1);
    const [key, markdown] = notes.put.mock.calls[0];
    expect(key).toBe(KEY);
    expect(markdown).toContain("# Grenfell Tower Inquiry: conversation 2026-10-19");
    expect(markdown).toContain("[^1-E1]: IWS1, page 3, paragraph 11");
    expect(body).toEqual({
      key: KEY,
      bytes: Buffer.byteLength(markdown),
      url: `https://bucket.s3.amazonaws.com/${KEY}?X-Amz-Expires=600`,
    });
    expect(db.closed).toBe(1);
  });

  it("answers 401, 400, 404 without writing", async () => {
    const { notes, call } = setup();
    expect((await call({ sessionId: SESSION, thread: "main" }, null)).statusCode).toBe(401);
    expect((await call("not json")).statusCode).toBe(400);
    expect((await call({ sessionId: "x", thread: "main" })).statusCode).toBe(400);
    expect((await call({ sessionId: SESSION, thread: "../x" })).statusCode).toBe(400);
    expect((await call({ sessionId: SESSION, thread: "main" }, "sub-2")).statusCode).toBe(404);
    expect((await call({ sessionId: SESSION, thread: "main", corpus: "x" })).statusCode).toBe(400);
    expect((await call({ sessionId: SESSION, thread: "main", corpus: "ucpi" })).statusCode).toBe(
      404,
    );
    expect(
      (await setup({ db: fakeDb({ turns: 0 }) }).call({ sessionId: SESSION, thread: "main" }))
        .statusCode,
    ).toBe(404);
    expect(notes.put).not.toHaveBeenCalled();
  });

  it("answers 500 with the cause when the write fails, such as a key that exists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = setup({
      put: async () => {
        throw new Error(`the document ${KEY} already exists`);
      },
    });
    const res = await call({ sessionId: SESSION, thread: "main" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).message).toMatch(/already exists/);
  });
});

describe("notes bucket", () => {
  const env = { CORPUS_BUCKET: "corpus-bucket" };

  it("puts Markdown with If-None-Match so a key is never replaced", async () => {
    const send = vi.fn(async () => ({}));
    await notesBucket(env, 600, { client: { send } }).put(KEY, "# x");
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "corpus-bucket",
      Key: KEY,
      Body: "# x",
      ContentType: "text/markdown; charset=utf-8",
      IfNoneMatch: "*",
    });
  });

  it("reports a key that exists", async () => {
    const send = async () => {
      throw Object.assign(new Error("x"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });
    };
    await expect(notesBucket(env, 600, { client: { send } }).put(KEY, "# x")).rejects.toThrow(
      /already exists/,
    );
  });

  it("presigns a GET for ten minutes that shows as text", async () => {
    const client = { send: async () => ({}) };
    const presign = vi.fn(async () => "https://signed");
    expect(await notesBucket(env, 600, { client, presign }).presign(KEY)).toBe("https://signed");
    const [passed, command, options] = presign.mock.calls[0];
    expect(passed).toBe(client);
    expect(command.input).toEqual({
      Bucket: "corpus-bucket",
      Key: KEY,
      ResponseContentType: "text/plain; charset=utf-8",
    });
    expect(options).toEqual({ expiresIn: 600 });
  });
});
