// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The spend strip under the header: the project budget's month-to-date spend against its
// limit, read once per page load. A null body (the laptop) keeps the strip hidden. Its button
// opens the history by inquiry: the store's model use per corpus and day at list prices, as a
// line graph and a table with the same figures.

export const CELLS = 10;
export const AMBER_HEADROOM = 0.2;
export const RED_HEADROOM = 0.05;
export const REACHED = "Budget reached. The page still opens documents.";
export const UNREADABLE = "The spend could not be read; reload the page to try again.";
export const ESTIMATE_NOTE =
  "The figures by inquiry are estimates: the model tokens this application stored, priced at list prices. The strip above is the whole application's actual spend against its shared cap.";
export const HISTORY_DAYS = 30;
export const GRAPH = Object.freeze({
  width: 560,
  height: 220,
  left: 48,
  right: 12,
  top: 12,
  bottom: 28,
});

/** An amount as the strip writes it: `$3.42`, `$25`, or `3.42 EUR`. */
export function money(amount, unit) {
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return unit === "USD" ? `$${text}` : `${text} ${unit}`;
}

/**
 * What the strip shows for one budget read.
 * @param {{ actual: number, limit: number, unit: string }} spend
 * @returns {{ text: string, filled: number, level: 'ok' | 'amber' | 'red', note: string }}
 */
export function spendView({ actual, limit, unit }) {
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || limit <= 0) {
    throw new Error("the spend needs a finite actual amount and a positive limit");
  }
  const headroom = (limit - actual) / limit;
  const level = headroom <= RED_HEADROOM ? "red" : headroom <= AMBER_HEADROOM ? "amber" : "ok";
  const filled = Math.min(CELLS, Math.max(0, Math.round((actual / limit) * CELLS)));
  return {
    text: `This month ${money(actual, unit)} of ${money(limit, unit)}`,
    filled,
    level,
    note: actual >= limit ? REACHED : "",
  };
}

/**
 * The graph of a history: one polyline per corpus over the days, scaled to the largest day.
 * @param {{ days: string[], series: { corpus: string, points: { day: string, cost: number }[] }[] }} history
 * @param {{ id: string, name: string }[]} corpora the names, in drop-list order
 */
export function historyView(history, corpora) {
  const { width, height, left, right, top, bottom } = GRAPH;
  const days = history.days;
  const peak = Math.max(0, ...history.series.flatMap((s) => s.points.map((p) => p.cost)));
  const max = peak > 0 ? peak : 1;
  const x = (i) => left + (days.length > 1 ? (i / (days.length - 1)) * (width - left - right) : 0);
  const y = (cost) => top + (1 - cost / max) * (height - top - bottom);
  const order = corpora.map((c) => c.id);
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  const lines = [...history.series]
    .sort((a, b) => rank(a.corpus) - rank(b.corpus) || a.corpus.localeCompare(b.corpus))
    .map((s) => ({
      corpus: s.corpus,
      name: corpora.find((c) => c.id === s.corpus)?.name ?? s.corpus,
      total: s.points.reduce((n, p) => n + p.cost, 0),
      points: s.points.map((p, i) => `${x(i).toFixed(1)},${y(p.cost).toFixed(1)}`).join(" "),
    }));
  return { width, height, max: peak, lines, first: days[0], last: days.at(-1), x, y };
}

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const cents = (amount, unit) => money(Math.round(amount * 100) / 100, unit);

