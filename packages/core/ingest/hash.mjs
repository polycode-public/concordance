// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

/**
 * Streams a file through SHA-256 and returns the hex digest.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
