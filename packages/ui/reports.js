// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The "Generated reports" panel: the list, the request form, a stored version rendered with
// citation chips, and delete with an inline confirm.
import { withCorpus } from "./corpus.mjs";
import { chipInline, renderMarkdown } from "./markdown.mjs";
import { FILENAME, FILENAME_MAX, editTarget, slugFilename } from "./reportNames.mjs";

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const STAGE_TEXT = {
  drafting: "Drafting the outline",
  writing: "Writing the sections",
  reviewing: "Checking every sentence",
  done: "Done",
};

const SCOPE = "the whole corpus";

/** The locator as the trade writes it, for a chip's title. */
function reference(citation) {
  const { document: id, page, paragraph } = citation.locator;
  const parts = [id];
  if (page != null) parts.push(`p.${page}`);
  if (paragraph != null) parts.push(`¶${paragraph}`);
  return parts.join(" ");
}

function referenceName(citation) {
  const { document: id, page, paragraph } = citation.locator;
  const parts = [id];
  if (page != null) parts.push(`page ${page}`);
  if (paragraph != null) parts.push(`paragraph ${paragraph}`);
  return `Evidence ${citation.evidence}: ${parts.join(", ")}`;
}

const checkLine = (checks) => {
  let line = `${checks.supported} of ${checks.sentences} sentences supported`;
  if (checks.removed > 0) line += `, ${checks.removed} removed`;
  return line;
};

/**
 * Wires the panel.
 * @param {{ reportsUrl?: string }} config
 * @param {{ token: () => string | null, send: (frame: object) => boolean,
 *   thread: () => string, corpus: () => string,
 *   open: (documentId: string, locator: object) => void,
 *   suggestions: { text: string, filename?: string }[] }} page
 */
