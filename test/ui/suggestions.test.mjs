// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

import { describe, expect, it } from "vitest";
import { SUGGESTIONS, suggestionsFor } from "../../packages/ui/suggestions.mjs";

describe("suggestions", () => {
  it("gives every corpus prompt pills and one pill per panel", () => {
    for (const corpus of Object.keys(SUGGESTIONS)) {
      expect(suggestionsFor(corpus).length, corpus).toBeGreaterThanOrEqual(3);
      for (const panel of ["documents", "evidence", "reports"]) {
        expect(suggestionsFor(corpus, panel).length, `${corpus} ${panel}`).toBe(1);
      }
      const [report] = suggestionsFor(corpus, "reports");
      expect(report.filename).toMatch(/\.md$/);
    }
  });

  it("lists the corpora the page offers", () => {
    expect(Object.keys(SUGGESTIONS)).toEqual(["grenfell", "ucpi"]);
  });

  it("answers an unknown corpus with no pills", () => {
    expect(suggestionsFor("nowhere")).toEqual([]);
  });
});
