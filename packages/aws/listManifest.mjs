// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The ingest state machine's item list: the parsed manifest of one corpus.

import { corpusInfo, parseManifest } from "../core/ingest/run.mjs";

/** Step Functions refuses a state larger than 256 KiB. */
export const STATE_LIMIT_BYTES = 256 * 1024;
/** Room in the state for each item's Map result, which the state holds beside the items. */
export const RESULT_BYTES_PER_ITEM = 512;

/**
 * Reads objects from the corpus bucket: the bytes, or null when the key does not exist.
 * @param {Record<string, string | undefined>} [env]
 */
export function corpusObjects(env = process.env) {
  const Bucket = env.CORPUS_BUCKET;
  if (!Bucket) throw new Error("CORPUS_BUCKET is not set");
  let ready;
  const load = () =>
    (ready ??= (async () => {
      const sdk = await import("@aws-sdk/client-s3");
      return { sdk, client: new sdk.S3Client({}) };
    })());
  return async (Key) => {
    const { sdk, client } = await load();
    try {
      const { Body } = await client.send(new sdk.GetObjectCommand({ Bucket, Key }));
      return await Body.transformToByteArray();
    } catch (err) {
      if (err?.name === "NoSuchKey") return null;
      throw err;
    }
  };
}

/** @param {{ s3GetObject: (key: string) => Promise<Uint8Array | null> }} deps */
export function createHandler({ s3GetObject }) {
  return async (event) => {
    const corpus = event?.corpus;
    corpusInfo(corpus);
    const key = `${corpus}/manifest.jsonl`;
    const bytes = await s3GetObject(key);
    if (!bytes) throw new Error(`${key} is not in the corpus bucket`);
    const items = parseManifest(new TextDecoder().decode(bytes), key);
    const output = { corpus, items };
    const size = Buffer.byteLength(JSON.stringify(output)) + items.length * RESULT_BYTES_PER_ITEM;
    // A larger corpus needs a Distributed Map with an S3 item reader over the manifest.
    if (size > STATE_LIMIT_BYTES) {
      throw new Error(
        `${key} has ${items.length} rows; with their results the state is ${size} bytes, over the ${STATE_LIMIT_BYTES}-byte state limit`,
      );
    }
    return output;
  };
}

let objects;
export const handler = createHandler({ s3GetObject: (key) => (objects ??= corpusObjects())(key) });
