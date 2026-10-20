// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The report function: runs one report request, invoked asynchronously by the WebSocket route,
// and posts its stage and done frames. A closed connection stops the frames and never the
// report, which the page lists from GET /reports when it comes back.

import { requireKnownCorpus } from "../core/corpora.mjs";
import { serverFrame } from "../core/protocol.mjs";
import { reportScores, requestReport as defaultRequestReport } from "../core/reports.mjs";
import { recordSession, sessionIdFor } from "../core/sessions.mjs";

/**
 * @param {object} deps
 * @param {() => Promise<import('../core/providers/modelProvider.mjs').ModelProvider>} deps.providerFor
 * @param {() => Promise<{ query: Function, close?: Function }>} deps.openDb
 * @param {(target: object, frame: object) => Promise<void>} deps.postToConnection
 * @param {typeof defaultRequestReport} [deps.requestReport]
 */
export function createHandler({
  providerFor,
  openDb,
  postToConnection,
  requestReport = defaultRequestReport,
}) {
  return async function handler({ frame, connectionId, domainName, stage, userId }) {
    const { thread, requestId, corpus } = frame;
    const target = { connectionId, domainName, stage };
    let gone = false;
    let queue = Promise.resolve();
    let postFailure = null;
    const send = (out) => {
      queue = queue.then(async () => {
        if (gone || postFailure) return;
        try {
          await postToConnection(target, out);
        } catch (err) {
          if (err?.name === "GoneException") gone = true;
          else postFailure = err;
        }
      });
    };

    let db;
    try {
      if (!userId) throw new Error("the report request has no signed-in user");
      db = await openDb();
      await requireKnownCorpus(db, corpus);
      const provider = await providerFor();
      const sessionId = sessionIdFor(connectionId, corpus);
      await recordSession(db, { id: sessionId, userId, corpus });
      const stored = await requestReport({
        db,
        provider,
        userId,
        sessionId,
        request: frame,
        onStage: (name) => send(serverFrame.reportStatus(thread, requestId, name)),
      });
      send(serverFrame.reportStatus(thread, requestId, "done"));
      send(
        serverFrame.reportDone(thread, requestId, {
          ...stored,
          checks: reportScores(stored.checks),
        }),
      );
    } catch (err) {
      console.error(`report: request ${requestId} of ${frame.filename} failed`, err);
      send(serverFrame.reportError(thread, requestId, err.message));
    } finally {
      await queue;
      await db?.close?.();
    }
    if (postFailure) throw postFailure;
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const { connectionPoster, openDatabase } = await import("./clients.mjs");
    let provider;
    realHandler = createHandler({
      providerFor: async () => {
        if (!provider) {
          const { providerFromEnv } = await import("../core/providers/index.mjs");
          provider = providerFromEnv(process.env);
        }
        return provider;
      },
      openDb: () => openDatabase(),
      postToConnection: connectionPoster(),
    });
  }
  return realHandler(event);
}
