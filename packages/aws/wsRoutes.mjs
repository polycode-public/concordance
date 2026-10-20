// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The WebSocket API routes: $connect, $disconnect and $default. A Lambda integration answers
// within 29 seconds, so a turn runs in the turn function and a report in the report function,
// each invoked asynchronously; cancel is a flag in the cancel table that the turn function polls.

import { ProtocolError, parseClientFrame, serverFrame } from "../core/protocol.mjs";
import { cancelKey } from "./clients.mjs";
import { isSafeId, originalKey } from "./doc.mjs";

const TTL_SECONDS = 3600;

/**
 * @param {object} deps
 * @param {(payload: object) => Promise<void>} deps.invokeTurn
 * @param {(payload: object) => Promise<void>} deps.invokeReport
 * @param {{ start: Function, cancel: Function }} deps.cancels
 * @param {(target: object, frame: object) => Promise<void>} deps.postToConnection
 * @param {() => Promise<{ query: Function, close?: Function }>} deps.openDb
 * @param {{ exists: (key: string) => Promise<boolean>, presign: (key: string) => Promise<string> }} deps.originals
 * @param {() => number} [deps.now]
 */
export function createHandler({
  invokeTurn,
  invokeReport,
  cancels,
  postToConnection,
  openDb,
  originals,
  now = Date.now,
}) {
  async function openDocument(send, { docId, locator }) {
    try {
      if (!isSafeId(docId)) throw new Error(`unsafe document id ${JSON.stringify(docId)}`);
      const db = await openDb();
      let rows;
      try {
        ({ rows } = await db.query("SELECT corpus, title FROM documents WHERE id = $1", [docId]));
      } finally {
        await db.close?.();
      }
      if (!rows.length) throw new Error(`no original PDF for ${docId}`);
      const { corpus, title } = rows[0];
      if (!isSafeId(corpus)) throw new Error(`document ${docId} has an unsafe corpus name`);
      const key = originalKey(corpus, docId);
      if (!(await originals.exists(key))) throw new Error(`no original PDF for ${docId}`);
      const page = Number.isInteger(locator?.page) && locator.page > 0 ? locator.page : 1;
      await send(
        serverFrame.opened(docId, {
          url: await originals.presign(key),
          title: title ?? docId,
          page,
          locator,
        }),
      );
    } catch (err) {
      await send(serverFrame.error(err.message));
    }
  }

  return async function handler(event) {
    const { routeKey, connectionId, domainName, stage } = event.requestContext;
    if (routeKey === "$connect" || routeKey === "$disconnect") return { statusCode: 200 };

    const target = { connectionId, domainName, stage };
    const send = (frame) => postToConnection(target, frame);
    let frame;
    try {
      frame = parseClientFrame(event.body ?? "");
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      await send(serverFrame.error(err.message));
      return { statusCode: 200 };
    }

    if (frame.type === "turn") {
      const ttl = Math.floor(now() / 1000) + TTL_SECONDS;
      await cancels.start(cancelKey(connectionId, frame.thread), frame.turnId, ttl);
      const userId = event.requestContext.authorizer?.principalId;
      await invokeTurn({ frame, connectionId, domainName, stage, userId });
    } else if (frame.type === "report") {
      const userId = event.requestContext.authorizer?.principalId;
      await invokeReport({ frame, connectionId, domainName, stage, userId });
    } else if (frame.type === "cancel") {
      const flagged = await cancels.cancel(cancelKey(connectionId, frame.thread), frame.turnId);
      if (!flagged) await send(serverFrame.cancelled(frame.thread, frame.turnId));
    } else {
      await openDocument(send, frame);
    }
    return { statusCode: 200 };
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const {
      cancelTable,
      connectionPoster,
      openDatabase,
      originalsBucket,
      reportInvoker,
      turnInvoker,
    } = await import("./clients.mjs");
    realHandler = createHandler({
      invokeTurn: turnInvoker(),
      invokeReport: reportInvoker(),
      cancels: cancelTable(),
      postToConnection: connectionPoster(),
      openDb: () => openDatabase(),
      originals: originalsBucket(),
    });
  }
  return realHandler(event);
}
