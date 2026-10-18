// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{js,mjs}", "packages/**/*.test.{js,mjs}", "evals/**/*.test.{js,mjs}"],
    exclude: ["node_modules", "cdk.out", ".claude/worktrees/**"],
  },
});
