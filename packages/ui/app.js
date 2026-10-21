// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { currentToken, isExpired, signIn, signOut } from "./auth.js";
import { mountConversations, replayTurns } from "./conversations.js";
import { chooseCorpus, configCorpora, readStoredCorpus, storeCorpus } from "./corpus.mjs";
import { mountExport } from "./export.js";
import { mountFacts } from "./facts.js";
import { mountFilters } from "./filters.js";
import { mountReports } from "./reports.js";
import { showSpend } from "./spend.js";
import { chipInline, renderMarkdown } from "./markdown.mjs";
import { suggestionsFor } from "./suggestions.mjs";
import { closeViewer, openPdf, showViewerMessage } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const turnsEl = $("turns");
const connectionEl = $("connection");
const form = $("ask");
const question = $("question");
const cancelButton = $("cancel");
const suggestionsEl = $("suggestions");
const documentsEl = $("documents");
const documentsCount = $("documents-count");
const documentsEmpty = $("documents-empty");
const evidenceEl = $("evidence");
const evidenceCount = $("evidence-count");
const evidenceEmpty = $("evidence-empty");
const documentsSuggestions = $("documents-suggestions");
const evidenceSuggestions = $("evidence-suggestions");

const STAGES = ["rewriting", "retrieving", "answering", "checking"];
/** The conversation: a thread on this connection's session. */
let thread = crypto.randomUUID();

let ws;
/** @type {Turn | null} The turn whose frames are still arriving. */
let current = null;
/** @type {Turn | null} The last turn started; the keys act on its chips. */
let newest = null;
let opening = null;
let openingText = "";
/** @type {Turn | null} The turn whose blocks the evidence panel shows. */
let evidenceTurn = null;

/**
 * @typedef {{ evidence: number, documentId: string, locator: { page?: number, paragraph?: number },
 *   header?: string | null, text?: string }} Block
 * @typedef {{ id: string, blocks: Map<number, Block>, streamed: string, unfolded: Set<number>, startedAt: number | null,
 *   article: HTMLElement, stages: HTMLElement, answer: HTMLElement, score: HTMLElement,
 *   note: HTMLElement }} Turn
 */

/** @type {ReturnType<typeof mountReports> | null} */
let reports = null;
/** @type {ReturnType<typeof mountFacts> | null} */
let facts = null;
/** @type {ReturnType<typeof mountFilters> | null} */
let filters = null;
/** @type {ReturnType<typeof mountConversations> | null} */
let conversations = null;
/** The id of the corpus every frame and route reads. */
let corpus;
/** @type {{ id: string, name: string }[]} */
let corpora = [];
/** @type {{ ready: (sessionId: string, thread: string) => void, reset: () => void } | null} */
let exporter = null;
let replaying = false;

/** Every document cited this session, by document id. */
const documents = new Map();

/** @type {{ wsUrl: string, httpUrl: string, spendUrl: string, conversationsUrl: string, reportsUrl: string, factsUrl: string, exportUrl: string, corpora: { id: string, name: string }[], auth: null | { region: string, userPoolId: string, clientId: string } }} */
let config;