export function mountReports(config, { token, send, thread, corpus, open, suggestions }) {
  const base = config.reportsUrl;
  if (typeof base !== "string") throw new Error("config.json has no reportsUrl");

  const list = $("reports-list");
  const empty = $("reports-empty");
  const count = $("reports-count");
  const message = $("reports-message");
  const pillList = $("reports-suggestions");
  const request = $("report-request");
  const form = $("report-form");
  const topic = $("report-topic");
  const filename = $("report-filename");
  const documentChecks = $("report-documents");
  const otherIds = $("report-other-ids");
  const submit = $("report-submit");
  const status = $("report-status");
  const view = $("report-view");

  /** @type {Map<string, { note: HTMLElement | null }>} */
  const pending = new Map();
  let names = [];
  let knownDocuments = [];
  let filenameEdited = false;
  let viewing = null;

  const headers = () => {
    const bearer = token();
    return bearer ? { authorization: `Bearer ${bearer}` } : {};
  };

  async function call(url, method = "GET") {
    const res = await fetch(withCorpus(url, corpus()), {
      method,
      cache: "no-store",
      headers: headers(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `the reports route answered ${res.status}`);
    }
    return res.json();
  }

  const fileUrl = (name) => `${base}/${encodeURIComponent(name)}`;

  function setStatus(text, level = "") {
    status.textContent = text;
    status.dataset.level = level;
    for (const { note } of pending.values()) if (note) note.textContent = text;
  }

  const busy = () => {
    submit.disabled = pending.size > 0;
  };

  function renderList(reports) {
    names = reports.map((r) => r.filename);
    count.textContent = reports.length ? ` ${reports.length}` : "";
    empty.hidden = reports.length > 0;
    pillList.hidden = reports.length > 0 || pillList.children.length === 0;
    list.replaceChildren(...reports.map(row));
  }

  function row(report) {
    const item = el("li", "report");
    item.dataset.filename = report.filename;
    const text = el("div");
    text.append(el("div", "reference", report.filename), el("div", "facts small", report.title));
    const versions = el("div", "versions small");
    versions.append("Versions ");
    for (const version of report.versions) {
      const button = el("button", "quiet small version", `v${version}`);
      button.type = "button";
      button.setAttribute("aria-label", `Open version ${version} of ${report.filename}`);
      button.addEventListener("click", () => show(report.filename, version));
      versions.append(button);
    }
    const actions = el("div", "report-actions");
    const del = el("button", "quiet small delete", "Delete");
    del.type = "button";
    del.setAttribute("aria-label", `Delete ${report.filename}`);
    del.addEventListener("click", () => confirmDelete(actions, del, report.filename));
    actions.append(del);
    item.append(text, versions, actions);
    return item;
  }

  function confirmDelete(actions, del, name) {
    const ask = el("span", "confirm small");
    ask.setAttribute("role", "group");
    ask.setAttribute("aria-label", `Confirm deleting ${name}`);
    const yes = el("button", "small confirm-yes", "Confirm");
    yes.type = "button";
    yes.setAttribute("aria-label", `Confirm deleting ${name} and all its versions`);
    const no = el("button", "quiet small confirm-no", "Cancel");
    no.type = "button";
    const restore = () => {
      ask.remove();
      del.hidden = false;
      del.focus();
    };
    no.addEventListener("click", restore);
    ask.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        restore();
      }
    });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      no.disabled = true;
      try {
        await call(fileUrl(name), "DELETE");
        if (viewing === name) closeView();
        await refresh();
        setStatus(`Deleted ${name}.`);
      } catch (err) {
        console.error(err);
        setStatus(`${name} could not be deleted (${err.message}).`, "error");
        yes.disabled = false;
        no.disabled = false;
      }
    });
    del.hidden = true;
    ask.append(el("span", null, "Delete every version?"), yes, no);
    actions.append(ask);
    yes.focus();
  }

  async function refresh() {
    try {
      const { reports } = await call(base);
      message.textContent = "";
      renderList(reports);
      return reports;
    } catch (err) {
      console.error(err);
      message.textContent = `The reports could not be read (${err.message}); try again.`;
      return null;
    }
  }

  function closeView() {
    viewing = null;
    view.hidden = true;
    view.replaceChildren();
  }

  async function show(name, version) {
    try {
      const { versions } = await call(fileUrl(name));
      const chosen = versions.find((v) => v.version === version) ?? versions.at(-1);
      renderVersion(name, chosen);
    } catch (err) {
      console.error(err);
      message.textContent = `${name} could not be read (${err.message}); try again.`;
    }
  }

  function renderVersion(name, version) {
    viewing = name;
    const chip = (n) => {
      const citation = version.citations.find((c) => c.evidence === n);
      if (!citation) {
        return Object.assign(el("span", "dropped-tag", `[E${n}]`), {
          title: "no such evidence block",
        });
      }
      const button = el("button", "cite", String(n));
      button.type = "button";
      button.title = reference(citation);
      button.setAttribute("aria-label", referenceName(citation));
      button.addEventListener("click", () => {
        const { document: id, ...locator } = citation.locator;
        open(id, locator);
      });
      return button;
    };
    const details = el("details", "report-body");
    details.open = true;
    const summary = el("summary", "heading small", `${name} v${version.version}`);
    const body = el("div", "answer");
    body.append(...renderMarkdown(version.bodyMarkdown, chipInline(chip)));
    const score = el("p", "score", checkLine(version.checks));
    const close = el("button", "quiet small", "Close report");
    close.type = "button";
    close.addEventListener("click", () => {
      closeView();
      list.querySelector(`li[data-filename="${name}"] .version`)?.focus();
    });
    details.append(summary, body, score, close);
    view.replaceChildren(details);
    view.hidden = false;
    view.setAttribute("aria-label", `Report ${name} version ${version.version}`);
    summary.focus();
  }

  function syncDocuments(ids) {
    knownDocuments = ids;
    const checked = new Set(
      [...documentChecks.querySelectorAll("input:checked")].map((box) => box.value),
    );
    documentChecks.replaceChildren(
      ...ids.map((id) => {
        const label = el("label", "check small");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = id;
        box.checked = checked.has(id);
        label.append(box, ` ${id}`);
        return label;
      }),
    );
    documentChecks.hidden = ids.length === 0;
  }

  function chosenDocuments() {
    const ids = [...documentChecks.querySelectorAll("input:checked")].map((box) => box.value);
    for (const id of otherIds.value.split(/[\s,]+/)) if (id && !ids.includes(id)) ids.push(id);
    return ids;
  }

  function fillForm({ topic: text, filename: name, documentIds = [] }) {
    request.open = true;
    topic.value = text;
    filename.value = name;
    filenameEdited = true;
    for (const box of documentChecks.querySelectorAll("input")) {
      box.checked = documentIds.includes(box.value);
    }
    otherIds.value = documentIds.filter((id) => !knownDocuments.includes(id)).join(", ");
    topic.focus();
  }

  function sendReport({ text, name, documentIds, note = null }) {
    const requestId = crypto.randomUUID();
    const frame = {
      type: "report",
      thread: thread(),
      requestId,
      topic: text,
      documentIds,
      filename: name,
      corpus: corpus(),
    };
    if (!send(frame)) {
      setStatus("Not connected to the server.", "error");
      if (note) note.textContent = "Not connected to the server.";
      return false;
    }
    pending.set(requestId, { note });
    busy();
    setStatus(
      `Request sent for ${name} over ${documentIds.length ? documentIds.join(", ") : SCOPE}.`,
    );
    return true;
  }

  topic.addEventListener("input", () => {
    if (!filenameEdited) filename.value = topic.value.trim() ? slugFilename(topic.value) : "";
  });
  filename.addEventListener("input", () => {
    filenameEdited = true;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = topic.value.trim();
    const name = filename.value.trim();
    if (!text) return;
    if (!FILENAME.test(name) || name.length > FILENAME_MAX) {
      setStatus("The filename is lower-case letters, digits and dashes, ending in .md.", "error");
      filename.focus();
      return;
    }
    if (pending.size > 0) return;
    if (sendReport({ text, name, documentIds: chosenDocuments() })) {
      topic.value = "";
      filename.value = "";
      filenameEdited = false;
    }
  });

  const mountPills = (list) => {
    pillList.replaceChildren(
      ...list.map((suggestion) => {
        const button = el("button", "pill", suggestion.text);
        button.type = "button";
        button.addEventListener("click", () =>
          fillForm({
            topic: suggestion.text,
            filename: suggestion.filename ?? slugFilename(suggestion.text),
          }),
        );
        const item = el("li");
        item.append(button);
        return item;
      }),
    );
    pillList.hidden = pillList.children.length === 0;
  };
  mountPills(suggestions);

  return {
    refresh,
    /** Empties the panel for another corpus and lists that corpus's reports. */
    reload(nextSuggestions) {
      closeView();
      pending.clear();
      busy();
      setStatus("");
      mountPills(nextSuggestions);
      return refresh();
    },
    syncDocuments,
    /** The existing filename a chat message names, or null. */
    editTarget: (text) => editTarget(text, names),
    /** Sends a chat message as the change prompt of an existing report. */
    requestEdit: (name, text, note) => sendReport({ text, name, documentIds: [], note }),
    /** Takes the frames that carry a requestId; true when the panel handled the frame. */
    onFrame(frame) {
      const entry = pending.get(frame.requestId);
      if (!entry) return false;
      if (frame.type === "reportStatus") {
        setStatus(`${STAGE_TEXT[frame.stage] ?? frame.stage}.`);
      } else if (frame.type === "reportDone") {
        const { filename: name, version, title } = frame.report;
        setStatus(`Stored ${name} version ${version}: ${title}.`, "done");
        pending.delete(frame.requestId);
        busy();
        refresh().then(() => {
          if (viewing === name) show(name, version);
        });
      } else if (frame.type === "error") {
        setStatus(frame.message, "error");
        pending.delete(frame.requestId);
        busy();
      }
      return true;
    },
    /** The socket closed: the report still finishes on the server and shows in the list. */
    disconnected() {
      if (pending.size === 0) return;
      setStatus("The connection closed; a report in progress is stored when it finishes.", "error");
      pending.clear();
      busy();
    },
  };
}
