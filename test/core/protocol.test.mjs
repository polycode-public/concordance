// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  CLIENT_FRAME_TYPES,
  ProtocolError,
  SERVER_FRAME_TYPES,
  STAGES,
  parseClientFrame,
  serverFrame,
} from "../../packages/core/protocol.mjs";

describe("protocol constants", () => {
  it("lists the client, server and stage values", () => {
    expect(CLIENT_FRAME_TYPES).toEqual(["turn", "cancel", "open"]);
    expect(SERVER_FRAME_TYPES).toEqual([
      "status",
      "token",
      "evidence",
      "done",
      "cancelled",
      "error",
    ]);
    expect(STAGES).toEqual(["rewriting", "retrieving", "answering", "checking"]);
  });
});

describe("parseClientFrame", () => {
  it("parses a turn and defaults attachments", () => {
    expect(parseClientFrame('{"type":"turn","thread":"t1","turnId":"u1","text":"hi"}')).toEqual({
      type: "turn",
      thread: "t1",
      turnId: "u1",
      text: "hi",
      attachments: [],
    });
  });

  it("parses a cancel", () => {
    expect(parseClientFrame(Buffer.from('{"type":"cancel","thread":"t","turnId":"u"}'))).toEqual({
      type: "cancel",
      thread: "t",
      turnId: "u",
    });
  });

  it("parses an open with a locator", () => {
    expect(parseClientFrame('{"type":"open","docId":"IWS1","locator":{"page":3}}')).toEqual({
      type: "open",
      docId: "IWS1",
      locator: { page: 3 },
    });
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["a JSON array", "[]"],
    ["an unknown type", '{"type":"shout"}'],
    ["a turn without a thread", '{"type":"turn","turnId":"u","text":"x"}'],
    ["a turn with empty text", '{"type":"turn","thread":"t","turnId":"u","text":"  "}'],
    [
      "a turn with non-array attachments",
      '{"type":"turn","thread":"t","turnId":"u","text":"x","attachments":1}',
    ],
    ["a cancel without a turnId", '{"type":"cancel","thread":"t"}'],
    ["an open without a docId", '{"type":"open"}'],
  ])("throws a ProtocolError for %s", (_label, json) => {
    expect(() => parseClientFrame(json)).toThrow(ProtocolError);
  });
});

describe("serverFrame", () => {
  it("builds a status frame for a known stage", () => {
    expect(serverFrame.status("t", "u", "checking")).toEqual({
      type: "status",
      thread: "t",
      turnId: "u",
      stage: "checking",
    });
  });

  it("rejects an unknown stage", () => {
    expect(() => serverFrame.status("t", "u", "thinking")).toThrow(ProtocolError);
  });
});
