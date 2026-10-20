// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// GET /reports, GET /reports/{filename} and DELETE /reports/{filename} on the HTTP API: the
// signed-in user's reports, every version of one, and the removal of every version. The
// gateway's JWT authorizer checks the Cognito id token before this runs; its `sub` names the user.

import { reportsResponse } from "../core/reports.mjs";

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
    const raw = event.pathParameters?.filename;
    let filename;
    try {
      filename = raw === undefined ? undefined : decodeURIComponent(raw);
    } catch {
      return json(400, { message: "The filename is not a lower-case .md name." });
    }
    let db;
    try {
      db = await openDb();
      const { status, body } = await reportsResponse(db, { method, filename, userId });
      return json(status, body);
    } catch (err) {
      console.error("reports: the request failed", err);
      return json(500, { message: `The reports could not be read: ${err.message}` });
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
