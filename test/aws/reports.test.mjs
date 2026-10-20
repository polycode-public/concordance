// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../../packages/aws/reports.mjs";
import { storeReport } from "../../packages/core/reports.mjs";
import { createReportsStore } from "../core/reportsFakeStore.mjs";

const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";

async function seeded() {
  const db = createReportsStore();
  db.sessions.set(SESSION, "sub-1");
  const report = (userId, title) => ({
    sessionId: SESSION,
    userId,
    filename: "stairs.md",
    title,
    topic: "The stairs",
    documentIds: [],
    body: `# ${title}\n\n## A\n\nDark [E1].`,
    citations: [{ evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } }],
    checks: { sentences: 1, supported: 1 },
    promptVersion: "report-closed-world-v1",
    model: "m",
  });
  await storeReport(db, report("sub-1", "One"));
  await storeReport(db, report("sub-1", "Two"));
  await storeReport(db, report("sub-2", "Theirs"));
  let closed = 0;
  const handler = createHandler({
    openDb: async () => ({ ...db, close: async () => (closed += 1) }),
  });
  return { db, handler, closed: () => closed };
}

const event = (method, filename, sub = "sub-1") => ({
  routeKey: filename === undefined ? `${method} /reports` : `${method} /reports/{filename}`,
  pathParameters: filename === undefined ? undefined : { filename },
  requestContext: {
    http: { method },
    authorizer: sub ? { jwt: { claims: { sub } } } : undefined,
  },
});

const body = (res) => JSON.parse(res.body);

describe("the reports routes", () => {
  it("lists the signed-in user's filenames with their versions", async () => {
    const { handler, closed } = await seeded();
    const res = await handler(event("GET"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body(res)).toEqual({
      reports: [
        {
          filename: "stairs.md",
          title: "Two",
          versions: [1, 2],
          updatedAt: expect.any(String),
        },
      ],
    });
    expect(closed()).toBe(1);
  });

  it("answers every version of one report, oldest first", async () => {
    const { handler } = await seeded();
    const res = await handler(event("GET", "stairs.md"));
    expect(res.statusCode).toBe(200);
    const { filename, versions } = body(res);
    expect(filename).toBe("stairs.md");
    expect(versions.map((v) => [v.version, v.title])).toEqual([
      [1, "One"],
      [2, "Two"],
    ]);
    expect(Object.keys(versions[0]).sort()).toEqual(
      [
        "bodyMarkdown",
        "changePrompt",
        "checks",
        "citations",
        "createdAt",
        "documentIds",
        "filename",
        "id",
        "modelId",
        "promptVersion",
        "sessionId",
        "title",
        "topic",
        "version",
      ].sort(),
    );
  });

  it("deletes every version of the user's report and leaves another user's", async () => {
    const { handler, db } = await seeded();
    const res = await handler(event("DELETE", "stairs.md"));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ filename: "stairs.md", deleted: 2 });
    expect((await handler(event("GET", "stairs.md"))).statusCode).toBe(404);
    expect((await handler(event("DELETE", "stairs.md"))).statusCode).toBe(404);
    expect(db.reports.map((r) => r.user_id)).toEqual(["sub-2"]);
  });

  it("answers 401 without a user, 400 for a bad filename and 404 for another user's", async () => {
    const { handler } = await seeded();
    expect((await handler(event("GET", undefined, null))).statusCode).toBe(401);
    expect((await handler(event("GET", "Stairs.md"))).statusCode).toBe(400);
    expect((await handler(event("GET", "%E0%A4%A"))).statusCode).toBe(400);
    expect((await handler(event("GET", "stairs.md", "sub-3"))).statusCode).toBe(404);
  });

  it("answers 500 with the cause when the store fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler({
      openDb: async () => ({
        query: async () => {
          throw new Error("paused");
        },
      }),
    });
    const res = await handler(event("GET"));
    error.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(body(res).message).toMatch(/paused/);
  });
});
