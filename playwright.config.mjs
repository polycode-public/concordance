// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.mjs",
  reporter: [["list"]],
  workers: 1,
  use: { browserName: "chromium", trace: "off" },
});
