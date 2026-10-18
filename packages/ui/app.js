// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { isExpired, signIn, signOut } from "./auth.js";
import { openPdf, showViewerMessage } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const answerEl = $("answer");
const statusEl = $("status");
const scoreEl = $("score");
const connectionEl = $("connection");
const form = $("ask");
const question = $("question");
const cancelButton = $("cancel");
const evidenceEl = $("evidence");

const thread = "main";
let ws;
let current = null;
let streamed = "";
/** @type {Map<number, { evidence: number, documentId: string, locator: object, header: string }>} */
let blocks = new Map();
let opening = null;

const TAG = /\[E(\d+)\]/g;

/** @type {{ wsUrl: string, httpUrl: string, auth: null | { region: string, userPoolId: string, clientId: string } }} */
let config;

async function loadConfig() {
  const res = await fetch("./config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json answered ${res.status}`);
  return res.json();
}

async function connect() {
  let url = config.wsUrl;
  let token = null;
  if (config.auth) {
    connectionEl.textContent = "signed out";
    token = await signIn(config.auth);
    url = `${url}?token=${encodeURIComponent(token)}`;
  }
  let opened = false;
  ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    opened = true;
    connectionEl.textContent = "connected";
  });
  ws.addEventListener("close", () => {
    // A $connect the authorizer denies closes before it opens.
    if (token && (!opened || isExpired(token))) signOut();
    connectionEl.textContent = "disconnected; retrying";
    setTimeout(connect, 2000);
  });
  ws.addEventListener("message", (event) => onFrame(JSON.parse(event.data)));
}

function onFrame(frame) {
  if (frame.type === "opened") {
    if (frame.docId === opening) openPdf(frame);
    opening = null;
    return;
  }
  if (frame.type === "error" && !frame.turnId) {
    if (opening) {
      showViewerMessage(frame.message);
      opening = null;
    } else {
      statusEl.textContent = `error: ${frame.message}`;
    }
    return;
  }
  if (frame.turnId !== current) return;
  switch (frame.type) {
    case "status":
      statusEl.textContent = `${frame.stage}…`;
      break;
    case "evidence":
      renderEvidence(frame.blocks);
      break;
    case "token":
      streamed += frame.text;
      answerEl.textContent = streamed;
      break;
    case "done":
      renderChecked(frame.checks);
      finish("");
      break;
    case "cancelled":
      answerEl.append(
        Object.assign(document.createElement("span"), {
          className: "interrupted",
          textContent: " interrupted",
        }),
      );
      finish("cancelled");
      break;
    case "error":
      finish(`error: ${frame.message}`);
      break;
  }
}

function chip(block) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = `[E${block.evidence}]`;
  button.title = block.header ?? block.documentId;
  button.addEventListener("click", () => open(block));
  return button;
}

function open(block) {
  if (ws?.readyState !== WebSocket.OPEN) {
    showViewerMessage("Not connected to the server.");
    return;
  }
  opening = block.documentId;
  ws.send(JSON.stringify({ type: "open", docId: block.documentId, locator: block.locator }));
}

function renderEvidence(list) {
  blocks = new Map(list.map((b) => [b.evidence, b]));
  evidenceEl.replaceChildren(
    ...list.map((block) => {
      const item = document.createElement("li");
      const header = Object.assign(document.createElement("span"), {
        className: "chip-header",
        textContent: block.header ?? block.documentId,
      });
      item.append(chip(block), " ", header);
      return item;
    }),
  );
}

/** Splits a sentence into text and citation chips. */
function withChips(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const block = blocks.get(Number(match[1]));
    parts.push(
      block
        ? chip(block)
        : Object.assign(document.createElement("span"), {
            className: "dropped",
            title: "no such evidence block",
            textContent: match[0],
          }),
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderChecked(checks) {
  answerEl.replaceChildren(
    ...checks.marks.map((mark) => {
      const span = document.createElement("span");
      span.className = mark.supported ? "supported" : "unsupported";
      span.title = mark.supported ? "cites evidence" : "unsupported";
      span.append(...withChips(mark.text), " ");
      return span;
    }),
  );
  scoreEl.textContent = `${checks.supported} of ${checks.sentences} sentences supported`;
  scoreEl.classList.toggle("warning", checks.warning);
}

function finish(message) {
  statusEl.textContent = message;
  current = null;
  cancelButton.disabled = true;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  current = crypto.randomUUID();
  streamed = "";
  answerEl.textContent = "";
  blocks = new Map();
  evidenceEl.replaceChildren();
  scoreEl.textContent = "";
  scoreEl.classList.remove("warning");
  cancelButton.disabled = false;
  ws.send(JSON.stringify({ type: "turn", thread, turnId: current, text, attachments: [] }));
});

question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

cancelButton.addEventListener("click", () => {
  if (current) ws.send(JSON.stringify({ type: "cancel", thread, turnId: current }));
});

try {
  config = await loadConfig();
  await connect();
} catch (err) {
  connectionEl.textContent = `cannot start: ${err.message}`;
}
