// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * Suggested questions by corpus id. `panel` names the page panel a pill belongs to
 * ("documents" or "evidence", shown while that panel is empty), or null for the pills above the
 * prompt box.
 * @type {Record<string, { text: string, panel: string | null }[]>}
 */
export const SUGGESTIONS = {
  grenfell: [
    {
      text: "What did residents on floor 16 see when they first noticed the fire?",
      panel: null,
    },
    { text: "When did witnesses call 999, and what were they told?", panel: null },
    { text: "How did residents describe the smoke in the stairwell?", panel: null },
    { text: "What advice did the fire service give to residents who called?", panel: null },
    { text: "List the statements in the corpus", panel: "documents" },
    { text: "Show the evidence about smoke in the stairwell", panel: "evidence" },
  ],
};

/**
 * The suggestions for a corpus and a panel (null for the prompt box).
 * @param {string} corpusId
 * @param {string | null} [panel]
 */
export function suggestionsFor(corpusId, panel = null) {
  return (SUGGESTIONS[corpusId] ?? []).filter((s) => s.panel === panel);
}