async function loadConfig() {
  const res = await fetch("./config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json answered ${res.status}`);
  return res.json();
}

const corpusName = () => corpora.find((c) => c.id === corpus).name;

function nameCorpus() {
  const name = `${corpusName()}: witness statements`;
  $("corpus-name").textContent = name;
  $("signin-corpus").textContent = name;
  document.title = `Concordance: ${corpusName()} witness statements`;
}

/** Fills the header's drop list; a change starts a new conversation in the chosen corpus. */
function mountCorpusChoice() {
  const select = $("corpus-select");
  select.replaceChildren(
    ...corpora.map((c) => {
      const option = el("option", null, c.name);
      option.value = c.id;
      return option;
    }),
  );
  select.value = corpus;
  select.disabled = corpora.length < 2;
  select.addEventListener("change", () => switchCorpus(select.value));
}

/** Moves every panel to another corpus: a new conversation, and each list read again. */
async function switchCorpus(id) {
  if (id === corpus || !corpora.some((c) => c.id === id)) return;
  corpus = id;
  storeCorpus(id);
  filters?.clear();
  nameCorpus();
  startNew();
  mountSuggestions(id);
  closeViewer();
  conversations?.reload();
  await Promise.all([
    reports?.reload(suggestionsFor(id, "reports")),
    facts?.reload().catch((err) => {
      console.error(err);
      $("facts-message").textContent = `Contradictions are unavailable (${err.message}).`;
    }),
  ]);
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
    reports?.refresh();
  });
  ws.addEventListener("close", () => {
    // A $connect the authorizer denies closes before it opens.
    if (token && (!opened || isExpired(token))) signOut();
    connectionEl.textContent = "disconnected; retrying";
    reports?.disconnected();
    setTimeout(connect, 2000);
  });
  ws.addEventListener("message", (event) => onFrame(JSON.parse(event.data)));
}

