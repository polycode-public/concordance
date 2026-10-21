// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The filters disclosure beside the prompt box and the chip row under it. The witness list comes
// from the timeline route of the facts API (the witnesses with a timed assertion) joined with the
// witnesses of the documents cited this session.
import { withCorpus } from "./corpus.mjs";
import {
  emptyFilters,
  filterChips,
  filterProblem,
  frameFilters,
  withoutChip,
  witnessIds,
} from "./filters.mjs";

const $ = (id) => document.getElementById(id);

/**
 * @param {{ factsUrl?: string }} config
 * @param {{ token: () => string | null, corpus: () => string, extraWitnesses: () => string[] }} hooks
 */
export function mountFilters(config, { token, corpus, extraWitnesses }) {
  const box = $("filters");
  const select = $("filter-witnesses");
  const role = $("filter-role");
  const from = $("filter-from");
  const to = $("filter-to");
  const chipsEl = $("filter-chips");
  const message = $("filter-message");
  let state = emptyFilters();
  let loaded = null;

  function renderChips() {
    const chips = filterChips(state);
    chipsEl.hidden = chips.length === 0;
    chipsEl.replaceChildren(
      ...chips.map((chip) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pill";
        button.textContent = `${chip.text} ×`;
        button.setAttribute("aria-label", `Remove filter: ${chip.text}`);
        button.addEventListener("click", () => {
          state = withoutChip(state, chip);
          sync();
        });
        item.append(button);
        return item;
      }),
    );
    box.querySelector("summary").textContent = chips.length
      ? `Filters (${chips.length})`
      : "Filters";
  }

  function renderOptions(ids) {
    const all = [...new Set([...ids, ...state.witnesses])].sort();
    select.replaceChildren(
      ...all.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = id;
        option.selected = state.witnesses.includes(id);
        return option;
      }),
    );
  }

  /** Writes the state into the controls and the chips. */
  function sync() {
    role.value = state.role;
    from.value = state.from;
    to.value = state.to;
    for (const option of select.options) option.selected = state.witnesses.includes(option.value);
    message.textContent = filterProblem(state) ?? "";
    renderChips();
  }

  async function loadWitnesses() {
    const id = corpus();
    loaded = id;
    const headers = {};
    const bearer = token();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    try {
      const res = await fetch(withCorpus(`${config.factsUrl}/timeline`, id), {
        cache: "no-store",
        headers,
      });
      if (!res.ok) throw new Error(`the facts route answered ${res.status}`);
      const timeline = await res.json();
      if (id !== corpus()) return;
      renderOptions(witnessIds(timeline, extraWitnesses()));
      message.textContent = filterProblem(state) ?? "";
    } catch (err) {
      console.error(err);
      loaded = null;
      renderOptions(witnessIds(null, extraWitnesses()));
      message.textContent = `The witness list could not be read (${err.message}).`;
    }
  }

  box.addEventListener("toggle", () => {
    if (box.open && loaded !== corpus()) loadWitnesses();
  });
  select.addEventListener("change", () => {
    state = { ...state, witnesses: [...select.selectedOptions].map((o) => o.value) };
    sync();
  });
  role.addEventListener("input", () => {
    state = { ...state, role: role.value };
    renderChips();
  });
  from.addEventListener("change", () => {
    state = { ...state, from: from.value };
    sync();
  });
  to.addEventListener("change", () => {
    state = { ...state, to: to.value };
    sync();
  });
  sync();

  return {
    /** The `filters` of the next turn frame, or undefined. */
    value: () => frameFilters(state),
    /** Opens the disclosure and returns the reason the filters cannot be sent, or null. */
    check() {
      const problem = filterProblem(state);
      if (problem) {
        box.open = true;
        message.textContent = problem;
      }
      return problem;
    },
    /** Clears every filter and the witness list; the next opening reads the new corpus's. */
    clear() {
      state = emptyFilters();
      loaded = null;
      select.replaceChildren();
      sync();
      if (box.open) loadWitnesses();
    },
  };
}
