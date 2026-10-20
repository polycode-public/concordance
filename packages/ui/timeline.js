// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The timeline: one row per witness, each timed assertion a point at the middle of its window
// with the window as a bar. The drawing is a picture only; the list under it carries the same
// points as buttons that open the source, in window order.

const SVG = "http://www.w3.org/2000/svg";
const ROW = 22;
const LEFT = 88;
const WIDTH = 480;
const AXIS = 22;

function svg(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const reference = (point) => {
  const { page, paragraph } = point.locator ?? {};
  const parts = [point.documentId];
  if (page != null) parts.push(`p.${page}`);
  if (paragraph != null) parts.push(`¶${paragraph}`);
  return parts.join(" ");
};

/** The text of one point: who, the window, the claim and the witness's own time words. */
export function pointText(point) {
  const { startClock, endClock } = point.window;
  const claim = [point.polarity === "negative" ? "not" : null, point.predicate, point.objectText]
    .filter(Boolean)
    .join(" ");
  return `${startClock}–${endClock} ${point.witnessId}: ${claim} ("${point.timeText}")`;
}

/** Draws the timeline into `figure` and `list`; `open(documentId, locator)` opens a source. */
export function renderTimeline({ figure, list, empty }, timeline, open) {
  const points = timeline?.points ?? [];
  figure.replaceChildren();
  list.replaceChildren();
  empty.hidden = points.length > 0;
  empty.textContent = timeline?.unparsed
    ? `No assertion states a clock time; ${timeline.unparsed} state a time in other words.`
    : "No assertion states a clock time.";
  if (!points.length) {
    figure.hidden = true;
    return;
  }
  const witnesses = [...new Set(points.map((p) => p.witnessId))].sort();
  const from = Math.min(...points.map((p) => p.window.startMinutes));
  const to = Math.max(...points.map((p) => p.window.endMinutes));
  const span = Math.max(to - from, 10);
  const x = (minutes) => LEFT + ((minutes - from) / span) * (WIDTH - LEFT - 12);
  const height = witnesses.length * ROW + AXIS;
  const drawing = svg("svg", {
    viewBox: `0 0 ${WIDTH} ${height}`,
    class: "timeline-drawing",
    "aria-hidden": "true",
    focusable: "false",
  });
  witnesses.forEach((w, i) => {
    const y = i * ROW + ROW / 2;
    const label = svg("text", { x: 0, y: y + 4, class: "timeline-witness" });
    label.textContent = w;
    drawing.append(
      label,
      svg("line", { x1: LEFT, x2: WIDTH - 12, y1: y, y2: y, class: "timeline-row" }),
    );
  });
  for (const p of points) {
    const y = witnesses.indexOf(p.witnessId) * ROW + ROW / 2;
    drawing.append(
      svg("line", {
        x1: x(p.window.startMinutes),
        x2: x(p.window.endMinutes),
        y1: y,
        y2: y,
        class: "timeline-bar",
      }),
      svg("circle", {
        cx: x((p.window.startMinutes + p.window.endMinutes) / 2),
        cy: y,
        r: 4,
        class: p.polarity === "negative" ? "timeline-point negative" : "timeline-point",
      }),
    );
  }
  for (const [minutes, anchor] of [
    [from, "start"],
    [to, "end"],
  ]) {
    const tick = svg("text", {
      x: x(minutes),
      y: height - 6,
      "text-anchor": anchor,
      class: "timeline-tick",
    });
    tick.textContent =
      points.find((p) => p.window.startMinutes === minutes)?.window.startClock ??
      points.find((p) => p.window.endMinutes === minutes).window.endClock;
    drawing.append(tick);
  }
  figure.append(drawing);
  figure.hidden = false;

  list.append(
    ...points.map((p) => {
      const item = el("li", "timeline-item");
      item.dataset.assertion = p.assertionId;
      const button = el("button", "quiet small timeline-open", pointText(p));
      button.type = "button";
      button.title = reference(p);
      button.setAttribute("aria-label", `${pointText(p)}. Open ${reference(p)}`);
      button.addEventListener("click", () => open(p.documentId, p.locator));
      item.append(button);
      return item;
    }),
  );
}
