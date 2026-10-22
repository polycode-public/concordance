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
/** The API Gateway WebSocket message limit is 128 KiB; a frame stays well under it. */
export const MAX_FRAME_BYTES = 96 * 1024;
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

export const MAX_FILTER_WITNESSES = 50;
const MAX_ROLE = 128;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isIsoDate = (v) =>
  typeof v === "string" &&
  ISO_DATE.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * Validates the optional filters of a turn and returns them with empty fields left out, or null
 * when none is set. The shape is
 * `{ witnesses?: string[], role?: string, from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }`:
 * `witnesses` are witness ids, `role` is a substring of the role shown with each document, and
 * `from` and `to` bound the statement date, both ends included.
 * @param {unknown} filters
 * @returns {{ witnesses?: string[], role?: string, from?: string, to?: string } | null}
 */
export function parseTurnFilters(filters) {
  if (filters == null) return null;
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw new ProtocolError("turn filters must be an object");
  }
  const unknown = Object.keys(filters).filter(
    (k) => !["witnesses", "role", "from", "to"].includes(k),
  );
  if (unknown.length) throw new ProtocolError(`unknown turn filter ${unknown[0]}`);
  const out = {};
  if (filters.witnesses != null) {
    if (!Array.isArray(filters.witnesses) || !filters.witnesses.every(isId)) {
      throw new ProtocolError("filter witnesses must be an array of witness ids");
    }
    if (filters.witnesses.length > MAX_FILTER_WITNESSES) {
      throw new ProtocolError(`filter names more than ${MAX_FILTER_WITNESSES} witnesses`);
    }
    if (filters.witnesses.length) out.witnesses = [...new Set(filters.witnesses)];
  }
  if (filters.role != null) {
    if (typeof filters.role !== "string" || filters.role.length > MAX_ROLE) {
      throw new ProtocolError(`filter role must be text of at most ${MAX_ROLE} characters`);
    }
    if (filters.role.trim()) out.role = filters.role.trim();
  }
  for (const end of ["from", "to"]) {
    if (filters[end] == null) continue;
    if (!isIsoDate(filters[end]))
      throw new ProtocolError(`filter ${end} must be a YYYY-MM-DD date`);
    out[end] = filters[end];
  }
  if (out.from && out.to && out.from > out.to) {
    throw new ProtocolError("filter from is after filter to");
  }
  return Object.keys(out).length ? out : null;
}

const corpusOf = (frame) => {
  if (!isCorpusId(frame.corpus)) throw new ProtocolError(`${frame.type} needs a corpus id`);
  return frame.corpus;
};

/**
 * Parses and validates one client frame. Throws ProtocolError when the frame is
 * malformed. A turn may carry `filters` (see parseTurnFilters).
 * @param {string | Buffer} json
 * @returns {{ type: 'turn', thread: string, turnId: string, text: string, attachments: unknown[],
 *     corpus: string, filters: ReturnType<typeof parseTurnFilters> }
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
        filters: parseTurnFilters(frame.filters),
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

/**
 * The evidence frames for the blocks a turn has not sent yet, in order. Each frame stays under
 * MAX_FRAME_BYTES serialized in UTF-8; `sent` holds the evidence numbers already posted and
 * gains the numbers of the blocks returned.
 * @param {string} thread
 * @param {string} turnId
 * @param {EvidenceFrameBlock[]} blocks
 * @param {Set<number>} sent
 */
export function newEvidenceFrames(thread, turnId, blocks, sent) {
  const frames = [];
  let batch = [];
  const flush = () => {
    if (batch.length) frames.push(serverFrame.evidence(thread, turnId, batch));
    batch = [];
  };
  const size = (list) =>
    Buffer.byteLength(JSON.stringify(serverFrame.evidence(thread, turnId, list)));
  for (const block of blocks) {
    if (sent.has(block.evidence)) continue;
    if (size([block]) > MAX_FRAME_BYTES) {
      throw new ProtocolError(
        `evidence block ${block.evidence} is larger than the ${MAX_FRAME_BYTES} byte frame limit`,
      );
    }
    if (batch.length && size([...batch, block]) > MAX_FRAME_BYTES) flush();
    batch.push(block);
    sent.add(block.evidence);
  }
  flush();
  return frames;
}
