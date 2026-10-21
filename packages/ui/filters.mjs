// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The filter state of the prompt box and what it becomes: the `filters` of a turn frame, the chips
// that show it, and the check that its two dates are in order.

/** @typedef {{ witnesses: string[], role: string, from: string, to: string }} FilterState */

/** @returns {FilterState} */
export const emptyFilters = () => ({ witnesses: [], role: "", from: "", to: "" });

/**
 * The `filters` of a turn frame, or undefined when none is set.
 * @param {FilterState} state
 */
export function frameFilters(state) {
  const out = {};
  if (state.witnesses.length) out.witnesses = [...state.witnesses];
  if (state.role.trim()) out.role = state.role.trim();
  if (state.from) out.from = state.from;
  if (state.to) out.to = state.to;
  return Object.keys(out).length ? out : undefined;
}

/**
 * One chip per active filter: a witness each, then role, from and to.
 * @param {FilterState} state
 * @returns {{ key: string, value?: string, text: string }[]}
 */
export function filterChips(state) {
  const chips = state.witnesses.map((id) => ({ key: "witness", value: id, text: `Witness ${id}` }));
  if (state.role.trim()) chips.push({ key: "role", text: `Role: ${state.role.trim()}` });
  if (state.from) chips.push({ key: "from", text: `From ${state.from}` });
  if (state.to) chips.push({ key: "to", text: `To ${state.to}` });
  return chips;
}

/**
 * The state without one chip's filter.
 * @param {FilterState} state
 * @param {{ key: string, value?: string }} chip
 * @returns {FilterState}
 */
export function withoutChip(state, chip) {
  if (chip.key === "witness") {
    return { ...state, witnesses: state.witnesses.filter((id) => id !== chip.value) };
  }
  return { ...state, [chip.key]: "" };
}

/** The reason the filters cannot be sent, or null. */
export const filterProblem = (state) =>
  state.from && state.to && state.from > state.to ? "The From date is after the To date." : null;

/**
 * The distinct witness ids of a timeline answer and of extra ids, sorted.
 * @param {{ points?: { witnessId?: string | null }[] } | null} timeline
 * @param {string[]} [extra]
 */
export function witnessIds(timeline, extra = []) {
  const ids = new Set(extra.filter(Boolean));
  for (const point of timeline?.points ?? []) if (point.witnessId) ids.add(point.witnessId);
  return [...ids].sort();
}
