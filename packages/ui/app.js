// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { currentToken, isExpired, signIn, signOut } from "./auth.js";
import { mountConversations, replayTurns } from "./conversations.js";
import { mountExport } from "./export.js";
import { showSpend } from "./spend.js";
import { chipInline, renderMarkdown } from "./markdown.mjs";
import { closeViewer, openPdf, showViewerMessage } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const turnsEl = $("turns");
const connectionEl = $("connection");
const form = $("ask");
const question = $("question");
const cancelButton = $("cancel");
const documentsEl = $("documents");
const documentsCount = $("documents-count");
const documentsEmpty = $("documents-empty");
const evidenceEl = $("evidence");
const evidenceCount = $("evidence-count");
const evidenceEmpty = $("evidence-empty");

const STAGES = ["rewriting", "retrieving", "answering", "checking"];
/** The conversation: a thread on this connection's session. */
let thread = crypto.randomUUID();

let ws;
/** @type {Turn | null} The turn whose frames are still arriving. */
let current = null;
/** @type {Turn | null} The last turn started; the keys act on its chips. */
let newest = null;
let opening = null;

/**
 * @typedef {{ evidence: number, documentId: string, locator: { page?: number, paragraph?: number },
 *   header?: string | null, text?: string }} Block
 * @typedef {{ id: string, blocks: Map<number, Block>, streamed: string, startedAt: number | null,
 *   article: HTMLElement, stages: HTMLElement, answer: HTMLElement, score: HTMLElement,
 *   note: HTMLElement }} Turn
 */

/** @type {{ ready: (sessionId: string, thread: string) => void, reset: () => void } | null} */
let exporter = null;
let replaying = false;

/** Every document cited this session, by document id. */
const documents = new Map();

/** @type {{ wsUrl: string, httpUrl: string, spendUrl: string, conversationsUrl: string, exportUrl: string, auth: null | { region: string, userPoolId: string, clientId: string } }} */
let config;

async function loadConfig() {
  const res = await fetch("./config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json answered ${res.status}`);
  return res.json();
}

function nameCorpus({ title, subtitle }) {
  const name = `${title}: ${subtitle}`;
  $("corpus-name").textContent = name;
  $("signin-corpus").textContent = name;
  document.title = `Concordance: ${title} ${subtitle}`;
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
    } else if (newest) {
      newest.note.textContent = frame.message;
    } else {
      connectionEl.textContent = frame.message;
    }
    return;
  }
  const turn = current;
  if (!turn || frame.turnId !== turn.id) return;
  switch (frame.type) {
    case "status":
      turn.startedAt ??= performance.now();
      renderStages(turn, frame.stage);
      break;
    case "evidence":
      turn.blocks = new Map(frame.blocks.map((b) => [b.evidence, b]));
      renderEvidence(turn, new Set());
      break;
    case "token":
      turn.streamed += frame.text;
      turn.answer.replaceChildren(
        ...renderMarkdown(
          turn.streamed,
          chipInline((n) => chipOrDropped(turn, n)),
        ),
      );
      break;
    case "done":
      renderChecked(turn, frame.checks);
      finishStages(turn, frame.checks.timings);
      recordCitations(turn, frame.citations ?? []);
      if (!replaying && frame.sessionId) exporter?.ready(frame.sessionId, thread);
      finish(turn, "");
      break;
    case "cancelled":
      turn.answer.append(
        Object.assign(document.createElement("span"), {
          className: "interrupted",
          textContent: " interrupted",
        }),
      );
      finish(turn, "");
      break;
    case "error":
      finish(turn, frame.message);
      break;
  }
}

/** The locator as the trade writes it: the document, its page, its paragraph. */
function reference(block) {
  const parts = [block.documentId];
  if (block.locator?.page != null) parts.push(`p.${block.locator.page}`);
  if (block.locator?.paragraph != null) parts.push(`¶${block.locator.paragraph}`);
  return parts.join(" ");
}

function referenceName(block) {
  const parts = [block.documentId];
  if (block.locator?.page != null) parts.push(`page ${block.locator.page}`);
  if (block.locator?.paragraph != null) parts.push(`paragraph ${block.locator.paragraph}`);
  return `Evidence ${block.evidence}: ${parts.join(", ")}`;
}

function chip(block) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cite";
  button.textContent = String(block.evidence);
  button.title = reference(block);
  button.setAttribute("aria-label", referenceName(block));
  button.addEventListener("click", () => open(block.documentId, block.locator));
  return button;
}

