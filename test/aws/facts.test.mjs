// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { beforeEach, describe, expect, it } from "vitest";
import { BODY_LIMIT, createHandler } from "../../packages/aws/facts.mjs";
import { runComparison } from "../../packages/core/facts/compare.mjs";
import { createCompareStore } from "../core/compareFakeStore.mjs";
import { compareProvider, compareSeed } from "../core/compareFixture.mjs";

let store;
let closed;
let handler;

beforeEach(async () => {
  store = createCompareStore(compareSeed());
  await runComparison({
    corpus: "grenfell",
    db: store,
    provider: compareProvider().provider,
    log: () => {},
  });
  closed = 0;
  handler = createHandler({
    openDb: async () => ({ query: store.query, close: async () => (closed += 1) }),
  });
});

const event = (method, path, { query, body, sub = "sub-1", base64 = false } = {}) => ({
  routeKey: `${method} ${path}`,
  rawPath: path,
  queryStringParameters: query,
  body:
    body === undefined
      ? undefined
      : base64
        ? Buffer.from(JSON.stringify(body)).toString("base64")
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  isBase64Encoded: base64,
  requestContext: {
    http: { method, path },
    authorizer: sub ? { jwt: { claims: { sub } } } : undefined,
  },
});

const json = (res) => JSON.parse(res.body);

describe("the facts routes", () => {
  it("answers the matrix of an event and closes the database", async () => {
    const res = await handler(event("GET", "/facts/matrix", { query: { event: "7" } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(json(res).cells).toHaveLength(4);
    expect(closed).toBe(1);
  });

  it("answers the groups, the timeline and a witness", async () => {
    expect(json(await handler(event("GET", "/facts/groups"))).groups).toHaveLength(4);
    expect(json(await handler(event("GET", "/facts/timeline"))).points).toHaveLength(5);
    const witness = await handler(event("GET", "/facts/witness/C123"));
    expect(json(witness).witness).toEqual({ id: "C123", cipherOnly: true, role: "Firefighter" });
  });

  it("records the signed-in user on a relabel and a promotion", async () => {
    const id = store.tables.assertion_comparisons.find((c) => c.assertion_a === "4").id;
    const override = await handler(
      event("POST", "/facts/override", {
        body: { comparisonId: id, label: "unrelated", reason: "Different alarms." },
        base64: true,
      }),
    );
    expect(override.statusCode).toBe(201);
    expect(json(override).comparison).toMatchObject({ decidedBy: "sub-1", label: "unrelated" });
    const accept = await handler(
      event("POST", "/facts/accept", {
        body: { assertionId: "3", sourceCitation: "fixture paragraph" },
        sub: "sub-2",
      }),
    );
    expect(accept.statusCode).toBe(201);
    expect(json(accept).fact).toMatchObject({ promotedBy: "sub-2", assertionId: "3" });
  });

  it("refuses a request with no user, a body that is not JSON and a body over the limit", async () => {
    expect((await handler(event("GET", "/facts/groups", { sub: null }))).statusCode).toBe(401);
    expect((await handler(event("POST", "/facts/accept", { body: "{" }))).statusCode).toBe(400);
    const big = await handler(
      event("POST", "/facts/accept", { body: { text: "x".repeat(BODY_LIMIT) } }),
    );
    expect(big.statusCode).toBe(413);
    expect(closed).toBe(0);
  });

  it("answers 500 with the cause when the store fails", async () => {
    const failing = createHandler({
      openDb: async () => ({
        query: async () => {
          throw new Error("store down");
        },
      }),
    });
    const res = await failing(event("GET", "/facts/groups"));
    expect(res.statusCode).toBe(500);
    expect(json(res).message).toMatch(/store down/);
  });
});
