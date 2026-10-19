// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// POST /export on the HTTP API: renders one thread of the signed-in user's session as
// Markdown and writes it to notes/ in the corpus bucket. The gateway's JWT authorizer checks
// the Cognito id token before this runs; its `sub` names the user.

import { InvalidThread, NothingToExport, exportConversation } from "../core/export.mjs";
import { isUuid } from "../core/sessions.mjs";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/**
 * @param {{ openDb: () => Promise<{ query: Function, close?: Function }>,
 *   notes: { put: (key: string, body: string) => Promise<void>, presign: (key: string) => Promise<string> },
 *   corpus: { id: string, title: string }, now?: () => Date }} deps
 */
export function createHandler({ openDb, notes, corpus, now = () => new Date() }) {
  return async function handler(event) {
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) return json(401, { message: "The request has no signed-in user." });
    let body;
    try {
      body = JSON.parse(event.isBase64Encoded ? atob(event.body) : (event.body ?? ""));
    } catch {
      return json(400, { message: "The request body is not JSON." });
    }
    if (!isUuid(body?.sessionId) || typeof body?.thread !== "string") {
      return json(400, { message: "The request needs a sessionId (UUID) and a thread." });
    }
    let db;
    try {
      db = await openDb();
      const result = await exportConversation({
        db,
        which: { sessionId: body.sessionId, userId, thread: body.thread },
        corpus,
        now: now(),
        write: async (key, markdown) => {
          await notes.put(key, markdown);
          return { key, bytes: Buffer.byteLength(markdown), url: await notes.presign(key) };
        },
      });
      return json(200, result);
    } catch (err) {
      if (err instanceof NothingToExport) return json(404, { message: err.message });
      if (err instanceof InvalidThread) return json(400, { message: err.message });
      console.error("export: the write failed", err);
      return json(500, { message: `The document could not be written: ${err.message}` });
    } finally {
      await db?.close?.();
    }
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const { notesBucket, openDatabase } = await import("./clients.mjs");
    realHandler = createHandler({
      openDb: () => openDatabase(),
      notes: notesBucket(),
      corpus: { id: process.env.CORPUS_ID, title: process.env.CORPUS_TITLE },
    });
  }
  return realHandler(event);
}