function open(documentId, locator) {
  if (ws?.readyState !== WebSocket.OPEN) {
    showViewerMessage("Not connected to the server.");
    return;
  }
  opening = documentId;
  ws.send(JSON.stringify({ type: "open", docId: documentId, locator }));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @returns {Turn} */
function startTurn(text, id = crypto.randomUUID()) {
  const article = el("article", "turn");
  const q = el("div", "question");
  q.append(el("span", "label small", "You asked"), el("p", null, text));
  const stages = el("ol", "stages small");
  stages.setAttribute("aria-label", "Stages");
  for (const stage of STAGES) {
    const li = el("li", null, stage);
    li.dataset.state = "pending";
    stages.append(li);
  }
  const answer = el("div", "answer plain");
  const score = el("p", "score");
  const note = el("p", "note");
  note.setAttribute("role", "alert");
  article.append(q, stages, answer, score, note);
  $("opening")?.remove();
  turnsEl.append(article);
  article.scrollIntoView({ block: "start" });
  return {
    id,
    blocks: new Map(),
    streamed: "",
    startedAt: null,
    article,
    stages,
    answer,
    score,
    note,
  };
}

function renderStages(turn, stage) {
  const index = STAGES.indexOf(stage);
  [...turn.stages.children].forEach((li, i) => {
    if (li.classList.contains("elapsed")) return;
    li.dataset.state = i < index ? "done" : i === index ? "current" : "pending";
    if (i === index) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
}

function finishStages(turn, timings) {
  STAGES.forEach((stage, i) => {
    const li = turn.stages.children[i];
    li.dataset.state = "done";
    li.removeAttribute("aria-current");
    if (Number.isFinite(timings?.[stage])) {
      li.append(" ", el("span", "stage-ms", `${(timings[stage] / 1000).toFixed(1)} s`));
    }
  });
  if (turn.startedAt !== null) {
    const seconds = ((performance.now() - turn.startedAt) / 1000).toFixed(1);
    turn.stages.append(el("li", "elapsed", `${seconds} s`));
  }
}

function renderEvidence(turn, cited) {
  const blocks = [...turn.blocks.values()];
  evidenceCount.textContent = blocks.length ? ` ${blocks.length}` : "";
  evidenceEmpty.hidden = blocks.length > 0;
  evidenceEl.replaceChildren(
    ...blocks.map((block) => {
      const item = el("li", "block");
      item.dataset.cited = cited.size === 0 || cited.has(block.evidence) ? "yes" : "no";
      const heading = el("div", "heading");
      const ref = el("button", "reference quiet small", reference(block));
      ref.type = "button";
      ref.addEventListener("click", () => open(block.documentId, block.locator));
      heading.append(chip(block), ref);
      item.append(heading);
      if (block.text) item.append(el("blockquote", "quote", block.text));
      return item;
    }),
  );
}

function chipOrDropped(turn, n) {
  const block = turn.blocks.get(n);
  return block
    ? chip(block)
    : Object.assign(document.createElement("span"), {
        className: "dropped-tag",
        title: "no such evidence block",
        textContent: `[E${n}]`,
      });
}

/**
 * Inline renderer for the checked answer: each run of text joins the sentence mark that holds it,
 * so the Markdown structure and the support colours both show.
 */
function markedInline(turn, marks) {
  const chips = chipInline((n) => chipOrDropped(turn, n));
  let i = 0;
  const span = (mark, text) => {
    const node = el("span", mark.supported ? "supported" : "unsupported");
    node.title = mark.supported ? "cites evidence" : "unsupported";
    node.append(...chips(text));
    return node;
  };
  return (run) => {
    const out = [];
    let pos = 0;
    while (pos < run.length) {
      const mark = marks[i];
      if (!mark) {
        out.push(...chips(run.slice(pos)));
        break;
      }
      const at = run.indexOf(mark.text, pos);
      if (at >= 0) {
        if (at > pos) out.push(...chips(run.slice(pos, at)));
        out.push(span(mark, mark.text));
        pos = at + mark.text.length;
        i += 1;
        continue;
      }
      const rest = run.slice(pos);
      if (rest.trim() && mark.text.includes(rest.trim())) {
        out.push(span(mark, rest));
        if (mark.text.endsWith(rest.trim())) i += 1;
      } else {
        out.push(...chips(rest));
      }
      break;
    }
    return out;
  };
}

function renderChecked(turn, checks) {
  turn.answer.classList.remove("plain");
  if (checks.marks.length > 0) {
    const text = turn.streamed || checks.marks.map((mark) => mark.text).join(" ");
    turn.answer.replaceChildren(...renderMarkdown(text, markedInline(turn, checks.marks)));
  }
  turn.score.classList.toggle("warning", Boolean(checks.warning) && !checks.abstained);
  turn.score.classList.toggle("abstained", Boolean(checks.abstained));
  if (checks.abstained) {
    turn.score.textContent = "No claim made";
  } else {
    turn.score.textContent = `${checks.supported} of ${checks.sentences} sentences supported`;
    if (checks.droppedCitations > 0) {
      const n = checks.droppedCitations;
      turn.score.append(el("span", "dropped", `${n} citation${n === 1 ? "" : "s"} dropped`));
    }
  }
  if (checks.usage) {
    const { inputTokens, outputTokens } = checks.usage;
    const fmt = (n) => n.toLocaleString("en-GB");
    turn.score.append(
      " ",
      el("span", "usage", `in ${fmt(inputTokens)} · out ${fmt(outputTokens)} tokens`),
    );
  }
}

function recordCitations(turn, citations) {
  const cited = new Set();
  for (const citation of citations) {
    const block = turn.blocks.get(citation.evidence);
    if (!block) continue;
    cited.add(citation.evidence);
    const entry = documents.get(block.documentId) ?? {
      documentId: block.documentId,
      header: block.header,
      locator: block.locator,
      count: 0,
    };
    entry.count += 1;
    documents.set(block.documentId, entry);
  }
  renderEvidence(turn, cited);
  renderDocuments();
}

const times = (n) => (n === 1 ? "cited once" : `cited ${n} times`);

function renderDocuments() {
  const entries = [...documents.values()];
  documentsCount.textContent = entries.length ? ` ${entries.length}` : "";
  documentsEmpty.hidden = entries.length > 0;
  documentsEl.replaceChildren(
    ...entries.map((entry) => {
      const item = el("li", "document");
      const text = el("div");
      text.append(
        el("div", "reference", entry.documentId),
        el("div", "meta small", times(entry.count)),
      );
      const page = entry.locator?.page;
      const button = el("button", "quiet small", page != null ? `Open at p.${page}` : "Open");
      button.type = "button";
      button.addEventListener("click", () => open(entry.documentId, entry.locator));
      item.append(text, button);
      return item;
    }),
  );
}

function finish(turn, message) {
  turn.note.textContent = message;
  if (current === turn) current = null;
  cancelButton.disabled = true;
}

/** Empties the page for another conversation on a new thread. */
function startNew() {
  if (current) cancel();
  current = null;
  newest = null;
  thread = crypto.randomUUID();
  turnsEl.replaceChildren();
  documents.clear();
  renderDocuments();
  evidenceCount.textContent = "";
  evidenceEmpty.hidden = false;
  evidenceEl.replaceChildren();
  cancelButton.disabled = true;
  exporter?.reset();
}

/** Shows stored turns through onFrame, as they rendered live; a new question starts a new thread. */
function replay(turns, sessionId) {
  startNew();
  replaying = true;
  replayTurns(turns, {
    begin: (stored) => {
      current = startTurn(stored.userText, stored.turnId);
      newest = current;
    },
    onFrame,
    end: () => {
      current = null;
      cancelButton.disabled = true;
    },
  });
  replaying = false;
  if (turns.length) exporter?.ready(sessionId, turns[0].thread);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  const turn = startTurn(text);
  current = turn;
  newest = turn;
  question.value = "";
  cancelButton.disabled = false;
  ws.send(JSON.stringify({ type: "turn", thread, turnId: turn.id, text, attachments: [] }));
});

question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

function cancel() {
  if (current) ws.send(JSON.stringify({ type: "cancel", thread, turnId: current.id }));
}

cancelButton.addEventListener("click", cancel);

const isTyping = (target) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/** Moves focus among the newest answer's chips; `step` is +1 or -1. */
function focusChip(step) {
  if (!newest) return;
  const chips = [...newest.answer.querySelectorAll(".cite")];
  if (!chips.length) return;
  const at = chips.indexOf(document.activeElement);
  const next =
    at === -1 ? (step > 0 ? 0 : chips.length - 1) : (at + step + chips.length) % chips.length;
  chips[next].focus();
}

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (isTyping(event.target)) {
    if (event.key === "Escape" && current) cancel();
    return;
  }
  switch (event.key) {
    case "]":
      event.preventDefault();
      focusChip(1);
      break;
    case "[":
      event.preventDefault();
      focusChip(-1);
      break;
    case "o":
      event.preventDefault();
      if (document.activeElement?.classList.contains("cite")) document.activeElement.click();
      else newest?.answer.querySelector(".cite")?.click();
      break;
    case "Escape":
      closeViewer();
      break;
    case "/":
      event.preventDefault();
      question.focus();
      break;
  }
});

if (new URLSearchParams(location.search).has("present")) {
  document.documentElement.dataset.present = "";
}

try {
  config = await loadConfig();
  nameCorpus(config.corpus);
  await connect();
} catch (err) {
  connectionEl.textContent = `cannot start: ${err.message}`;
}

if (config) {
  const token = () => (config.auth ? currentToken() : null);
  try {
    mountConversations(config, { token, replay, startNew });
  } catch (err) {
    console.error(err);
    const opener = $("conversations-open");
    opener.hidden = false;
    opener.disabled = true;
    opener.textContent = "Conversations unavailable";
    opener.title = err.message;
  }
  try {
    exporter = mountExport(config, { token });
  } catch (err) {
    console.error(err);
    const status = $("export-status");
    status.dataset.level = "error";
    status.textContent = `Export is unavailable (${err.message}).`;
  }
  try {
    await showSpend(config, token());
  } catch (err) {
    console.error(err);
    const strip = $("spend");
    strip.dataset.level = "red";
    strip.textContent = `The spend strip is unavailable (${err.message}).`;
    strip.hidden = false;
  }
}
