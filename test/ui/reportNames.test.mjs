// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  FILENAME,
  FILENAME_MAX,
  editTarget,
  slugFilename,
} from "../../packages/ui/reportNames.mjs";

describe("slugFilename", () => {
  it("joins the first words of the topic with dashes", () => {
    expect(slugFilename("How residents first became aware of the fire")).toBe(
      "how-residents-first-became-aware-of.md",
    );
  });

  it("drops punctuation and accents the route would refuse", () => {
    expect(slugFilename("  Smoke: the stairs & lift!  ")).toBe("smoke-the-stairs-lift.md");
  });

  it("falls back to report for a topic with no letters or digits", () => {
    expect(slugFilename("???")).toBe("report.md");
  });

  it("always satisfies the route's pattern and length", () => {
    for (const topic of ["x".repeat(500), "a-b", "9 lives", "Ünïcode only: ñ"]) {
      const name = slugFilename(topic);
      expect(name).toMatch(FILENAME);
      expect(name.length).toBeLessThanOrEqual(FILENAME_MAX);
    }
  });
});

describe("editTarget", () => {
  const names = ["stairs.md", "first-awareness.md"];

  it("names the report a message mentions", () => {
    expect(editTarget("In first-awareness.md, shorten the second section", names)).toBe(
      "first-awareness.md",
    );
  });

  it("ignores case and a closing full stop", () => {
    expect(editTarget("Rewrite Stairs.md.", names)).toBe("stairs.md");
  });

  it("returns null for a filename the user does not have", () => {
    expect(editTarget("Edit lift.md please", names)).toBeNull();
  });

  it("returns null for a name that only ends with a known one", () => {
    expect(editTarget("see old-stairs.md and mystairs.md", names)).toBeNull();
  });

  it("returns null for a message with no filename", () => {
    expect(editTarget("When did residents see smoke?", names)).toBeNull();
  });
});
