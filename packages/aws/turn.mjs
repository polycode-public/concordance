// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The turn function: runs one chat turn, invoked asynchronously by the WebSocket route, and
// posts the same frames in the same order as the laptop server. Nothing can abort a running
// Lambda from outside, so it polls the cancel table and aborts itself when the thread's item
// names another turn or is flagged. At the end it writes the turn, with every frame it posted,
// to the session log.

import { requireKnownCorpus } from "../core/corpora.mjs";
import { serverFrame } from "../core/protocol.mjs";
import { runQuery as defaultRunQuery } from "../core/query.mjs";
import { REWRITE_TURNS } from "../core/retrieval/rewrite.mjs";
import { recordSession, recordTurn, sessionIdFor, threadHistory } from "../core/sessions.mjs";
import { cancelKey } from "./clients.mjs";

const blockFrame = (b) => ({
  evidence: b.evidence,
  documentId: b.documentId,
  locator: b.locator,
  header: b.header,
  text: b.text,
  document: b.document,
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
  return async function handler({ frame, connectionId, domainName, stage, userId }) {
    const { thread, turnId, text, corpus, filters = null } = frame;
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

    const frames = [];
    let queue = Promise.resolve();
    const send = (out) => {
      frames.push(out);
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
    let finished = null;
    try {
      db = await openDb();
      await requireKnownCorpus(db, corpus);
      const history = await threadHistory(db, {
        sessionId: sessionIdFor(connectionId, corpus),
        thread,
        limit: REWRITE_TURNS,
      });
      const provider = await providerFor();
      const result = await runQuery({
        question: text,
        corpus,
        provider,
        db,
        filters,
        history,
        signal,
        onStage: (stageName, tool) => {
          poll();
          if (!live()) return;
          send(
            stageName === "tool"
              ? serverFrame.tool(thread, turnId, tool)
              : serverFrame.status(thread, turnId, stageName),
          );
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
          sessionIdFor(connectionId, corpus),
        ),
      );
      finished = result;
    } catch (err) {
      if (failure) send(serverFrame.error(failure.message, thread, turnId));
      else if (signal.aborted) send(serverFrame.cancelled(thread, turnId));
      else send(serverFrame.error(err.message, thread, turnId));
    } finally {
      await queue;
      if (db) {
        await logTurn(db, { connectionId, userId, corpus, thread, turnId, text, finished, frames });
      }
      await cancels.finish(pk, turnId);
      await db?.close?.();
    }
    if (failure) throw failure;
  };
}

/**
 * Writes the sessions row of the connection in the turn's corpus, once, and the turn's row. The session log is a
 * queue beside the chat: a failed write is logged with its cause and never fails the turn,
 * whose frames have already been posted.
 */
async function logTurn(
  db,
  { connectionId, userId, corpus, thread, turnId, text, finished, frames },
) {
  const sessionId = sessionIdFor(connectionId, corpus);
  try {
    await recordSession(db, { id: sessionId, userId, corpus });
    await recordTurn(db, { sessionId, thread, turnId, userText: text, result: finished, frames });
  } catch (err) {
    console.error(`session log: turn ${turnId} of session ${sessionId} was not written`, err);
  }
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
