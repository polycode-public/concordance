// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The conversations drawer: this user's conversations by last turn, and replay. A replay feeds
// each stored frame through the page's own onFrame, so it renders as the live turn did.

/**
 * @typedef {{ thread: string, turnId: string, userText: string, frames: object[] }} StoredTurn
 */

/**
 * Replays stored turns in order: `begin` opens a turn, every frame goes to `onFrame`, `end`
 * closes it.
 * @param {StoredTurn[]} turns
 * @param {{ begin: (turn: StoredTurn) => void, onFrame: (frame: object) => void,
 *   end: (turn: StoredTurn) => void }} page
 */
export function replayTurns(turns, { begin, onFrame, end }) {
  for (const turn of turns) {
    begin(turn);
    for (const frame of turn.frames) onFrame(frame);
    end(turn);
  }
}

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const turnsLabel = (n) => (n === 1 ? "1 turn" : `${n} turns`);

/**
 * Wires the drawer to the header button.
 * @param {{ conversationsUrl?: string }} config
 * @param {{ token: () => string | null, replay: (turns: StoredTurn[]) => void,
 *   startNew: () => void }} page
 */
export function mountConversations(config, { token, replay, startNew }) {
  const base = config.conversationsUrl;
  if (typeof base !== "string") throw new Error("config.json has no conversationsUrl");
  const drawer = $("conversations");
  const list = $("conversations-list");
  const message = $("conversations-message");
  const opener = $("conversations-open");

  const get = async (url) => {
    const bearer = token();
    const res = await fetch(url, {
      cache: "no-store",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    if (!res.ok) throw new Error(`the conversations route answered ${res.status}`);
    return res.json();
  };

  const close = () => {
    drawer.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    opener.focus();
  };

  const fail = (err) => {
    console.error(err);
    message.textContent = `The conversations could not be read (${err.message}); try again.`;
  };

  async function choose({ sessionId, thread }) {
    message.textContent = "";
    try {
      const url = `${base}/${encodeURIComponent(sessionId)}?thread=${encodeURIComponent(thread)}`;
      const { turns } = await get(url);
      replay(turns);
      close();
    } catch (err) {
      fail(err);
    }
  }

  function row(conversation) {
    const item = el("li", "conversation-row");
    const button = el("button", "quiet");
    button.type = "button";
    const when = new Date(conversation.lastTurnAt).toLocaleString("en-GB");
    button.append(
      el("span", "first", conversation.firstQuestion),
      el("span", "meta small", `${when} · ${turnsLabel(conversation.turnCount)}`),
    );
    button.addEventListener("click", () => choose(conversation));
    item.append(button);
    return item;
  }

  async function show() {
    drawer.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    message.textContent = "";
    list.replaceChildren();
    try {
      const { conversations } = await get(base);
      list.replaceChildren(
        ...(conversations.length
          ? conversations.map(row)
          : [el("li", "empty small", "No conversation saved yet.")]),
      );
      $("conversations-new").focus();
    } catch (err) {
      fail(err);
    }
  }

  opener.hidden = false;
  opener.addEventListener("click", () => (drawer.hidden ? show() : close()));
  $("conversations-close").addEventListener("click", close);
  $("conversations-new").addEventListener("click", () => {
    startNew();
    close();
  });
  drawer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
}
