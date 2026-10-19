// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// JSON frames over the chat WebSocket. The same frames run on the local ws
// server and on API Gateway.

export const CLIENT_FRAME_TYPES = Object.freeze(["turn", "cancel", "open"]);
export const SERVER_FRAME_TYPES = Object.freeze([
  "status",
  "token",
  "evidence",
  "done",
  "cancelled",
  "error",
  "opened",
]);
export const STAGES = Object.freeze(["rewriting", "retrieving", "answering", "checking"]);

const MAX_TEXT = 8000;

export class ProtocolError extends Error {
  name = "ProtocolError";
}

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 128;

/**
 * Parses and validates one client frame. Throws ProtocolError when the frame is
 * malformed.
 * @param {string | Buffer} json
 * @returns {{ type: 'turn', thread: string, turnId: string, text: string, attachments: unknown[] }
 *   | { type: 'cancel', thread: string, turnId: string }
 *   | { type: 'open', docId: string, locator: unknown }}
 */
export function parseClientFrame(json) {
  let frame;
  try {
    frame = JSON.parse(String(json));
  } catch {
    throw new ProtocolError("frame is not valid JSON");
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new ProtocolError("frame must be a JSON object");
  }
  switch (frame.type) {
    case "turn": {
      if (!isId(frame.thread)) throw new ProtocolError("turn needs a thread id");
      if (!isId(frame.turnId)) throw new ProtocolError("turn needs a turnId");
      if (typeof frame.text !== "string" || !frame.text.trim()) {
        throw new ProtocolError("turn needs non-empty text");
      }
      if (frame.text.length > MAX_TEXT) throw new ProtocolError(`turn text exceeds ${MAX_TEXT}`);
      const attachments = frame.attachments ?? [];
      if (!Array.isArray(attachments)) throw new ProtocolError("attachments must be an array");
      return {
        type: "turn",
        thread: frame.thread,
        turnId: frame.turnId,
        text: frame.text,
        attachments,
      };
    }
    case "cancel":
      if (!isId(frame.thread)) throw new ProtocolError("cancel needs a thread id");
      if (!isId(frame.turnId)) throw new ProtocolError("cancel needs a turnId");
      return { type: "cancel", thread: frame.thread, turnId: frame.turnId };
    case "open":
      if (!isId(frame.docId)) throw new ProtocolError("open needs a docId");
      return { type: "open", docId: frame.docId, locator: frame.locator ?? null };
    default:
      throw new ProtocolError(`unknown frame type ${JSON.stringify(frame.type)}`);
  }
}

/**
 * The facts about a block's document. A cipher-only witness has `title: null` and carries its
 * cipher as `witnessId`.
 * @typedef {{ title: string | null, witnessId: string | null, cipherOnly: boolean,
 *   role: string | null, statementDate: string | null, type: string, pages: number | null }} DocumentFacts
 * @typedef {{ evidence: number, documentId: string, locator: object, header: string | null,
 *   text: string, document: DocumentFacts }} EvidenceFrameBlock
 */

/** Frame builders for server to client. */
export const serverFrame = {
  status: (thread, turnId, stage) => {
    if (!STAGES.includes(stage)) throw new ProtocolError(`unknown stage ${stage}`);
    return { type: "status", thread, turnId, stage };
  },
  token: (thread, turnId, text) => ({ type: "token", thread, turnId, text }),
  evidence: (thread, turnId, blocks) => {
    for (const block of blocks) {
      if (block.document == null || typeof block.document !== "object") {
        throw new ProtocolError(`evidence block ${block.evidence} has no document facts`);
      }
    }
    return { type: "evidence", thread, turnId, blocks };
  },
  done: (thread, turnId, checks, citations = [], sessionId = null) => ({
    type: "done",
    thread,
    turnId,
    checks,
    citations,
    sessionId,
  }),
  cancelled: (thread, turnId) => ({ type: "cancelled", thread, turnId }),
  error: (message, thread, turnId) => ({ type: "error", thread, turnId, message }),
  opened: (docId, { url, title, page, locator }) => ({
    type: "opened",
    docId,
    url,
    title,
    page,
    locator,
  }),
};
