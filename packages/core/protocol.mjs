// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// JSON frames over the chat WebSocket. The same frames run on the local ws
// server and on API Gateway. A turn, a report and an open each name the corpus they read.
import { isCorpusId } from "./corpora.mjs";

export const CLIENT_FRAME_TYPES = Object.freeze(["turn", "cancel", "open", "report"]);
export const SERVER_FRAME_TYPES = Object.freeze([
  "status",
  "tool",
  "token",
  "evidence",
  "done",
  "cancelled",
  "error",
  "opened",
  "reportStatus",
  "reportDone",
]);
export const STAGES = Object.freeze(["rewriting", "retrieving", "answering", "checking"]);
export const REPORT_STAGES = Object.freeze(["drafting", "writing", "reviewing", "done"]);

const MAX_TEXT = 8000;
export const MAX_REPORT_DOCUMENTS = 50;

export const REPORT_FILENAME = /^[a-z0-9][a-z0-9-]*\.md$/;
export const MAX_FILENAME = 128;

/** True when a value can name a stored report. */
export const isReportFilename = (value) =>
  typeof value === "string" && value.length <= MAX_FILENAME && REPORT_FILENAME.test(value);

export class ProtocolError extends Error {
  name = "ProtocolError";
}

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 128;

const corpusOf = (frame) => {
  if (!isCorpusId(frame.corpus)) throw new ProtocolError(`${frame.type} needs a corpus id`);
  return frame.corpus;
};

/**
 * Parses and validates one client frame. Throws ProtocolError when the frame is
 * malformed.
 * @param {string | Buffer} json
 * @returns {{ type: 'turn', thread: string, turnId: string, text: string, attachments: unknown[],
 *     corpus: string }
 *   | { type: 'cancel', thread: string, turnId: string }
 *   | { type: 'open', docId: string, locator: unknown, corpus: string }
 *   | { type: 'report', thread: string, requestId: string, topic: string, documentIds: string[],
 *       filename: string, corpus: string }}
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
        corpus: corpusOf(frame),
      };
    }
    case "cancel":
      if (!isId(frame.thread)) throw new ProtocolError("cancel needs a thread id");
      if (!isId(frame.turnId)) throw new ProtocolError("cancel needs a turnId");
      return { type: "cancel", thread: frame.thread, turnId: frame.turnId };
    case "open":
      if (!isId(frame.docId)) throw new ProtocolError("open needs a docId");
      return {
        type: "open",
        docId: frame.docId,
        locator: frame.locator ?? null,
        corpus: corpusOf(frame),
      };
    case "report": {
      if (!isId(frame.thread)) throw new ProtocolError("report needs a thread id");
      if (!isId(frame.requestId)) throw new ProtocolError("report needs a requestId");
      if (typeof frame.topic !== "string" || !frame.topic.trim()) {
        throw new ProtocolError("report needs a non-empty topic");
      }
      if (frame.topic.length > MAX_TEXT)
        throw new ProtocolError(`report topic exceeds ${MAX_TEXT}`);
      const documentIds = frame.documentIds ?? [];
      if (!Array.isArray(documentIds) || !documentIds.every(isId)) {
        throw new ProtocolError("report documentIds must be an array of document ids");
      }
      if (documentIds.length > MAX_REPORT_DOCUMENTS) {
        throw new ProtocolError(`report names more than ${MAX_REPORT_DOCUMENTS} documents`);
      }
      if (!isReportFilename(frame.filename)) {
        throw new ProtocolError(
          "report needs a filename of lower-case letters, digits and '-', ending .md",
        );
      }
      return {
        type: "report",
        thread: frame.thread,
        requestId: frame.requestId,
        topic: frame.topic,
        documentIds: [...new Set(documentIds)],
        filename: frame.filename,
        corpus: corpusOf(frame),
      };
    }
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
  tool: (thread, turnId, { name, rows }) => {
    if (typeof name !== "string" || !name) throw new ProtocolError("a tool frame needs a name");
    if (!Number.isInteger(rows) || rows < 0) {
      throw new ProtocolError(`tool ${name} needs a row count`);
    }
    return { type: "tool", thread, turnId, name, rows };
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
  reportStatus: (thread, requestId, stage) => {
    if (!REPORT_STAGES.includes(stage)) throw new ProtocolError(`unknown report stage ${stage}`);
    return { type: "reportStatus", thread, requestId, stage };
  },
  reportDone: (
    thread,
    requestId,
    { id, filename, version, title, citations, checks, createdAt },
  ) => ({
    type: "reportDone",
    thread,
    requestId,
    report: { id, filename, version, title, createdAt, citations, checks },
  }),
  reportError: (thread, requestId, message) => ({ type: "error", thread, requestId, message }),
  opened: (docId, { url, title, page, locator }) => ({
    type: "opened",
    docId,
    url,
    title,
    page,
    locator,
  }),
};
