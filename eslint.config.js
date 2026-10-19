// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "cdk.out/**",
      ".page-assets/**",
      ".claude/worktrees/**",
      "corpora/*/raw/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
  },
  {
    files: ["packages/ui/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
