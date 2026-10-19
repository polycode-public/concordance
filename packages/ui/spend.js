// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The spend strip under the header: the project budget's month-to-date spend against its
// limit, read once per page load. A null body (the laptop) keeps the strip hidden.

export const CELLS = 10;
export const AMBER_HEADROOM = 0.2;
export const RED_HEADROOM = 0.05;
export const REACHED = "Budget reached. The page still opens documents.";
export const UNREADABLE = "The spend could not be read; reload the page to try again.";

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
 * Reads the spend once and draws the strip.
 * @param {{ spendUrl?: string }} config
 * @param {string | null} token the id token, when the page signs in
 */
export async function showSpend(config, token) {
  if (typeof config.spendUrl !== "string") throw new Error("config.json has no spendUrl");
  const strip = document.getElementById("spend");
  try {
    const res = await fetch(config.spendUrl, {
      cache: "no-store",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`the spend route answered ${res.status}`);
    const body = await res.json();
    if (body === null) return;
    draw(strip, spendView(body));
  } catch (err) {
    console.error(err);
    strip.dataset.level = "red";
    strip.replaceChildren(
      Object.assign(document.createElement("span"), { className: "note", textContent: UNREADABLE }),
    );
    strip.hidden = false;
  }
}
