// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../../packages/aws/conversations.mjs";

const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
const FRAMES = [{ type: "done", thread: "t1", turnId: "u1", checks: {}, citations: [] }];

function fakeDb({ owner = "sub-1", fail } = {}) {
  const db = {
    calls: [],
    closed: 0,
    query: async (text, params) => {
      db.calls.push({ text, params });
      if (fail) throw new Error(fail);
      if (/FROM conversations/.test(text)) {
        return {
          rows: [
            {
              session_id: SESSION,
              thread: "t1",
              first_question: "Were the stairs dark?",
              turn_count: 1,
              last_turn_at: "2026-10-19T09:30:00.000Z",
            },
          ],
        };
      }
      if (/FROM sessions/.test(text)) {
        return { rows: params[1] === owner && params[2] === "grenfell" ? [{}] : [] };
      }
      return {
        rows: [
          {
            thread: "t1",
            turn_id: "u1",
            user_text: "Were the stairs dark?",
            prompt_version: "p1",
            model_id: "m1",
            frames: FRAMES,
            created_at: "2026-10-19T09:30:00.000Z",
          },
        ],
      };
    },
    close: async () => {
      db.closed += 1;
    },
  };
  return db;
}

const event = ({ id, thread, sub = "sub-1", corpus = "grenfell" } = {}) => ({
  routeKey: id ? "GET /conversations/{id}" : "GET /conversations",
  pathParameters: id ? { id } : undefined,
  queryStringParameters: { ...(thread && { thread }), ...(corpus && { corpus }) },
  requestContext: { authorizer: sub ? { jwt: { claims: { sub } } } : undefined },
});

const setup = (options) => {
  const db = fakeDb(options);
  return { db, handler: createHandler({ openDb: async () => db }) };
};

describe("conversations handler", () => {
  it("lists the signed-in user's conversations in the corpus", async () => {
    const { handler, db } = setup();
    const res = await handler(event());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({
      conversations: [
        {
          sessionId: SESSION,
          thread: "t1",
          firstQuestion: "Were the stairs dark?",
          lastTurnAt: "2026-10-19T09:30:00.000Z",
          turnCount: 1,
        },
      ],
    });
    expect(db.calls[0].params).toEqual(["sub-1", "grenfell"]);
    expect(db.closed).toBe(1);
  });

  it("answers one session's turns with their frames, for one thread", async () => {
    const { handler, db } = setup();
    const res = await handler(event({ id: SESSION, thread: "t1" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: SESSION,
      turns: [
        {
          thread: "t1",
          turnId: "u1",
          userText: "Were the stairs dark?",
          promptVersion: "p1",
          modelId: "m1",
          createdAt: "2026-10-19T09:30:00.000Z",
          frames: FRAMES,
        },
      ],
    });
    expect(db.calls.at(-1).params).toEqual([SESSION, "t1", "0"]);
  });

  it("answers 404 for another user's session, 400 for a bad id, 401 with no user", async () => {
    expect((await setup({ owner: "sub-2" }).handler(event({ id: SESSION }))).statusCode).toBe(404);
    const { handler, db } = setup();
    expect((await handler(event({ id: "c1" }))).statusCode).toBe(400);
    expect((await handler(event({ sub: null }))).statusCode).toBe(401);
    expect((await handler(event({ corpus: null }))).statusCode).toBe(400);
    expect((await handler(event({ corpus: "../raw" }))).statusCode).toBe(400);
    expect(db.calls).toEqual([]);
    expect((await handler(event({ id: SESSION, corpus: "ucpi" }))).statusCode).toBe(404);
  });

  it("answers 500 with a message when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, db } = setup({ fail: "the cluster is resuming" });
    const res = await handler(event());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).message).toMatch(/the cluster is resuming/);
    expect(db.closed).toBe(1);
  });
});