function drawHistory(box, history, corpora) {
  const view = historyView(history, corpora);
  const unit = history.currency;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${view.width} ${view.height}`,
    class: "history-graph",
    role: "img",
    "aria-labelledby": "spend-history-graph-title",
  });
  const title = svgEl("title", { id: "spend-history-graph-title" });
  title.textContent = `Estimated model spend by inquiry and day, ${view.first} to ${view.last}: ${view.lines
    .map((l) => `${l.name} ${cents(l.total, unit)}`)
    .join("; ")}.`;
  svg.append(title);
  const axis = (x1, y1, x2, y2) => svgEl("line", { x1, y1, x2, y2, class: "history-axis" });
  const bottom = view.height - GRAPH.bottom;
  svg.append(
    axis(GRAPH.left, GRAPH.top, GRAPH.left, bottom),
    axis(GRAPH.left, bottom, view.width - GRAPH.right, bottom),
  );
  const label = (text, attrs) => {
    const node = svgEl("text", { class: "history-label", ...attrs });
    node.textContent = text;
    return node;
  };
  svg.append(
    label(cents(view.max, unit), { x: GRAPH.left - 4, y: GRAPH.top + 4, "text-anchor": "end" }),
    label(cents(0, unit), { x: GRAPH.left - 4, y: bottom, "text-anchor": "end" }),
    label(view.first, { x: GRAPH.left, y: view.height - 8, "text-anchor": "start" }),
    label(view.last, { x: view.width - GRAPH.right, y: view.height - 8, "text-anchor": "end" }),
  );
  view.lines.forEach((line, i) => {
    svg.append(
      svgEl("polyline", {
        points: line.points,
        class: `history-line series-${i % 4}`,
        "data-corpus": line.corpus,
      }),
    );
  });

  const legend = el("ul", "history-legend small");
  view.lines.forEach((line, i) => {
    const item = el("li");
    const swatch = svgEl("svg", {
      viewBox: "0 0 24 8",
      class: "history-swatch",
      "aria-hidden": "true",
    });
    swatch.append(
      svgEl("line", { x1: 0, y1: 4, x2: 24, y2: 4, class: `history-line series-${i % 4}` }),
    );
    item.append(swatch, ` ${line.name}: ${cents(line.total, unit)}`);
    legend.append(item);
  });

  const table = el("table", "history-table small");
  const caption = el("caption", null, "Estimated model spend by day");
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", null, "Day"), ...view.lines.map((l) => el("th", null, l.name)));
  for (const th of headRow.children) th.scope = "col";
  head.append(headRow);
  const body = el("tbody");
  history.days.forEach((day, d) => {
    const tr = el("tr");
    const th = el("th", null, day);
    th.scope = "row";
    tr.append(th);
    for (const line of view.lines) {
      const series = history.series.find((s) => s.corpus === line.corpus);
      tr.append(el("td", null, cents(series.points[d].cost, unit)));
    }
    body.append(tr);
  });
  table.append(caption, head, body);
  const tableBox = el("div", "history-table-box");
  tableBox.tabIndex = 0;
  tableBox.setAttribute("role", "region");
  tableBox.setAttribute("aria-label", "Estimated model spend by day, as a table");
  tableBox.append(table);

  const parts = [el("p", "small soft", ESTIMATE_NOTE)];
  if (!view.lines.length) parts.push(el("p", "empty small", "No model use is stored yet."));
  else parts.push(svg, legend, tableBox);
  if (history.unpriced?.length) {
    parts.push(
      el(
        "p",
        "small soft",
        `No list price for ${history.unpriced.join(", ")}; left out of the figures.`,
      ),
    );
  }
  box.replaceChildren(...parts);
}

/**
 * Wires the history panel to a button in the strip.
 * @param {{ spendUrl: string, corpora: { id: string, name: string }[] }} config
 * @param {() => string | null} token
 */
function mountHistory(strip, config, token) {
  const panel = document.getElementById("spend-history");
  const body = document.getElementById("spend-history-body");
  const close = document.getElementById("spend-history-close");
  const opener = el("button", "quiet small spend-history-open", "Spend by inquiry");
  opener.type = "button";
  opener.setAttribute("aria-controls", "spend-history");
  opener.setAttribute("aria-expanded", "false");
  const hide = () => {
    panel.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    opener.focus();
  };
  opener.addEventListener("click", async () => {
    if (!panel.hidden) {
      hide();
      return;
    }
    panel.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    body.replaceChildren(el("p", "small soft", "Reading the history"));
    close.focus();
    try {
      const bearer = token();
      const url = new URL(`${config.spendUrl}/history`, location.href);
      url.searchParams.set("days", String(HISTORY_DAYS));
      const res = await fetch(url, {
        cache: "no-store",
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      });
      if (!res.ok) throw new Error(`the spend history route answered ${res.status}`);
      drawHistory(body, await res.json(), config.corpora);
    } catch (err) {
      console.error(err);
      body.replaceChildren(
        el("p", "note", `The history could not be read (${err.message}); try again.`),
      );
    }
  });
  close.addEventListener("click", hide);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      hide();
    }
  });
  strip.append(opener);
}

function draw(strip, view) {
  const cells = document.createElement("span");
  cells.className = "cells";
  cells.setAttribute("aria-hidden", "true");
  for (let i = 0; i < CELLS; i++) {
    const cell = document.createElement("span");
    cell.className = "cell";
    cell.dataset.filled = i < view.filled ? "yes" : "no";
    cells.append(cell);
  }
  const parts = [Object.assign(document.createElement("span"), { textContent: view.text }), cells];
  if (view.note) {
    parts.push(
      Object.assign(document.createElement("span"), { className: "note", textContent: view.note }),
    );
  }
  strip.dataset.level = view.level;
  strip.replaceChildren(...parts);
  strip.hidden = false;
}

/**
 * Reads the spend once and draws the strip with the button that opens the history.
 * @param {{ spendUrl?: string, corpora: { id: string, name: string }[] }} config
 * @param {() => string | null} token the id token, when the page signs in
 */
export async function showSpend(config, token) {
  if (typeof config.spendUrl !== "string") throw new Error("config.json has no spendUrl");
  const strip = document.getElementById("spend");
  try {
    const bearer = token();
    const res = await fetch(config.spendUrl, {
      cache: "no-store",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    if (!res.ok) throw new Error(`the spend route answered ${res.status}`);
    const body = await res.json();
    if (body === null) return;
    draw(strip, spendView(body));
    mountHistory(strip, config, token);
  } catch (err) {
    console.error(err);
    strip.dataset.level = "red";
    strip.replaceChildren(
      Object.assign(document.createElement("span"), { className: "note", textContent: UNREADABLE }),
    );
    strip.hidden = false;
  }
}
