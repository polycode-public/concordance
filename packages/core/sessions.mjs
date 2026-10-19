// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The session log: a sessions row per connection, a session_turns row per finished turn with
// every frame the server sent for it, and the reads behind the conversation list and replay.
// The laptop server and the turn function both write through these functions.
import { createHash } from "node:crypto";
import { PROMPT_VERSION } from "./prompt.mjs";

/** The user id of every laptop session; the laptop has no sign-in. */
export const LAPTOP_USER = "laptop";

/** The most conversations the list returns. */
export const MAX_CONVERSATIONS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a value is a UUID in its canonical text form. */
export const isUuid = (value) => typeof value === "string" && UUID.test(value);

/**
 * The session id of an API Gateway connection: a UUID from the SHA-256 of the connection id,
 * so every turn on one connection names the same session without a lookup.
 * @param {string} connectionId
 */
export function sessionIdFor(connectionId) {
  const hex = createHash("sha256").update(`connection:${connectionId}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The frames as they are stored: consecutive token frames of a turn join into one, because
 * the page appends token text and a Data API request is at most 64 KB.
 * @param {object[]} frames
 */
export function storedFrames(frames) {
  const out = [];
  for (const frame of frames) {
    const last = out.at(-1);
    if (frame.type === "token" && last?.type === "token" && last.turnId === frame.turnId) {
      out[out.length - 1] = { ...last, text: last.text + frame.text };
    } else {
      out.push(frame);
    }
  }
  return out;
}

/**
 * Writes the sessions row of a connection. A second write of the same id does nothing.
 * @param {{ query: Function }} db
 * @param {{ id: string, userId: string }} session
 */
export async function recordSession(db, { id, userId }) {
  if (!isUuid(id)) throw new Error(`session id ${JSON.stringify(id)} is not a UUID`);
  if (!userId) throw new Error(`session ${id} has no user id`);
  await db.query(
    "INSERT INTO sessions (id, user_id) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING",
    [id, userId],
  );
}

/**
 * Writes the session_turns row of one finished turn: done, cancelled or error.
 * @param {{ query: Function }} db
 * @param {{ sessionId: string, thread: string, turnId: string, userText: string,
 *   result?: { answer: string, abstained: boolean, checks: object } | null, frames: object[] }} turn
 */
export async function recordTurn(db, { sessionId, thread, turnId, userText, result, frames }) {
  const checks = result ? { ...result.checks, abstained: result.abstained } : {};
  await db.query(
    `INSERT INTO session_turns
       (session_id, thread, turn_id, user_text, prompt_version, model_id, raw_output, checks, frames)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      sessionId,
      thread,
      turnId,
      userText,
      result?.checks?.promptVersion ?? PROMPT_VERSION,
      result?.checks?.model ?? null,
      result?.answer ?? null,
      JSON.stringify(checks),
      JSON.stringify(storedFrames(frames)),
    ],
  );
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * A user's conversations, newest first.
 * @param {{ query: Function }} db
 * @param {string} userId
 */
export async function listConversations(db, userId) {
  const { rows } = await db.query(
    `SELECT session_id::text AS session_id, thread, first_question, turn_count,
            to_char(last_turn_at AT TIME ZONE 'UTC', ${ISO}) AS last_turn_at
       FROM conversations
      WHERE user_id = $1
      ORDER BY last_turn_at DESC
      LIMIT ${MAX_CONVERSATIONS}`,
    [userId],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    thread: r.thread,
    firstQuestion: r.first_question,
    lastTurnAt: r.last_turn_at,
    turnCount: Number(r.turn_count),
  }));
}

/**
 * A session's turns with their frames, oldest first, or null when the session is not the
 * user's. `thread` limits the turns to one conversation.
 * @param {{ query: Function }} db
 * @param {{ sessionId: string, userId: string, thread?: string | null }} which
 */
export async function conversationTurns(db, { sessionId, userId, thread = null }) {
  if (!isUuid(sessionId)) throw new Error(`session id ${JSON.stringify(sessionId)} is not a UUID`);
  const owner = await db.query("SELECT 1 FROM sessions WHERE id = $1::uuid AND user_id = $2", [
    sessionId,
    userId,
  ]);
  if (!owner.rows.length) return null;
  const { rows } = await db.query(
    `SELECT thread, turn_id, user_text, prompt_version, model_id, frames,
            to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at
       FROM session_turns
      WHERE session_id = $1::uuid AND ($2::text IS NULL OR thread = $2::text)
      ORDER BY created_at, id`,
    [sessionId, thread],
  );
  return {
    sessionId,
    turns: rows.map((r) => ({
      thread: r.thread,
      turnId: r.turn_id,
      userText: r.user_text,
      promptVersion: r.prompt_version,
      modelId: r.model_id,
      createdAt: r.created_at,
      frames: r.frames,
    })),
  };
}
