// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDownloadUrl, parseLinks, runImport } from "../../corpora/grenfell/import.mjs";
import { parseManifest, parseSources } from "../../packages/core/ingest/run.mjs";

const IMPORT = fileURLToPath(new URL("../../corpora/grenfell/import.mjs", import.meta.url));
const ROBOTS = "User-agent: *\nDisallow: /results\nAllow: /checkout/download\n";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const pdf = (tag) => Buffer.from(`%PDF-1.4\n${tag}\n%%EOF\n`);

const entries = [
  entry("IWS00000001", "id1_1", "GTI 2/AAA1/Z/1"),
  entry("IWS00000002", "id2_1", "GTI 2/BBB2/Z/1"),
];

function entry(evidenceId, discoveryId, reference) {
  return {
    evidence_id: evidenceId,
    file: `${evidenceId}.pdf`,
    url: `https://discovery.nationalarchives.gov.uk/details/r/${discoveryId}`,
    discovery_id: discoveryId,
    reference,
    witness_id: evidenceId,
    role: "resident, floor 16, flat 134",
    floor: 16,
    statement_date: "2018-05-15",
    restrictions_on_use: "None",
    description: "IWS of X",
  };
}

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "grenfell-import-"));
  await mkdir(path.join(dir, "raw"));
  await writeFile(path.join(dir, "sources.json"), JSON.stringify(entries));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function seed(i, body) {
  await writeFile(path.join(dir, "raw", entries[i].file), body);
}
async function downloads(lines) {
  await writeFile(
    path.join(dir, "raw", "downloads.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}
function dl(i, body, over = {}) {
  return {
    file: entries[i].file,
    id: entries[i].discovery_id,
    reference: entries[i].reference,
    url: `https://discovery.nationalarchives.gov.uk/checkout/download/${entries[i].discovery_id}?x=1`,
    fetched_at: "2026-10-18T22:57:42+00:00",
    bytes: body.length,
    sha256: sha(body),
    content_type: "application/pdf",
    description: "IWS of X",
    ...over,
  };
}
const manifestLines = async () =>
  (await readFile(path.join(dir, "manifest.jsonl"), "utf8")).split("\n").filter(Boolean);

describe("runImport with files present", () => {
  it("writes one manifest line a file and none the second time", async () => {
    const a = pdf("a");
    const b = pdf("b");
    await seed(0, a);
    await seed(1, b);
    await downloads([dl(0, a), dl(1, b)]);
    const out = [];
    const counts = await runImport({ dir, log: (l) => out.push(l) });
    expect(counts).toEqual({ present: 2, fetched: 0, missing: 0, mismatch: 0 });
    expect(out[0]).toBe("present IWS00000001");
    const first = await manifestLines();
    expect(first).toHaveLength(2);
    expect(JSON.parse(first[0])).toEqual({
      url: "https://discovery.nationalarchives.gov.uk/checkout/download/id1_1?x=1",
      sha256: sha(a),
      bytes: a.length,
      fetched_at: "2026-10-18T22:57:42Z",
      licence: "OGL-3.0",
      evidence_id: "IWS00000001",
      reference: "GTI 2/AAA1/Z/1",
      discovery_id: "id1_1",
      restrictions_on_use: "None",
    });
    await runImport({ dir, log: () => {} });
    expect(await manifestLines()).toEqual(first);
  });

  it("uses the record page and the file time when downloads.jsonl does not know the file", async () => {
    const a = pdf("a");
    await seed(0, a);
    await runImport({ dir, log: () => {} });
    const row = JSON.parse((await manifestLines())[0]);
    expect(row.url).toBe(entries[0].url);
    expect(row.sha256).toBe(sha(a));
    expect(Number.isNaN(Date.parse(row.fetched_at))).toBe(false);
  });

  it("fails the entry with a hash mismatch and writes the rest", async () => {
    const a = pdf("a");
    const b = pdf("b");
    await seed(0, pdf("changed"));
    await seed(1, b);
    await downloads([dl(0, a), dl(1, b)]);
    const out = [];
    const counts = await runImport({ dir, log: (l) => out.push(l) });
    expect(counts).toMatchObject({ present: 1, mismatch: 1 });
    expect(out[0]).toMatch(/^mismatch IWS00000001 sha256 /);
    expect(await manifestLines()).toHaveLength(1);
  });

  it("exits 1 from the command line when an entry is a mismatch", async () => {
    // the command reads the corpus directory beside the script, so run a copy in the temp tree
    const a = pdf("a");
    await seed(0, pdf("changed"));
    await downloads([dl(0, a)]);
    await mkdir(path.join(dir, "bin"));
    const script = await readFile(IMPORT, "utf8");
    const disc = await readFile(IMPORT.replace("import.mjs", "discovery.mjs"), "utf8");
    await writeFile(path.join(dir, "import.mjs"), script);
    await writeFile(path.join(dir, "discovery.mjs"), disc);
    let status = 0;
    try {
      execFileSync("node", [path.join(dir, "import.mjs")], { stdio: "pipe" });
    } catch (err) {
      status = err.status;
    }
    expect(status).toBe(1);
  });

  it("names a downloaded file that sources.json does not list", async () => {
    const a = pdf("a");
    await seed(0, a);
    await downloads([dl(0, a), dl(1, pdf("b"), { file: "IWS00000999.pdf" })]);
    const out = [];
    await runImport({ dir, log: (l) => out.push(l) });
    expect(out).toContain("unlisted IWS00000999.pdf is in downloads.jsonl and not in sources.json");
  });

  it("reports a missing file when no fetch option is given", async () => {
    const counts = await runImport({ dir, log: () => {} });
    expect(counts.missing).toBe(2);
  });

  it("writes files that the ingest parsers accept", async () => {
    const a = pdf("a");
    const b = pdf("b");
    await seed(0, a);
    await seed(1, b);
    await downloads([dl(0, a), dl(1, b)]);
    await runImport({ dir, log: () => {} });
    const manifest = parseManifest(await readFile(path.join(dir, "manifest.jsonl"), "utf8"));
    const sources = parseSources(await readFile(path.join(dir, "sources.json"), "utf8"));
    expect(manifest.map((m) => m.evidence_id)).toEqual([...sources.keys()]);
  });
});

describe("runImport fetching", () => {
  const host = (responses) => {
    const urls = [];
    const fetchFn = async (url) => {
      const u = new URL(url);
      urls.push(String(url));
      if (u.pathname === "/robots.txt") return new Response(ROBOTS);
      return responses(u);
    };
    return { fetchFn, urls };
  };

  it("builds the link from the order, writes the file, the download line and the manifest line", async () => {
    const body = pdf("fetched");
    const { fetchFn, urls } = host((u) =>
      u.pathname.endsWith("/id1_1")
        ? new Response(body, { headers: { "content-type": "application/pdf" } })
        : new Response("no", { status: 403 }),
    );
    const out = [];
    const counts = await runImport({
      dir,
      fetch: fetchFn,
      delayMs: 0,
      order: "C/369240220207210M",
      receipt: "C/369240220207210M,0,GBP,0,",
      log: (l) => out.push(l),
    });
    expect(counts).toEqual({ present: 0, fetched: 1, missing: 1, mismatch: 0 });
    expect(out).toContain("missing IWS00000002 HTTP 403");
    expect(urls[1]).toBe(
      "https://discovery.nationalarchives.gov.uk/checkout/download/id1_1?reference=GTI%202%2FAAA1%2FZ%2F1&ordernumber=C%2F369240220207210M&digitalreceipt=C%2F369240220207210M%2C0%2CGBP%2C0%2C&edocId=0",
    );
    expect(await readFile(path.join(dir, "raw", "IWS00000001.pdf"))).toEqual(body);
    const dlLine = JSON.parse(
      (await readFile(path.join(dir, "raw", "downloads.jsonl"), "utf8")).trim(),
    );
    expect(dlLine).toMatchObject({ file: "IWS00000001.pdf", id: "id1_1", sha256: sha(body) });
    const row = JSON.parse((await manifestLines())[0]);
    expect(row).toMatchObject({ url: urls[1], sha256: sha(body), bytes: body.length });
  });

  it("refuses a body that is not a PDF", async () => {
    const { fetchFn } = host(
      () => new Response("<html>challenge</html>", { headers: { "content-type": "text/html" } }),
    );
    const out = [];
    const counts = await runImport({
      dir,
      fetch: fetchFn,
      delayMs: 0,
      order: "o",
      receipt: "r",
      log: (l) => out.push(l),
    });
    expect(counts.missing).toBe(2);
    expect(out[0]).toBe("missing IWS00000001 body is not a PDF (content-type text/html)");
    await expect(readFile(path.join(dir, "raw", "IWS00000001.pdf"))).rejects.toThrow();
    await expect(readFile(path.join(dir, "manifest.jsonl"))).rejects.toThrow();
  });

  it("uses pasted links as given", async () => {
    const link =
      "https://discovery.nationalarchives.gov.uk/checkout/download/id2_1?reference=x&ordernumber=y&digitalreceipt=z&edocId=0";
    const body = pdf("linked");
    const { fetchFn, urls } = host(
      () => new Response(body, { headers: { "content-type": "application/pdf" } }),
    );
    const counts = await runImport({
      dir,
      fetch: fetchFn,
      delayMs: 0,
      linksText: `${link}\n`,
      log: () => {},
    });
    expect(counts).toMatchObject({ fetched: 1, missing: 1 });
    expect(urls[1]).toBe(link);
  });
});

describe("links and order", () => {
  it("builds the link with every value encoded", () => {
    expect(
      buildDownloadUrl({
        discoveryId: "id",
        reference: "GTI 2/X/Z/1",
        order: "C/1",
        receipt: "C/1,0,GBP,0,",
      }),
    ).toBe(
      "https://discovery.nationalarchives.gov.uk/checkout/download/id?reference=GTI%202%2FX%2FZ%2F1&ordernumber=C%2F1&digitalreceipt=C%2F1%2C0%2CGBP%2C0%2C&edocId=0",
    );
  });

  it("maps links to record ids and rejects other URLs", () => {
    const map = parseLinks(
      "\nhttps://discovery.nationalarchives.gov.uk/checkout/download/abc_1?a=1\n",
    );
    expect([...map.keys()]).toEqual(["abc_1"]);
    expect(() => parseLinks("https://example.com/other")).toThrow(
      "not a /checkout/download/<id> link",
    );
    expect(() => parseLinks("nope")).toThrow("not a URL");
  });

  it("needs the order number and the receipt together", async () => {
    await expect(runImport({ dir, order: "x", log: () => {} })).rejects.toThrow("go together");
  });
});
