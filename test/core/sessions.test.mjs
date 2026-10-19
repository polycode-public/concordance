// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "../../packages/core/prompt.mjs";
import {
  conversationTurns,
  isUuid,
  listConversations,
  recordSession,
  recordTurn,
  sessionIdFor,
  storedFrames,
  TURN_PAGE,
} from "../../packages/core/sessions.mjs";

const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";

function recordingDb(answer = () => ({ rows: [] })) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return answer(text, params);
    },
  };
}

describe("the session log", () => {
  it("names one UUID per connection id", () => {
    const id = sessionIdFor("Zx9abcDEF=");
    expect(isUuid(id)).toBe(true);
    expect(sessionIdFor("Zx9abcDEF=")).toBe(id);
    expect(sessionIdFor("other")).not.toBe(id);
  });

  it("joins consecutive token frames of a turn and keeps every other frame in order", () => {
    const frames = [
      { type: "status", thread: "t", turnId: "u", stage: "answering" },
      { type: "token", thread: "t", turnId: "u", text: "The " },
      { type: "token", thread: "t", turnId: "u", text: "stairs" },
      { type: "status", thread: "t", turnId: "u", stage: "checking" },
      { type: "token", thread: "t", turnId: "u", text: "." },
    ];
    expect(storedFrames(frames)).toEqual([
      frames[0],
      { type: "token", thread: "t", turnId: "u", text: "The stairs" },
      frames[3],
      frames[4],
    ]);
  });

  it("writes a session once and refuses an id that is not a UUID", async () => {
    const db = recordingDb();
    await recordSession(db, { id: SESSION, userId: "laptop" });
    expect(db.calls[0].text).toMatch(/INSERT INTO sessions .* ON CONFLICT \(id\) DO NOTHING/);
    expect(db.calls[0].params).toEqual([SESSION, "laptop"]);
    await expect(recordSession(db, { id: "c1", userId: "laptop" })).rejects.toThrow(/UUID/);
    await expect(recordSession(db, { id: SESSION, userId: undefined })).rejects.toThrow(/user/);
  });

  it("writes a finished turn with its result, and a cancelled one without", async () => {
    const db = recordingDb();
    const frames = [{ type: "done", thread: "t", turnId: "u", checks: {}, citations: [] }];
    await recordTurn(db, {
      sessionId: SESSION,
      thread: "t",
      turnId: "u",
      userText: "Dark?",
      result: {
        answer: "Dark [E1].",
        abstained: false,
        checks: { model: "m1", promptVersion: "p9", supported: 1 },
      },
      frames,
    });
    await recordTurn(db, {
      sessionId: SESSION,
      thread: "t",
      turnId: "v",
      userText: "Again?",
      result: null,
      frames: [{ type: "cancelled", thread: "t", turnId: "v" }],
    });
    expect(db.calls[0].text).toMatch(/\$8::jsonb, \$9::jsonb\)/);
    expect(db.calls[0].params).toEqual([
      SESSION,
      "t",
      "u",
      "Dark?",
      "p9",
      "m1",
      "Dark [E1].",
      JSON.stringify({ model: "m1", promptVersion: "p9", supported: 1, abstained: false }),
      JSON.stringify(frames),
    ]);
    expect(db.calls[1].params.slice(4)).toEqual([
      PROMPT_VERSION,
      null,
      null,
      "{}",
      JSON.stringify([{ type: "cancelled", thread: "t", turnId: "v" }]),
    ]);
  });

  it("lists a user's conversations newest first, at most 100", async () => {
    const db = recordingDb(() => ({
      rows: [
        {
          session_id: SESSION,
          thread: "t",
          first_question: "Dark?",
          turn_count: 2,
          last_turn_at: "2026-10-19T09:30:00.000Z",
        },
      ],
    }));
    expect(await listConversations(db, "sub-1")).toEqual([
      {
        sessionId: SESSION,
        thread: "t",
        firstQuestion: "Dark?",
        lastTurnAt: "2026-10-19T09:30:00.000Z",
        turnCount: 2,
      },
    ]);
    expect(db.calls[0].text).toMatch(/FROM conversations\s+WHERE user_id = \$1/);
    expect(db.calls[0].text).toMatch(/ORDER BY last_turn_at DESC\s+LIMIT 100/);
    expect(db.calls[0].params).toEqual(["sub-1"]);
  });

  it("reads a session's turns only for its owner", async () => {
    const frames = [{ type: "token", thread: "t", turnId: "u", text: "x" }];
    const db = recordingDb((text, params) => {
      if (/FROM sessions/.test(text)) return { rows: params[1] === "sub-1" ? [{}] : [] };
      return {
        rows: [
          {
            thread: "t",
            turn_id: "u",
            user_text: "Dark?",
            prompt_version: "p9",
            model_id: "m1",
            frames,
            created_at: "2026-10-19T09:30:00.000Z",
          },
        ],
      };
    });
    expect(await conversationTurns(db, { sessionId: SESSION, userId: "sub-2" })).toBeNull();
    expect(
      await conversationTurns(db, { sessionId: SESSION, userId: "sub-1", thread: "t" }),
    ).toEqual({
      sessionId: SESSION,
      turns: [
        {
          thread: "t",
          turnId: "u",
          userText: "Dark?",
          promptVersion: "p9",
          modelId: "m1",
          createdAt: "2026-10-19T09:30:00.000Z",
          frames,
        },
      ],
    });
    expect(db.calls.at(-1).params).toEqual([SESSION, "t", "0"]);
    await expect(conversationTurns(db, { sessionId: "x", userId: "sub-1" })).rejects.toThrow(
      /UUID/,
    );
  });

  it("reads a long thread in pages of TURN_PAGE turns in row order", async () => {
    const total = TURN_PAGE * 2 + 3;
    const all = Array.from({ length: total }, (_, i) => ({
      id: String(100 + i * 2),
      thread: "t",
      turn_id: `u${i}`,
      user_text: `Q${i}`,
      prompt_version: "p9",
      model_id: "m1",
      frames: [],
      created_at: "2026-10-19T09:30:00.000Z",
    }));
    const db = recordingDb((text, params) => {
      if (/FROM sessions/.test(text)) return { rows: [{}] };
      const after = Number(params[2]);
      return { rows: all.filter((r) => Number(r.id) > after).slice(0, TURN_PAGE) };
    });
    const { turns } = await conversationTurns(db, { sessionId: SESSION, userId: "u", thread: "t" });
    expect(turns.map((t) => t.turnId)).toEqual(all.map((r) => r.turn_id));
    const reads = db.calls.filter((c) => /FROM session_turns/.test(c.text));
    expect(reads).toHaveLength(3);
    expect(reads.map((c) => c.params[2])).toEqual(["0", "118", "138"]);
    expect(reads[0].text).toMatch(/ORDER BY id\s+LIMIT 10/);
  });
});
