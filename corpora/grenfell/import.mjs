// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST, politeClient } from "./discovery.mjs";

const LICENCE = "OGL-3.0";
const DEFAULT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The download link for one record from an order number and its digital receipt. */
export function buildDownloadUrl({ discoveryId, reference, order, receipt }) {
  const q = [
    `reference=${encodeURIComponent(reference)}`,
    `ordernumber=${encodeURIComponent(order)}`,
    `digitalreceipt=${encodeURIComponent(receipt)}`,
    "edocId=0",
  ].join("&");
  return `${HOST}/checkout/download/${discoveryId}?${q}`;
}

/** Maps pasted download links, one a line, to their record ids. */
export function parseLinks(text) {
  const byId = new Map();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let u;
    try {
      u = new URL(line);
    } catch (err) {
      throw new Error(`links line ${i + 1}: not a URL`, { cause: err });
    }
    const m = /^\/checkout\/download\/([^/]+)$/i.exec(u.pathname);
    if (!m) throw new Error(`links line ${i + 1}: not a /checkout/download/<id> link`);
    byId.set(m[1], line);
  });
  return byId;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`${file}:${i + 1}: invalid JSON`, { cause: err });
      }
    });
}

const isoUtc = (value) => new Date(value).toISOString().replace(/\.000Z$/, "Z");

function manifestRow(entry, { url, fetchedAt, bytes, sha256 }) {
  const row = {
    url,
    sha256,
    bytes,
    fetched_at: isoUtc(fetchedAt),
    licence: LICENCE,
    evidence_id: entry.evidence_id,
  };
  if (entry.reference) row.reference = entry.reference;
  if (entry.discovery_id) row.discovery_id = entry.discovery_id;
  if (entry.restrictions_on_use) row.restrictions_on_use = entry.restrictions_on_use;
  return row;
}

/**
 * Brings raw/, downloads.jsonl and manifest.jsonl in line with sources.json.
 * @param {{ dir?: string, fetch?: typeof fetch, delayMs?: number, order?: string,
 *   receipt?: string, linksText?: string, log?: (line: string) => void }} [options]
 */
export async function runImport({
  dir = DEFAULT_DIR,
  fetch: doFetch = fetch,
  delayMs = 1000,
  order,
  receipt,
  linksText,
  log = console.log,
} = {}) {
  if ((order == null) !== (receipt == null)) throw new Error("--order and --receipt go together");
  const sources = JSON.parse(await readFile(path.join(dir, "sources.json"), "utf8"));
  if (!Array.isArray(sources)) throw new Error("sources.json: expected an array");
  const rawDir = path.join(dir, "raw");
  const downloadsFile = path.join(rawDir, "downloads.jsonl");
  const manifestFile = path.join(dir, "manifest.jsonl");
  const downloads = new Map((await readJsonl(downloadsFile)).map((d) => [d.file, d]));
  const inManifest = new Map((await readJsonl(manifestFile)).map((m) => [m.evidence_id, m]));
  const links = linksText != null ? parseLinks(linksText) : new Map();
  const canFetch = order != null || linksText != null;
  let client = null;

  const counts = { present: 0, fetched: 0, missing: 0, mismatch: 0 };
  const report = (status, entry, note = "") => {
    counts[status]++;
    log(`${status} ${entry.evidence_id}${note ? ` ${note}` : ""}`);
  };

  for (const entry of sources) {
    if (!entry.evidence_id || !entry.file) {
      throw new Error(`sources.json: an entry has no evidence_id or file (${entry.evidence_id})`);
    }
    const file = path.join(rawDir, entry.file);
    let info = await stat(file).catch((err) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    let fetchedUrl = null;
    let fetchedAt = null;

    if (!info) {
      if (!canFetch) {
        report("missing", entry, "no file in raw/");
        continue;
      }
      const url =
        links.get(entry.discovery_id) ??
        (order != null
          ? buildDownloadUrl({
              discoveryId: entry.discovery_id,
              reference: entry.reference,
              order,
              receipt,
            })
          : null);
      if (!url) {
        report("missing", entry, "no link for this record");
        continue;
      }
      if (!client) {
        client = politeClient({ fetch: doFetch, delayMs });
        await client.init();
      }
      let res;
      try {
        res = await client.get(url);
      } catch (err) {
        report("missing", entry, err.message);
        continue;
      }
      if (!res.ok) {
        report("missing", entry, `HTTP ${res.status}`);
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get("content-type") ?? "";
      if (body.subarray(0, 5).toString("latin1") !== "%PDF-") {
        report("missing", entry, `body is not a PDF (content-type ${type || "none"})`);
        continue;
      }
      await mkdir(rawDir, { recursive: true });
      await writeFile(file, body);
      info = await stat(file);
      fetchedUrl = url;
      fetchedAt = new Date().toISOString();
      const record = {
        file: entry.file,
        id: entry.discovery_id,
        reference: entry.reference,
        url,
        fetched_at: fetchedAt,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        content_type: type,
        description: entry.description,
      };
      await appendFile(downloadsFile, JSON.stringify(record) + "\n");
      downloads.set(entry.file, record);
    }

    const actual = await sha256File(file);
    const known = downloads.get(entry.file);
    const row = inManifest.get(entry.evidence_id);
    const expected = known?.sha256 ?? row?.sha256;
    if (expected && expected !== actual) {
      report("mismatch", entry, `sha256 ${actual} differs from recorded ${expected}`);
      continue;
    }
    if (known && known.bytes !== info.size) {
      report("mismatch", entry, `${info.size} bytes differ from recorded ${known.bytes}`);
      continue;
    }
    if (known?.id && entry.discovery_id && known.id !== entry.discovery_id) {
      report(
        "mismatch",
        entry,
        `downloaded as record ${known.id}, sources say ${entry.discovery_id}`,
      );
      continue;
    }

    if (!row) {
      const line = manifestRow(entry, {
        url: known?.url ?? fetchedUrl ?? entry.url,
        fetchedAt: known?.fetched_at ?? fetchedAt ?? info.mtime,
        bytes: info.size,
        sha256: actual,
      });
      await appendFile(manifestFile, JSON.stringify(line) + "\n");
      inManifest.set(entry.evidence_id, line);
    }
    report(fetchedUrl ? "fetched" : "present", entry);
  }

  const listed = new Set(sources.map((e) => e.file));
  for (const file of downloads.keys()) {
    if (!listed.has(file)) log(`unlisted ${file} is in downloads.jsonl and not in sources.json`);
  }

  log(
    `present ${counts.present}, fetched ${counts.fetched}, missing ${counts.missing}, ` +
      `mismatch ${counts.mismatch}`,
  );
  return counts;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--order") args.order = argv[++i];
    else if (a === "--receipt") args.receipt = argv[++i];
    else if (a === "--links") args.links = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const linksText = args.links ? await readFile(args.links, "utf8") : undefined;
  const counts = await runImport({ order: args.order, receipt: args.receipt, linksText });
  if (counts.mismatch > 0) process.exit(1);
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
