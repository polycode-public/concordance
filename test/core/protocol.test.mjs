// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  CLIENT_FRAME_TYPES,
  ProtocolError,
  REPORT_STAGES,
  SERVER_FRAME_TYPES,
  STAGES,
  parseClientFrame,
  serverFrame,
} from "../../packages/core/protocol.mjs";

describe("protocol constants", () => {
  it("lists the client, server and stage values", () => {
    expect(CLIENT_FRAME_TYPES).toEqual(["turn", "cancel", "open", "report"]);
    expect(SERVER_FRAME_TYPES).toEqual([
      "status",
      "tool",
      "token",
      "evidence",
      "done",
      "cancelled",
      "error",
      "opened",
      "reportStatus",
      "reportDone",
    ]);
    expect(STAGES).toEqual(["rewriting", "retrieving", "answering", "checking"]);
    expect(REPORT_STAGES).toEqual(["drafting", "writing", "reviewing", "done"]);
  });
});

describe("parseClientFrame", () => {
  it("parses a turn and defaults attachments", () => {
    expect(
      parseClientFrame(
        '{"type":"turn","thread":"t1","turnId":"u1","text":"hi","corpus":"grenfell"}',
      ),
    ).toEqual({
      type: "turn",
      thread: "t1",
      turnId: "u1",
      text: "hi",
      attachments: [],
      corpus: "grenfell",
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
    expect(
      parseClientFrame('{"type":"open","docId":"IWS1","locator":{"page":3},"corpus":"ucpi"}'),
    ).toEqual({
      type: "open",
      docId: "IWS1",
      locator: { page: 3 },
      corpus: "ucpi",
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
    ["an open without a docId", '{"type":"open","corpus":"grenfell"}'],
    ["a turn without a corpus", '{"type":"turn","thread":"t","turnId":"u","text":"x"}'],
    [
      "a turn with a corpus that is not an id",
      '{"type":"turn","thread":"t","turnId":"u","text":"x","corpus":"../raw"}',
    ],
    ["an open without a corpus", '{"type":"open","docId":"IWS1"}'],
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

describe("the tool frame", () => {
  it("names the tool and its row count", () => {
    expect(serverFrame.tool("t", "u", { name: "count_assertions", rows: 3 })).toEqual({
      type: "tool",
      thread: "t",
      turnId: "u",
      name: "count_assertions",
      rows: 3,
    });
  });

  it("rejects a frame without a name or a whole row count", () => {
    expect(() => serverFrame.tool("t", "u", { name: "", rows: 1 })).toThrow(ProtocolError);
    expect(() => serverFrame.tool("t", "u", { name: "x", rows: -1 })).toThrow(ProtocolError);
    expect(() => serverFrame.tool("t", "u", { name: "x", rows: 1.5 })).toThrow(ProtocolError);
  });
});

describe("the evidence frame", () => {
  it("refuses a block without document facts", () => {
    expect(() => serverFrame.evidence("t", "u", [{ evidence: 1 }])).toThrow(ProtocolError);
  });
});

describe("the report frames", () => {
  const report = (extra = {}) =>
    JSON.stringify({
      type: "report",
      thread: "t1",
      requestId: "r1",
      topic: "What the residents saw on the stairs",
      documentIds: ["IWS1", "IWS2", "IWS1"],
      filename: "stairs.md",
      corpus: "grenfell",
      ...extra,
    });

  it("parses a report request and drops repeated document ids", () => {
    expect(parseClientFrame(report())).toEqual({
      type: "report",
      thread: "t1",
      requestId: "r1",
      topic: "What the residents saw on the stairs",
      documentIds: ["IWS1", "IWS2"],
      filename: "stairs.md",
      corpus: "grenfell",
    });
    expect(parseClientFrame(report({ documentIds: undefined })).documentIds).toEqual([]);
    expect(() => parseClientFrame(report({ corpus: undefined }))).toThrow(/report needs a corpus/);
  });

  it("refuses a report without a topic, a request id or a lower-case .md filename", () => {
    expect(() => parseClientFrame(report({ topic: " " }))).toThrow(/topic/);
    expect(() => parseClientFrame(report({ requestId: "" }))).toThrow(/requestId/);
    for (const filename of ["Stairs.md", "stairs.txt", "../stairs.md", undefined])
      expect(() => parseClientFrame(report({ filename }))).toThrow(/filename/);
    expect(() => parseClientFrame(report({ documentIds: "IWS1" }))).toThrow(/documentIds/);
    expect(() => parseClientFrame(report({ documentIds: [3] }))).toThrow(/documentIds/);
    const many = Array.from({ length: 51 }, (_, i) => `D${i}`);
    expect(() => parseClientFrame(report({ documentIds: many }))).toThrow(/more than 50/);
  });

  it("builds the status, done and error frames of a report", () => {
    expect(serverFrame.reportStatus("t1", "r1", "drafting")).toEqual({
      type: "reportStatus",
      thread: "t1",
      requestId: "r1",
      stage: "drafting",
    });
    expect(() => serverFrame.reportStatus("t1", "r1", "answering")).toThrow(ProtocolError);
    const citations = [{ evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } }];
    expect(
      serverFrame.reportDone("t1", "r1", {
        id: "7",
        filename: "stairs.md",
        version: 2,
        title: "T",
        citations,
        checks: { sentences: 1 },
        createdAt: "2026-10-20T09:00:00.000Z",
        body: "not sent",
      }),
    ).toEqual({
      type: "reportDone",
      thread: "t1",
      requestId: "r1",
      report: {
        id: "7",
        filename: "stairs.md",
        version: 2,
        title: "T",
        createdAt: "2026-10-20T09:00:00.000Z",
        citations,
        checks: { sentences: 1 },
      },
    });
    expect(serverFrame.reportError("t1", "r1", "boom")).toEqual({
      type: "error",
      thread: "t1",
      requestId: "r1",
      message: "boom",
    });
  });
});
