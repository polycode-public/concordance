// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Starts the laptop server. `npm run dev` runs server.mjs directly, which calls the same main().
import { main } from "./server.mjs";

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
