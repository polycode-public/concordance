// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/wsRoutes.mjs";

const NOW = 1_800_000_000_000;
const DOCS = {
  IWS1: { corpus: "grenfell", title: "Statement of IWS1" },
  IWS2: { corpus: "grenfell", title: null },
};

function setup({ inFlight = {}, objects = ["grenfell/raw/IWS1.pdf"] } = {}) {
  const invoked = [];
  const reports = [];
  const posted = [];
  const started = [];
  const closed = [];
  const handler = createHandler({
    invokeTurn: async (payload) => invoked.push(payload),
    invokeReport: async (payload) => reports.push(payload),
    cancels: {
      start: async (pk, turnId, ttl) => {
        started.push({ pk, turnId, ttl });
        inFlight[pk] = turnId;
      },
      cancel: async (pk, turnId) => inFlight[pk] === turnId,
    },
    postToConnection: async (target, frame) => posted.push({ target, frame }),
    openDb: async () => ({
      query: async (_text, [id]) => ({ rows: DOCS[id] ? [DOCS[id]] : [] }),
      close: async () => closed.push(true),
    }),
    originals: {
      exists: async (key) => objects.includes(key),
      presign: async (key) =>
        `https://bucket.s3.eu-west-2.amazonaws.com/${key}?X-Amz-Signature=sig`,
    },
    now: () => NOW,
  });
  return { handler, invoked, reports, posted, started, closed };
}

const event = (routeKey, body) => ({
  requestContext: {
    routeKey,
    connectionId: "c1",
    domainName: "abc.execute-api.eu-west-2.amazonaws.com",
    stage: "prod",
    authorizer: { principalId: "sub-1", username: "demo" },
  },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

const TARGET = {
  connectionId: "c1",
  domainName: "abc.execute-api.eu-west-2.amazonaws.com",
  stage: "prod",
};

describe("WebSocket routes", () => {
  it("accepts $connect and $disconnect", async () => {
    const { handler, posted } = setup();
    expect(await handler(event("$connect"))).toEqual({ statusCode: 200 });
    expect(await handler(event("$disconnect"))).toEqual({ statusCode: 200 });
    expect(posted).toEqual([]);
  });

  it("records the turn on its thread and invokes the turn function with the frame", async () => {
    const { handler, invoked, started, posted } = setup();
    const res = await handler(
      event("$default", { type: "turn", thread: "t1", turnId: "u1", text: "Dark?" }),
    );
    expect(res).toEqual({ statusCode: 200 });
    expect(started).toEqual([{ pk: "c1#t1", turnId: "u1", ttl: NOW / 1000 + 3600 }]);
    expect(invoked).toEqual([
      {
        frame: { type: "turn", thread: "t1", turnId: "u1", text: "Dark?", attachments: [] },
        ...TARGET,
        userId: "sub-1",
      },
    ]);
    expect(posted).toEqual([]);
  });

  it("invokes the report function with the report frame and the user", async () => {
    const { handler, invoked, reports, started, posted } = setup();
    const frame = {
      type: "report",
      thread: "t1",
      requestId: "r1",
      topic: "The stairs",
      documentIds: ["IWS1"],
      filename: "stairs.md",
    };
    expect(await handler(event("$default", frame))).toEqual({ statusCode: 200 });
    expect(reports).toEqual([{ frame, ...TARGET, userId: "sub-1" }]);
    expect(invoked).toEqual([]);
    expect(started).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("flags an in-flight turn on cancel and posts nothing; the turn function answers", async () => {
    const { handler, posted } = setup({ inFlight: { "c1#t1": "u1" } });
    await handler(event("$default", { type: "cancel", thread: "t1", turnId: "u1" }));
    expect(posted).toEqual([]);
  });

  it("answers cancelled at once when the turn is not in flight", async () => {
    const { handler, posted } = setup({ inFlight: { "c1#t1": "u2" } });
    await handler(event("$default", { type: "cancel", thread: "t1", turnId: "u1" }));
    expect(posted).toEqual([
      { target: TARGET, frame: { type: "cancelled", thread: "t1", turnId: "u1" } },
    ]);
  });

  it("answers an open frame with a presigned URL, the title and the page", async () => {
    const { handler, posted, closed, invoked } = setup();
    await handler(
      event("$default", { type: "open", docId: "IWS1", locator: { page: 3, paragraph: 11 } }),
    );
    expect(posted).toEqual([
      {
        target: TARGET,
        frame: {
          type: "opened",
          docId: "IWS1",
          url: "https://bucket.s3.eu-west-2.amazonaws.com/grenfell/raw/IWS1.pdf?X-Amz-Signature=sig",
          title: "Statement of IWS1",
          page: 3,
          locator: { page: 3, paragraph: 11 },
        },
      },
    ]);
    expect(closed).toHaveLength(1);
    expect(invoked).toEqual([]);
  });

  it("answers an open frame for a document without an original with an error frame", async () => {
    const { handler, posted } = setup();
    await handler(event("$default", { type: "open", docId: "IWS2", locator: null }));
    await handler(event("$default", { type: "open", docId: "NOPE", locator: null }));
    expect(posted.map((p) => p.frame)).toEqual([
      { type: "error", message: "no original PDF for IWS2" },
      { type: "error", message: "no original PDF for NOPE" },
    ]);
  });

  it("answers a malformed frame with an error frame", async () => {
    const { handler, posted, invoked } = setup();
    expect(await handler(event("$default", "{not json"))).toEqual({ statusCode: 200 });
    await handler(event("$default", { type: "turn", thread: "t1", turnId: "u1", text: " " }));
    expect(posted.map((p) => p.frame)).toEqual([
      { type: "error", message: "frame is not valid JSON" },
      { type: "error", message: "turn needs non-empty text" },
    ]);
    expect(invoked).toEqual([]);
  });
});
