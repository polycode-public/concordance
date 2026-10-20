// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The document from a conversation: a pure render of stored turns to Markdown, and the rules
// for the key the document is written under.

import { conversationTurns } from "./sessions.mjs";

const TAG = /\[E(\d+)\]/g;
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_DEPTH = 4;

/** True when a value can be one segment of a note key. */
export const isNoteSegment = (value) => typeof value === "string" && SEGMENT.test(value);

/** True when a value is a note key: `notes/` and one to three more segments. */
export function isNoteKey(key) {
  if (typeof key !== "string") return false;
  const parts = key.split("/");
  return (
    parts[0] === "notes" &&
    parts.length >= 2 &&
    parts.length <= MAX_DEPTH &&
    parts.slice(1).every(isNoteSegment)
  );
}

/**
 * The key of a conversation document: `notes/<sessionId>/<thread>-<time>.md`, with the time as
 * a lower-case ISO timestamp whose colons are dashes.
 * @param {{ sessionId: string, thread: string, now?: Date }} which
 */
export function noteKey({ sessionId, thread, now = new Date() }) {
  const stamp = now.toISOString().replaceAll(":", "-").toLowerCase();
  const key = `notes/${sessionId}/${thread}-${stamp}.md`;
  if (!isNoteKey(key)) throw new Error(`the note key ${JSON.stringify(key)} is not a valid key`);
  return key;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const locatorText = ({ document, page, paragraph }) =>
  [
    document,
    page != null ? `page ${page}` : null,
    paragraph != null ? `paragraph ${paragraph}` : null,
  ]
    .filter(Boolean)
    .join(", ");

function turnParts(turn) {
  const frames = turn.frames ?? [];
  const answer = frames
    .filter((f) => f.type === "token")
    .map((f) => f.text)
    .join("");
  return {
    answer,
    done: frames.find((f) => f.type === "done") ?? null,
    cancelled: frames.some((f) => f.type === "cancelled"),
    error: frames.find((f) => f.type === "error") ?? null,
  };
}

function scoreLine({ done, cancelled, error }) {
  if (done) {
    const { abstained, supported, sentences, droppedCitations } = done.checks;
    const base = abstained ? "No claim made" : `${supported} of ${sentences} sentences supported`;
    return droppedCitations > 0
      ? `${base}, ${plural(droppedCitations, "citation", "citations")} dropped`
      : base;
  }
  if (cancelled) return "Not completed: interrupted";
  if (error) return `Not completed: ${error.message}`;
  return "Not completed";
}

function renderTurn(turn, index) {
  const n = index + 1;
  const parts = turnParts(turn);
  const citations = new Map((parts.done?.citations ?? []).map((c) => [c.evidence, c.locator]));
  const used = [];
  const unresolved = [];
  const body = parts.answer.replace(TAG, (tag, num) => {
    const evidence = Number(num);
    if (citations.has(evidence)) {
      if (!used.includes(evidence)) used.push(evidence);
      return `[^${n}-E${evidence}]`;
    }
    if (!unresolved.includes(tag)) unresolved.push(tag);
    return `~~${tag}~~`;
  });

  const lines = [`## Turn ${n}`, "", "You asked:", ""];
  lines.push(...turn.userText.split("\n").map((l) => (l ? `> ${l}` : ">")), "");
  if (body) lines.push(body, "");
  if (unresolved.length) lines.push(`Unresolved tags: ${unresolved.join(", ")}`, "");
  lines.push(scoreLine(parts), "");
  lines.push(`Prompt ${turn.promptVersion}, model ${turn.modelId ?? "none"}`, "");
  for (const evidence of used) {
    lines.push(`[^${n}-E${evidence}]: ${locatorText(citations.get(evidence))}`);
  }
  if (used.length) lines.push("");
  return lines;
}

function referencedDocuments(turns) {
  const counts = new Map();
  for (const turn of turns) {
    for (const c of turnParts(turn).done?.citations ?? []) {
      counts.set(c.locator.document, (counts.get(c.locator.document) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Renders the turns of one conversation as Markdown. Footnotes come from the resolved
 * citations of each turn's `done` frame; a tag with no citation is struck through and listed.
 * @param {{ corpus: { title: string }, session: { sessionId: string, thread: string },
 *   turns: { userText: string, promptVersion: string, modelId: string | null,
 *     createdAt?: string, frames: object[] }[] }} input
 */
export function renderConversation({ corpus, session, turns }) {
  const date = (turns[0]?.createdAt ?? "").slice(0, 10);
  const lines = [
    `# ${corpus.title}: conversation ${date}`.trimEnd(),
    "",
    `Session ${session.sessionId}, thread ${session.thread}`,
    "",
  ];
  turns.forEach((turn, i) => lines.push(...renderTurn(turn, i)));
  lines.push("## Referenced documents", "");
  const docs = referencedDocuments(turns);
  if (docs.size === 0) lines.push("None cited in this conversation.");
  for (const [document, count] of docs) {
    lines.push(`- ${document}: ${plural(count, "citation", "citations")}`);
  }
  lines.push("", "## Accepted facts", "", "None promoted in this conversation.", "");
  return lines.join("\n");
}

/** Thrown when the thread name cannot be part of a note key. */
export class InvalidThread extends Error {
  name = "InvalidThread";
}

/** Thrown when the session is not the user's or the thread has no turns. */
export class NothingToExport extends Error {
  name = "NothingToExport";
}

/**
 * Reads a thread, renders it and writes the document through `write`.
 * @param {object} args
 * @param {{ query: Function }} args.db
 * @param {{ sessionId: string, userId: string, thread: string }} args.which
 * @param {{ id: string, title: string }} args.corpus
 * @param {(key: string, markdown: string) => Promise<{ key: string, bytes: number, url: string }>} args.write
 * @param {Date} [args.now]
 */
export async function exportConversation({ db, which, corpus, write, now = new Date() }) {
  const { sessionId, userId, thread } = which;
  if (!isNoteSegment(thread))
    throw new InvalidThread(`The thread name ${JSON.stringify(thread)} cannot be exported.`);
  const conversation = await conversationTurns(db, {
    sessionId,
    userId,
    corpus: corpus.id,
    thread,
  });
  if (!conversation?.turns.length) throw new NothingToExport("This thread has no turns to export.");
  const markdown = renderConversation({
    corpus,
    session: { sessionId, thread },
    turns: conversation.turns,
  });
  return write(noteKey({ sessionId, thread, now }), markdown);
}
