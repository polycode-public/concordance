// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The migration trigger: CloudFormation runs it on every deploy of the store stack. A throw
// fails the trigger, and the deploy with it.

import { openDbFromEnv } from "../core/db.mjs";
import { migrate } from "../../scripts/db-migrate.mjs";

export async function handler() {
  const dir = process.env.MIGRATIONS_DIR;
  if (!dir) throw new Error("MIGRATIONS_DIR is not set");
  const db = openDbFromEnv();
  try {
    const applied = await migrate(db, { dir });
    console.log(JSON.stringify({ applied }));
    return { applied };
  } finally {
    await db.close();
  }
}
