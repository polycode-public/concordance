// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The fact-store routes on the HTTP API: GET /facts/groups, /facts/matrix, /facts/timeline and
// /facts/witness/{id}, and POST /facts/override, /facts/accept and /facts/hypothesis. The
// gateway's JWT authorizer checks the Cognito id token before this runs; its `sub` names the
// person who relabels, promotes or tests a hypothesis.

import { factsResponse } from "../core/facts/views.mjs";

export const BODY_LIMIT = 8 * 1024;

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/** @param {{ openDb: () => Promise<{ query: Function, close?: Function }> }} deps */
export function createHandler({ openDb }) {
  return async function handler(event) {
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return json(401, { message: "The request has no signed-in user." });
    const method = event.requestContext?.http?.method ?? event.routeKey?.split(" ")[0];
    const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
    let body;
    if (method === "POST") {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : (event.body ?? "");
      if (Buffer.byteLength(raw) > BODY_LIMIT) {
        return json(413, { message: "The request body is too large." });
      }
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { message: "The request body is not JSON." });
      }
    }
    let db;
    try {
      db = await openDb();
      const { status, body: out } = await factsResponse(db, {
        method,
        path,
        query: event.queryStringParameters ?? {},
        body,
        userId,
      });
      return json(status, out);
    } catch (err) {
      console.error("facts: the request failed", err);
      return json(500, { message: `The facts could not be read: ${err.message}` });
    } finally {
      await db?.close?.();
    }
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const { openDatabase } = await import("./clients.mjs");
    realHandler = createHandler({ openDb: () => openDatabase() });
  }
  return realHandler(event);
}
