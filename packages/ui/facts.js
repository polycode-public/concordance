// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The "Contradictions" panel: an event selector, the matrix of witnesses against witnesses for
// the chosen group, a cell's pairs with their reason, spans and source chips, a person's
// relabel and promotion, the accepted-fact labels and the timeline. A pair whose two documents
// reveal an identity together keeps its labels and spans, and the panel refuses to show its two
// sentences side by side.
import { renderTimeline } from "./timeline.js";

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const WITNESS_LABELS = ["agree", "contradict", "unrelated"];
const ACCEPTED_LABELS = ["consistent", "inconsistent", "not_covered"];
const LABEL_TEXT = { not_covered: "not covered" };
const labelText = (label) => LABEL_TEXT[label] ?? label;
export const REFUSAL =
  "These two documents together can reveal a protected witness's identity, so they are not shown side by side. Each source opens on its own.";

const groupValue = (g) => (g.eventId ? `event:${g.eventId}` : `topic:${g.topic}`);
const groupName = (g) => {
  const name = g.eventId ? g.name : `${g.topic} (no event named)`;
  return `${name}: ${g.contradictions} contradict of ${g.pairs}`;
};

const reference = (side) => {
  const { page, paragraph } = side.locator ?? {};
  const parts = [side.documentId];
  if (page != null) parts.push(`p.${page}`);
  if (paragraph != null) parts.push(`¶${paragraph}`);
  return parts.join(" ");
};

/**
 * Wires the panel.
 * @param {{ factsUrl?: string }} config
 * @param {{ token: () => string | null, open: (documentId: string, locator: object) => void }} page
 */
