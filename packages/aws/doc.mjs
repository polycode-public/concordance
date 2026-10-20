// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// GET /doc/{id} on the HTTP API: a redirect to a presigned GET of the original PDF, under the
// corpus the store records for the document. The gateway's JWT authorizer checks the Cognito id
// token before this runs.

export const PRESIGN_SECONDS = 600;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when a value can name one key segment: no separators, no "..". */
export const isSafeId = (value) =>
  typeof value === "string" && value.length <= 128 && SAFE_ID.test(value) && !value.includes("..");

/** The bucket key of a document's original PDF. */
export const originalKey = (corpus, documentId) => `${corpus}/raw/${documentId}.pdf`;

/**
 * @param {{ openDb: () => Promise<{ query: Function, close?: Function }>,
 *   originals: { exists: (key: string) => Promise<boolean>,
 *   presign: (key: string) => Promise<string> } }} deps
 */
export function createHandler({ openDb, originals }) {
  return async function handler(event) {
    const id = event.pathParameters?.id;
    if (!isSafeId(id)) return { statusCode: 400 };
    const db = await openDb();
    let rows;
    try {
      ({ rows } = await db.query("SELECT corpus FROM documents WHERE id = $1", [id]));
    } finally {
      await db.close?.();
    }
    if (!rows.length) return { statusCode: 404 };
    const { corpus } = rows[0];
    if (!isSafeId(corpus)) throw new Error(`document ${id} has an unsafe corpus name`);
    const key = originalKey(corpus, id);
    if (!(await originals.exists(key))) return { statusCode: 404 };
    return {
      statusCode: 302,
      headers: { location: await originals.presign(key), "cache-control": "no-store" },
    };
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const { openDatabase, originalsBucket } = await import("./clients.mjs");
    realHandler = createHandler({
      openDb: () => openDatabase(),
      originals: originalsBucket(process.env, PRESIGN_SECONDS),
    });
  }
  return realHandler(event);
}
