// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/**
 * Suggested questions by corpus id. `panel` names the page panel a pill belongs to
 * ("documents", "evidence" or "reports", shown while that panel is empty), or null for the pills above the
 * prompt box.
 * @type {Record<string, { text: string, panel: string | null, filename?: string }[]>}
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
    {
      text: "Write me a report on how residents first became aware of the fire",
      panel: "reports",
      filename: "first-awareness.md",
    },
  ],
  ucpi: [
    {
      text: "What did HN43 say about the reports he made on the Stephen Lawrence campaign?",
      panel: null,
    },
    {
      text: "How do the managers describe the way undercover reporting was authorised?",
      panel: null,
    },
    {
      text: "How did the people reported on describe meeting the undercover officer?",
      panel: null,
    },
    { text: "What did witnesses say about Militant and the Socialist Party?", panel: null },
    { text: "List the statements in the corpus", panel: "documents" },
    { text: "Show the evidence about cover names", panel: "evidence" },
    {
      text: "Write me a report on how the Special Demonstration Squad reported on Militant",
      panel: "reports",
      filename: "militant-reporting.md",
    },
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
