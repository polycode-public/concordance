// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

const $ = (id) => document.getElementById(id);
const answerEl = $("answer");
const statusEl = $("status");
const scoreEl = $("score");
const connectionEl = $("connection");
const form = $("ask");
const question = $("question");
const cancelButton = $("cancel");

const thread = "main";
let ws;
let current = null;
let streamed = "";

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.addEventListener("open", () => (connectionEl.textContent = "connected"));
  ws.addEventListener("close", () => {
    connectionEl.textContent = "disconnected; retrying";
    setTimeout(connect, 2000);
  });
  ws.addEventListener("message", (event) => onFrame(JSON.parse(event.data)));
}

function onFrame(frame) {
  if (frame.type === "error" && !frame.turnId) {
    statusEl.textContent = `error: ${frame.message}`;
    return;
  }
  if (frame.turnId !== current) return;
  switch (frame.type) {
    case "status":
      statusEl.textContent = `${frame.stage}…`;
      break;
    case "evidence":
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

function renderChecked(checks) {
  answerEl.replaceChildren(
    ...checks.marks.map((mark) => {
      const span = document.createElement("span");
      span.className = mark.supported ? "supported" : "unsupported";
      span.title = mark.supported ? "cites evidence" : "unsupported";
      span.textContent = `${mark.text} `;
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
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  current = crypto.randomUUID();
  streamed = "";
  answerEl.textContent = "";
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

connect();
