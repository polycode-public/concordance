// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The turn function: runs one chat turn, invoked asynchronously by the WebSocket route, and
// posts the same frames in the same order as the laptop server. Nothing can abort a running
// Lambda from outside, so it polls the cancel table and aborts itself when the thread's item
// names another turn or is flagged.

import { serverFrame } from "../core/protocol.mjs";
import { runQuery as defaultRunQuery } from "../core/query.mjs";
import { cancelKey } from "./clients.mjs";

const blockFrame = (b) => ({
  evidence: b.evidence,
  documentId: b.documentId,
  locator: b.locator,
  header: b.header,
  text: b.text,
});

/**
 * @param {object} deps
 * @param {() => Promise<import('../core/providers/modelProvider.mjs').ModelProvider>} deps.providerFor
 * @param {() => Promise<{ query: Function, close?: Function }>} deps.openDb
 * @param {{ read: Function, finish: Function }} deps.cancels
 * @param {(target: object, frame: object) => Promise<void>} deps.postToConnection
 * @param {() => number} [deps.now]
 * @param {typeof defaultRunQuery} [deps.runQuery]
 * @param {number} [deps.pollMs]
 */
export function createHandler({
  providerFor,
  openDb,
  cancels,
  postToConnection,
  now = Date.now,
  runQuery = defaultRunQuery,
  pollMs = 500,
}) {
  return async function handler({ frame, connectionId, domainName, stage }) {
    const { thread, turnId, text } = frame;
    const target = { connectionId, domainName, stage };
    const pk = cancelKey(connectionId, thread);
    const controller = new AbortController();
    const { signal } = controller;
    const live = () => !signal.aborted;

    let gone = false;
    let failure = null;
    const fail = (err) => {
      failure ??= err;
      controller.abort();
    };

    let queue = Promise.resolve();
    const send = (out) => {
      queue = queue.then(async () => {
        if (gone) return;
        try {
          await postToConnection(target, out);
        } catch (err) {
          if (err?.name !== "GoneException") throw err;
          gone = true;
          controller.abort();
        }
      });
      queue = queue.catch(fail);
    };

    let lastPoll = now();
    let polling = false;
    const poll = () => {
      if (polling || !live() || now() - lastPoll < pollMs) return;
      polling = true;
      lastPoll = now();
      cancels
        .read(pk)
        .then((item) => {
          if (item && (item.turnId !== turnId || item.cancelled)) controller.abort();
        })
        .catch(fail)
        .finally(() => (polling = false));
    };

    let db;
    try {
      db = await openDb();
      const provider = await providerFor();
      const result = await runQuery({
        question: text,
        provider,
        db,
        signal,
        onStage: (stageName) => {
          poll();
          if (live()) send(serverFrame.status(thread, turnId, stageName));
        },
        onEvidence: (blocks) => {
          if (live()) send(serverFrame.evidence(thread, turnId, blocks.map(blockFrame)));
        },
        onToken: (piece) => {
          poll();
          if (live()) send(serverFrame.token(thread, turnId, piece));
        },
      });
      signal.throwIfAborted();
      send(
        serverFrame.done(
          thread,
          turnId,
          { ...result.checks, abstained: result.abstained },
          result.citations,
        ),
      );
    } catch (err) {
      if (failure) send(serverFrame.error(failure.message, thread, turnId));
      else if (signal.aborted) send(serverFrame.cancelled(thread, turnId));
      else send(serverFrame.error(err.message, thread, turnId));
    } finally {
      await queue;
      await cancels.finish(pk, turnId);
      await db?.close?.();
    }
    if (failure) throw failure;
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const { cancelTable, connectionPoster, openDatabase } = await import("./clients.mjs");
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
      cancels: cancelTable(),
      postToConnection: connectionPoster(),
    });
  }
  return realHandler(event);
}