function onFrame(frame) {
  if (frame.requestId && reports?.onFrame(frame)) return;
  if (frame.type === "opened") {
    if (frame.docId === opening) openPdf({ ...frame, text: openingText });
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
    case "tool":
      renderTool(turn, frame);
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

function chip(block, turn) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cite";
  button.textContent = String(block.evidence);
  button.title = reference(block);
  button.setAttribute("aria-label", referenceName(block));
  button.addEventListener("click", () => {
    openBlock(turn, block.evidence);
    open(block.documentId, block.locator, block.text);
  });
  return button;
}

/** Unfolds a block of the evidence panel; the panel shows one turn at a time. */
function openBlock(turn, evidence) {
  if (!turn || turn !== evidenceTurn) return;
  turn.unfolded.add(evidence);
  const details = evidenceEl.querySelector(`details[data-evidence="${evidence}"]`);
  if (details) details.open = true;
}

function open(documentId, locator, text = "") {
  if (ws?.readyState !== WebSocket.OPEN) {
    showViewerMessage("Not connected to the server.");
    return;
  }
  opening = documentId;
  openingText = text;
  ws.send(JSON.stringify({ type: "open", docId: documentId, locator, corpus }));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @returns {Turn} */
function startTurn(text, id = crypto.randomUUID()) {
  suggestionsEl.hidden = true;
  const article = el("article", "turn");
  const q = el("div", "question");
  q.append(el("span", "label small", "You asked"), el("p", null, text));
  const stages = el("ol", "stages small");
  stages.setAttribute("aria-label", "Stages");
  for (const stage of STAGES) {
    const li = el("li", null, stage);
    li.dataset.stage = stage;
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
    unfolded: new Set(),
    startedAt: null,
    article,
    stages,
    answer,
    score,
    note,
  };
}

const stageItems = (turn) => [...turn.stages.querySelectorAll("li[data-stage]")];

function renderStages(turn, stage) {
  const index = STAGES.indexOf(stage);
  stageItems(turn).forEach((li, i) => {
    li.dataset.state = i < index ? "done" : i === index ? "current" : "pending";
    if (i === index) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
}

/** A tool call of the answer, as a line before the checking stage: its name and row count. */
function renderTool(turn, { name, rows }) {
  const li = el("li", "tool", `${name} · ${rows} ${rows === 1 ? "row" : "rows"}`);
  turn.stages.insertBefore(li, turn.stages.querySelector('li[data-stage="checking"]'));
}

function finishStages(turn, timings) {
  STAGES.forEach((stage) => {
    const li = turn.stages.querySelector(`li[data-stage="${stage}"]`);
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
  evidenceTurn = turn;
  const blocks = [...turn.blocks.values()];
  evidenceCount.textContent = blocks.length ? ` ${blocks.length}` : "";
  evidenceEmpty.hidden = blocks.length > 0;
  showPanelPills(evidenceSuggestions, blocks.length === 0);
  evidenceEl.replaceChildren(
    ...blocks.map((block) => {
      const item = el("li", "block");
      item.dataset.cited = cited.size === 0 || cited.has(block.evidence) ? "yes" : "no";
      const details = el("details");
      details.dataset.evidence = String(block.evidence);
      details.open = turn.unfolded.has(block.evidence);
      details.addEventListener("toggle", () => {
        if (details.open) turn.unfolded.add(block.evidence);
        else turn.unfolded.delete(block.evidence);
      });
      const summary = el("summary", "heading");
      const ref = el("button", "reference quiet small", reference(block));
      ref.type = "button";
      ref.addEventListener("click", () => {
        openBlock(turn, block.evidence);
        open(block.documentId, block.locator, block.text);
      });
      summary.append(chip(block, turn), ref);
      if (block.text) summary.append(el("span", "first-line small", block.text.split("\n")[0]));
      details.append(summary);
      if (block.text) details.append(el("blockquote", "quote", block.text));
      item.append(details);
      return item;
    }),
  );
}

function chipOrDropped(turn, n) {
  const block = turn.blocks.get(n);
  return block
    ? chip(block, turn)
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
      document: block.document,
      count: 0,
    };
    entry.count += 1;
    documents.set(block.documentId, entry);
  }
  renderEvidence(turn, cited);
  renderDocuments();
}

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    dateStyle: "medium",
    timeZone: "UTC",
  });

/** The facts line for a document: a cipher-only witness shows its cipher and nothing else. */
function documentFacts(facts) {
  if (!facts) return [];
  if (facts.cipherOnly) return [`Witness ${facts.witnessId}`];
  const parts = [facts.title];
  if (facts.witnessId) parts.push(`Witness ${facts.witnessId}`);
  if (facts.role) parts.push(facts.role);
  if (facts.statementDate) parts.push(longDate(facts.statementDate));
  const type = facts.pages != null ? `${facts.type}, ${facts.pages} pages` : facts.type;
  parts.push(type);
  return parts.filter(Boolean);
}

const times = (n) => (n === 1 ? "cited once" : `cited ${n} times`);

function renderDocuments() {
  const entries = [...documents.values()];
  reports?.syncDocuments(entries.map((entry) => entry.documentId));
  documentsCount.textContent = entries.length ? ` ${entries.length}` : "";
  documentsEmpty.hidden = entries.length > 0;
  showPanelPills(documentsSuggestions, entries.length === 0);
  documentsEl.replaceChildren(
    ...entries.map((entry) => {
      const item = el("li", "document");
      const text = el("div");
      text.append(
        el("div", "reference", entry.documentId),
        el("div", "facts small", documentFacts(entry.document).join(" · ")),
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

/** The pill buttons for a list of suggestions; a click asks the pill's text. */
function pills(suggestions) {
  return suggestions.map(({ text }) => {
    const button = el("button", "pill", text);
    button.type = "button";
    button.addEventListener("click", () => {
      question.value = text;
      form.requestSubmit();
    });
    const item = el("li");
    item.append(button);
    return item;
  });
}

/** A panel's pills show while the panel is empty. */
function showPanelPills(list, empty) {
  list.hidden = !empty || list.children.length === 0;
}

/**
 * Fills the pills for a corpus. The prompt-box pills show until the first turn of a thread; the
 * panel pills show while their panel is empty.
 */
function mountSuggestions(corpusId) {
  suggestionsEl.replaceChildren(...pills(suggestionsFor(corpusId)));
  suggestionsEl.hidden = suggestionsEl.children.length === 0;
  documentsSuggestions.replaceChildren(...pills(suggestionsFor(corpusId, "documents")));
  showPanelPills(documentsSuggestions, documents.size === 0);
  evidenceSuggestions.replaceChildren(...pills(suggestionsFor(corpusId, "evidence")));
  showPanelPills(evidenceSuggestions, evidenceEl.children.length === 0);
}

/** Empties the page for another conversation on a new thread. */
function startNew() {
  suggestionsEl.hidden = suggestionsEl.children.length === 0;
  if (current) cancel();
  current = null;
  newest = null;
  thread = crypto.randomUUID();
  turnsEl.replaceChildren();
  documents.clear();
  renderDocuments();
  evidenceTurn = null;
  evidenceCount.textContent = "";
  evidenceEmpty.hidden = false;
  evidenceEl.replaceChildren();
  showPanelPills(evidenceSuggestions, true);
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

/** A turn-area entry for a chat message that became a report edit; the panel keeps its note. */
function startEditNote(text, filename) {
  suggestionsEl.hidden = true;
  const article = el("article", "turn");
  const q = el("div", "question");
  q.append(el("span", "label small", "You asked"), el("p", null, text));
  const note = el("p", "note");
  note.setAttribute("role", "status");
  note.textContent = `Editing ${filename}: this message goes to the report as its change request, and the new version appears under Generated reports.`;
  article.append(q, note);
  $("opening")?.remove();
  turnsEl.append(article);
  article.scrollIntoView({ block: "start" });
  return note;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  const target = reports?.editTarget(text);
  if (target) {
    const note = startEditNote(text, target);
    if (reports.requestEdit(target, text, note)) question.value = "";
    return;
  }
  if (filters?.check()) return;
  const turn = startTurn(text);
  current = turn;
  newest = turn;
  question.value = "";
  cancelButton.disabled = false;
  ws.send(
    JSON.stringify({
      type: "turn",
      thread,
      turnId: turn.id,
      text,
      attachments: [],
      corpus,
      filters: filters?.value(),
    }),
  );
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
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

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
  corpora = configCorpora(config);
  corpus = chooseCorpus(corpora, readStoredCorpus());
  nameCorpus();
  mountCorpusChoice();
  mountSuggestions(corpus);
  await connect();
} catch (err) {
  connectionEl.textContent = `cannot start: ${err.message}`;
}

if (config) {
  const token = () => (config.auth ? currentToken() : null);
  const chosen = () => corpus;
  try {
    conversations = mountConversations(config, { token, corpus: chosen, replay, startNew });
  } catch (err) {
    console.error(err);
    const opener = $("conversations-open");
    opener.hidden = false;
    opener.disabled = true;
    opener.textContent = "Conversations unavailable";
    opener.title = err.message;
  }
  filters = mountFilters(config, {
    token,
    corpus: chosen,
    extraWitnesses: () => [...documents.values()].map((entry) => entry.document?.witnessId),
  });
  try {
    reports = mountReports(config, {
      token,
      send: (frame) => {
        if (ws?.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame));
        return true;
      },
      thread: () => thread,
      corpus: chosen,
      open,
      suggestions: suggestionsFor(corpus, "reports"),
    });
    reports.syncDocuments([...documents.keys()]);
    await reports.refresh();
  } catch (err) {
    console.error(err);
    $("reports-message").textContent = `Reports are unavailable (${err.message}).`;
  }
  try {
    facts = mountFacts(config, { token, corpus: chosen, open });
    await facts.refresh();
  } catch (err) {
    console.error(err);
    $("facts-message").textContent = `Contradictions are unavailable (${err.message}).`;
  }
  try {
    exporter = mountExport(config, { token, corpus: chosen });
  } catch (err) {
    console.error(err);
    const status = $("export-status");
    status.dataset.level = "error";
    status.textContent = `Export is unavailable (${err.message}).`;
  }
  try {
    await showSpend(config, token);
  } catch (err) {
    console.error(err);
    const strip = $("spend");
    strip.dataset.level = "red";
    strip.textContent = `The spend strip is unavailable (${err.message}).`;
    strip.hidden = false;
  }
}