export function mountFacts(config, { token, open }) {
  const base = config.factsUrl;
  if (typeof base !== "string") throw new Error("config.json has no factsUrl");

  const select = $("facts-group");
  const count = $("facts-count");
  const message = $("facts-message");
  const empty = $("facts-empty");
  const matrixBox = $("facts-matrix");
  const detail = $("facts-detail");
  const acceptedBox = $("facts-accepted");
  const status = $("facts-status");
  const timeline = {
    figure: $("facts-timeline-figure"),
    list: $("facts-timeline"),
    empty: $("facts-timeline-empty"),
  };

  let groups = [];
  let matrix = null;
  let openCell = null;
  let loads = 0;

  const headers = (json) => {
    const out = json ? { "content-type": "application/json" } : {};
    const bearer = token();
    if (bearer) out.authorization = `Bearer ${bearer}`;
    return out;
  };

  async function call(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: headers(Boolean(body)),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const answer = await res.json().catch(() => ({}));
      throw new Error(answer.message ?? `the facts route answered ${res.status}`);
    }
    return res.json();
  }

  function setStatus(text, level = "") {
    status.textContent = text;
    status.dataset.level = level;
  }

  function chip(side, name) {
    const button = el("button", "cite", name);
    button.type = "button";
    button.title = reference(side);
    button.setAttribute("aria-label", `Open ${side.witnessId}'s statement at ${reference(side)}`);
    button.addEventListener("click", () => open(side.documentId, side.locator));
    return button;
  }

  function span(side, text, name) {
    const row = el("p", "facts-span");
    const quote = el("q", "facts-quote", text ?? "");
    row.append(el("span", "facts-who small", `${side.witnessId} `), quote, " ", chip(side, name));
    return row;
  }

  function sideBySide(pair, holder) {
    if (pair.identityRevealing || !pair.a.sentence || !pair.b?.sentence) {
      holder.replaceChildren(el("p", "facts-refusal small", REFUSAL));
      return;
    }
    const grid = el("div", "facts-sides");
    for (const [side, name] of [
      [pair.a, "A"],
      [pair.b, "B"],
    ]) {
      const column = el("div", "facts-side");
      column.append(
        el(
          "p",
          "small soft",
          `${side.witnessId}, ${side.statementDate ?? "undated"}, ${reference(side)}`,
        ),
        el("p", "facts-sentence", side.sentence),
        chip(side, name),
      );
      grid.append(column);
    }
    holder.replaceChildren(grid);
  }

  function overrideForm(pair, rerender) {
    const form = el("form", "facts-form");
    const id = `facts-override-${pair.id}`;
    const labelSelect = document.createElement("select");
    labelSelect.id = `${id}-label`;
    for (const label of pair.kind === "accepted" ? ACCEPTED_LABELS : WITNESS_LABELS) {
      const option = el("option", null, labelText(label));
      option.value = label;
      option.selected = label === pair.label;
      labelSelect.append(option);
    }
    const reason = document.createElement("textarea");
    reason.id = `${id}-reason`;
    reason.rows = 2;
    reason.maxLength = 500;
    reason.required = true;
    const submit = el("button", "small", "Save the label");
    submit.type = "submit";
    form.append(
      Object.assign(el("label", "small", "Label"), { htmlFor: labelSelect.id }),
      labelSelect,
      Object.assign(el("label", "small", "Your reason"), { htmlFor: reason.id }),
      reason,
      submit,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!reason.value.trim()) return;
      submit.disabled = true;
      try {
        const { comparison } = await call("/override", {
          comparisonId: pair.id,
          label: labelSelect.value,
          reason: reason.value.trim(),
        });
        setStatus(`Labelled ${labelText(comparison.label)} by ${comparison.decidedBy}.`, "done");
        await rerender();
      } catch (err) {
        setStatus(`The label was not saved (${err.message}).`, "error");
        submit.disabled = false;
      }
    });
    return form;
  }

  function promoteForm(pair) {
    const form = el("form", "facts-form");
    const id = `facts-promote-${pair.id}`;
    const which = document.createElement("select");
    which.id = `${id}-which`;
    for (const [side, name] of [
      [pair.a, "A"],
      [pair.b, "B"],
    ]) {
      if (!side) continue;
      const option = el(
        "option",
        null,
        `${name}: ${side.witnessId}, ${side.predicate} ${side.objectText ?? ""}`.trim(),
      );
      option.value = side.assertionId;
      which.append(option);
    }
    const citation = document.createElement("input");
    citation.id = `${id}-citation`;
    citation.required = true;
    citation.maxLength = 500;
    citation.autocomplete = "off";
    const submit = el("button", "small", "Promote to an accepted fact");
    submit.type = "submit";
    form.append(
      Object.assign(el("label", "small", "Claim"), { htmlFor: which.id }),
      which,
      Object.assign(el("label", "small", "Source citation (required)"), { htmlFor: citation.id }),
      citation,
      submit,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!citation.value.trim()) return;
      submit.disabled = true;
      try {
        const { fact } = await call("/accept", {
          assertionId: which.value,
          sourceCitation: citation.value.trim(),
        });
        setStatus(`Accepted fact ${fact.id} stored, cited to ${fact.sourceCitation}.`, "done");
        citation.value = "";
      } catch (err) {
        setStatus(`The fact was not stored (${err.message}).`, "error");
      }
      submit.disabled = false;
    });
    return form;
  }

  function pairView(pair, rerender) {
    const item = el("li", "facts-pair");
    item.dataset.pair = pair.id;
    item.dataset.label = pair.label;
    const head = el("p", "facts-pair-head");
    head.append(
      el("strong", `facts-label label-${pair.label}`, labelText(pair.label)),
      " ",
      el("span", "small soft", pair.kind === "self" ? "same witness, two statements" : pair.kind),
    );
    if (pair.model === "operator") {
      head.append(" ", el("span", "facts-pencil small", `✎ ${pair.decidedBy}`));
    }
    const reason = el("p", "facts-reason", pair.reason ?? "");
    const by = el(
      "p",
      "small soft facts-by",
      pair.machine
        ? `Machine label ${labelText(pair.machine.label)} (${pair.machine.model}): ${pair.machine.reason}`
        : `Labelled by ${pair.model}`,
    );
    item.append(head, reason, span(pair.a, pair.spanA, "A"));
    if (pair.b) item.append(span(pair.b, pair.spanB, "B"));
    if (pair.fact) {
      item.append(
        el("p", "facts-span", `Accepted fact${pair.fact.isHypothesis ? " (hypothesis)" : ""}: `),
      );
      item.lastChild.append(el("q", "facts-quote", pair.fact.text), ` ${pair.fact.sourceCitation}`);
    }
    item.append(by);
    const actions = el("div", "facts-actions");
    const sides = el("div", "facts-side-by-side");
    if (pair.b) {
      if (pair.identityRevealing) {
        sides.append(el("p", "facts-refusal small", REFUSAL));
      } else {
        const show = el("button", "quiet small", "Show side by side");
        show.type = "button";
        show.addEventListener("click", () => sideBySide(pair, sides));
        actions.append(show);
      }
    }
    const override = el("details", "facts-more");
    override.append(el("summary", "small", "Override the label"), overrideForm(pair, rerender));
    const promote = el("details", "facts-more");
    promote.append(el("summary", "small", "Promote to an accepted fact"), promoteForm(pair));
    item.append(actions, sides, override, promote);
    return item;
  }

  function showCell(cell) {
    openCell = cell ? `${cell.witnessA}\u0000${cell.witnessB}` : null;
    if (!cell) {
      detail.hidden = true;
      detail.replaceChildren();
      return;
    }
    const pairs = matrix.pairs.filter((p) => cell.pairIds.includes(p.id));
    const title = el(
      "h3",
      "facts-detail-title",
      cell.witnessA === cell.witnessB
        ? `${cell.witnessA} against their own statements`
        : `${cell.witnessA} and ${cell.witnessB}`,
    );
    title.tabIndex = -1;
    const list = el("ol", "facts-pairs");
    list.append(...pairs.map((p) => pairView(p, () => loadMatrix(select.value, true))));
    const close = el("button", "quiet small", "Close");
    close.type = "button";
    close.addEventListener("click", () => {
      showCell(null);
      matrixBox.querySelector("button.facts-cell")?.focus();
    });
    detail.replaceChildren(title, list, close);
    detail.hidden = false;
    title.focus();
  }

  function cellFor(x, y) {
    const [a, b] = x <= y ? [x, y] : [y, x];
    return matrix.cells.find((c) => c.witnessA === a && c.witnessB === b) ?? null;
  }

  // Arrows move between the cells that hold a label; "o" opens the first span's source.
  function moveFocus(event) {
    const td = event.target.closest?.("td");
    if (!td || !event.target.matches("button.facts-cell")) return;
    if (event.key === "o") {
      const ids = event.target.dataset.pairs.split(",");
      const pair = matrix.pairs.find((p) => p.id === ids[0]);
      if (pair) open(pair.a.documentId, pair.a.locator);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[
      event.key
    ];
    if (!step) return;
    event.preventDefault();
    const rows = [...matrixBox.querySelectorAll("tbody tr")];
    let r = rows.indexOf(td.parentElement);
    let c = [...td.parentElement.children].indexOf(td);
    for (;;) {
      r += step[0];
      c += step[1];
      const row = rows[r];
      if (!row || c < 1 || c >= row.children.length) return;
      const target = row.children[c].querySelector("button.facts-cell");
      if (target) {
        target.focus();
        return;
      }
    }
  }

  function renderMatrix() {
    matrixBox.replaceChildren();
    if (!matrix || !matrix.witnesses.length) {
      matrixBox.hidden = true;
      return;
    }
    const table = el("table", "facts-table");
    const caption = el(
      "caption",
      "small",
      matrix.group.eventId ? matrix.group.name : `${matrix.group.topic} (no event named)`,
    );
    const head = el("thead");
    const headRow = el("tr");
    headRow.append(el("td"));
    for (const w of matrix.witnesses) {
      const th = el("th", null, w.id);
      th.scope = "col";
      headRow.append(th);
    }
    head.append(headRow);
    const body = el("tbody");
    for (const rowWitness of matrix.witnesses) {
      const tr = el("tr");
      const th = el("th", null, rowWitness.id);
      th.scope = "row";
      tr.append(th);
      for (const colWitness of matrix.witnesses) {
        const td = el("td");
        const cell = cellFor(rowWitness.id, colWitness.id);
        if (cell) {
          const total = cell.counts.agree + cell.counts.contradict + cell.counts.unrelated;
          const button = el("button", `facts-cell label-${cell.label}`);
          button.type = "button";
          button.dataset.pairs = cell.pairIds.join();
          button.append(labelText(cell.label));
          if (total > 1) button.append(el("span", "facts-cell-count", ` ${total}`));
          const overridden = matrix.pairs.some(
            (p) => cell.pairIds.includes(p.id) && p.model === "operator",
          );
          if (overridden) button.append(el("span", "facts-pencil", " ✎"));
          const parts = Object.entries(cell.counts)
            .filter(([, n]) => n)
            .map(([label, n]) => `${n} ${label}`)
            .join(", ");
          button.setAttribute(
            "aria-label",
            `${rowWitness.id} and ${colWitness.id}: ${cell.label}; ${parts}${overridden ? "; relabelled by a person" : ""}`,
          );
          button.addEventListener("click", () => showCell(cell));
          td.append(button);
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(caption, head, body);
    table.addEventListener("keydown", moveFocus);
    matrixBox.append(table);
    matrixBox.hidden = false;
  }

  function renderAccepted() {
    const pairs = matrix?.accepted ?? [];
    acceptedBox.replaceChildren();
    acceptedBox.hidden = pairs.length === 0;
    if (!pairs.length) return;
    const list = el("ol", "facts-pairs");
    list.append(...pairs.map((p) => pairView(p, () => loadMatrix(select.value, true))));
    acceptedBox.append(el("h3", "facts-detail-title", "Against accepted facts"), list);
  }

  async function loadTimeline(value, ticket) {
    const eventId = value?.startsWith("event:") ? value.slice(6) : null;
    try {
      const data = await call(
        eventId ? `/timeline?event=${encodeURIComponent(eventId)}` : "/timeline",
      );
      if (ticket !== loads) return;
      renderTimeline(timeline, data, open);
    } catch (err) {
      console.error(err);
      timeline.empty.hidden = false;
      timeline.empty.textContent = `The timeline could not be read (${err.message}).`;
    }
  }

  async function loadMatrix(value, keepCell = false) {
    if (!value) return;
    const query = value.startsWith("event:")
      ? `event=${encodeURIComponent(value.slice(6))}`
      : `topic=${encodeURIComponent(value.slice(6))}`;
    const previous = keepCell ? openCell : null;
    const ticket = ++loads;
    try {
      const answer = await call(`/matrix?${query}`);
      if (ticket !== loads) return;
      matrix = answer;
      message.textContent = "";
      renderMatrix();
      renderAccepted();
      const reopen =
        previous && matrix.cells.find((c) => `${c.witnessA}\u0000${c.witnessB}` === previous);
      showCell(reopen ?? null);
    } catch (err) {
      console.error(err);
      message.textContent = `The matrix could not be read (${err.message}); try again.`;
    }
    await loadTimeline(value, ticket);
  }

  async function refresh() {
    try {
      ({ groups } = await call("/groups"));
      message.textContent = "";
    } catch (err) {
      console.error(err);
      message.textContent = `The contradictions could not be read (${err.message}); try again.`;
      return null;
    }
    const contradictions = groups.reduce((n, g) => n + g.contradictions, 0);
    count.textContent = groups.length ? ` ${contradictions}` : "";
    empty.hidden = groups.length > 0;
    const chosen = select.value;
    select.replaceChildren(
      ...groups.map((g) => {
        const option = el("option", null, groupName(g));
        option.value = groupValue(g);
        return option;
      }),
    );
    select.disabled = groups.length === 0;
    if (groups.some((g) => groupValue(g) === chosen)) select.value = chosen;
    if (groups.length) await loadMatrix(select.value);
    return groups;
  }

  select.addEventListener("change", () => loadMatrix(select.value));

  return { refresh };
}
