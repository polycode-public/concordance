// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { replayTurns } from "../../packages/ui/conversations.js";

describe("the replay of a stored conversation", () => {
  it("opens each turn, feeds its frames to onFrame in order, then closes it", () => {
    const turns = [
      {
        thread: "t1",
        turnId: "u1",
        userText: "First?",
        frames: [
          { type: "status", turnId: "u1", stage: "retrieving" },
          { type: "token", turnId: "u1", text: "Yes [E1]." },
          { type: "done", turnId: "u1", checks: {}, citations: [] },
        ],
      },
      {
        thread: "t1",
        turnId: "u2",
        userText: "Second?",
        frames: [{ type: "cancelled", turnId: "u2" }],
      },
    ];
    const seen = [];
    replayTurns(turns, {
      begin: (turn) => seen.push(["begin", turn.turnId, turn.userText]),
      onFrame: (frame) => seen.push(["frame", frame.turnId, frame.type]),
      end: (turn) => seen.push(["end", turn.turnId]),
    });
    expect(seen).toEqual([
      ["begin", "u1", "First?"],
      ["frame", "u1", "status"],
      ["frame", "u1", "token"],
      ["frame", "u1", "done"],
      ["end", "u1"],
      ["begin", "u2", "Second?"],
      ["frame", "u2", "cancelled"],
      ["end", "u2"],
    ]);
  });
});
