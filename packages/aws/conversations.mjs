// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// GET /conversations and GET /conversations/{id} on the HTTP API: the signed-in user's
// conversations in the corpus of ?corpus=, and one session's turns with the frames to replay.
// The gateway's JWT authorizer checks the Cognito id token before this runs; its `sub` names
// the user.

import { isCorpusId } from "../core/corpora.mjs";
import { conversationTurns, isUuid, listConversations } from "../core/sessions.mjs";

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
    const sessionId = event.pathParameters?.id;
    if (sessionId !== undefined && !isUuid(sessionId)) {
      return json(400, { message: "The conversation id is not a UUID." });
    }
    const corpus = event.queryStringParameters?.corpus;
    if (!isCorpusId(corpus)) return json(400, { message: "The request needs a corpus." });
    let db;
    try {
      db = await openDb();
      if (sessionId === undefined) {
        return json(200, { conversations: await listConversations(db, { userId, corpus }) });
      }
      const thread = event.queryStringParameters?.thread ?? null;
      const conversation = await conversationTurns(db, { sessionId, userId, corpus, thread });
      if (!conversation) return json(404, { message: "No such conversation." });
      return json(200, conversation);
    } catch (err) {
      console.error("conversations: the read failed", err);
      return json(500, { message: `The conversations could not be read: ${err.message}` });
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
