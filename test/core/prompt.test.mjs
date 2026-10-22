// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

import { describe, expect, it } from "vitest";
import {
  ABSTAIN_PHRASE,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  answerMessages,
} from "../../packages/core/prompt.mjs";

describe("the closed-world prompt", () => {
  it("tells the model to abstain with the one phrase and nothing else", () => {
    expect(SYSTEM_PROMPT).toContain(`'the corpus does not say'`);
    expect(SYSTEM_PROMPT).toMatch(/write nothing else/);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain(ABSTAIN_PHRASE);
  });

  it("keeps the answer to the question and each citation to the block that states it", () => {
    expect(SYSTEM_PROMPT).toMatch(/Answer only what the question asks/);
    expect(SYSTEM_PROMPT).toMatch(/never cite a block for its context/);
    expect(SYSTEM_PROMPT).toMatch(/the figure of the thing the question names/);
  });

  it("carries its version and the evidence under the question", () => {
    expect(PROMPT_VERSION).toBe("answer-closed-world-v5");
    const [system, user] = answerMessages("Who called 999?", [
      { header: "[h]", text: "I called 999." },
    ]);
    expect(system.content).toBe(SYSTEM_PROMPT);
    expect(user.content).toBe("[E1] [h]\nI called 999.\n\nQuestion: Who called 999?");
  });
});
