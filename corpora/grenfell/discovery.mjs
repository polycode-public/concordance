// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const HOST = "https://discovery.nationalarchives.gov.uk";
export const USER_AGENT = "concordance-research/0.1 (+antony@polycode.co.uk)";
const FIRST_FLAT_ON_FLOOR_4 = 11;
const FLATS_PER_FLOOR = 10;
const FLATS_USED_PER_FLOOR = 6;

/** Parses the `User-agent: *` group of a robots.txt into a path check. */
export function parseRobots(text) {
  const rules = [];
  let applies = false;
  let sawRule = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (sawRule) {
        applies = false;
        sawRule = false;
      }
      if (m[2] === "*") applies = true;
    } else if (applies && (key === "disallow" || key === "allow")) {
      sawRule = true;
      if (m[2]) rules.push({ allow: key === "allow", pattern: m[2].toLowerCase() });
    }
  }
  const toRegex = (pattern) =>
    new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\\\$$/, "$"),
    );
  const compiled = rules.map((r) => ({ ...r, re: toRegex(r.pattern) }));
  return {
    /** @param {string} path path and query, starting with "/" */
    allows(path) {
      const p = path.toLowerCase();
      let best = null;
      for (const r of compiled) {
        if (!r.re.test(p)) continue;
        if (!best || r.pattern.length > best.pattern.length) best = r;
      }
      return !best || best.allow;
    },
  };
}

/**
 * A client that sends the User-Agent, waits between requests and refuses any URL the host's
 * robots.txt disallows. Call `init()` once before the first request.
 * @param {{ fetch?: typeof fetch, delayMs?: number, host?: string }} [options]
 */
export function politeClient({ fetch: doFetch = fetch, delayMs = 1000, host = HOST } = {}) {
  let robots = null;
  let last = 0;
  const wait = async () => {
    const gap = last + delayMs - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    last = Date.now();
  };
  const request = async (url, init = {}) => {
    await wait();
    return doFetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...init.headers },
    });
  };
  return {
    async init() {
      const res = await request(`${host}/robots.txt`);
      if (!res.ok) throw new Error(`robots.txt: HTTP ${res.status}`);
      robots = parseRobots(await res.text());
    },
    /** @param {string} url */
    async get(url) {
      if (!robots) throw new Error("politeClient.init() has not run");
      const u = new URL(url);
      if (!robots.allows(u.pathname + u.search)) {
        throw new Error(`robots.txt disallows ${u.pathname}`);
      }
      return request(url);
    },
    async getJson(url) {
      const res = await this.get(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    },
  };
}

/** The floor a flat number sits on, or null for a number that is not a flat of floors 4 to 23. */
export function floorOfFlat(flat) {
  if (!Number.isInteger(flat) || flat < FIRST_FLAT_ON_FLOOR_4) return null;
  const unit = flat % FLATS_PER_FLOOR;
  if (unit < 1 || unit > FLATS_USED_PER_FLOOR) return null;
  return 3 + Math.floor((flat - 1) / FLATS_PER_FLOOR);
}

export function stripHtml(html) {
  return html
    .replace(/<(?:lb\s*\/|\/p|\/?br\s*\/?)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const RELATION =
  /\b(?:relative|brother|sister|mother|father|son|daughter|husband|wife|cousin|nephew|niece|aunt|uncle|friend|partner|grandson|granddaughter|grandmother|grandfather)\s+of\b/i;

/**
 * Reads a catalogue description. `flat` and `floor` are the numbers as written; the derived
 * floor comes from the flat number, which the catalogue gets right more often than the floor.
 * @param {string} html
 */
export function parseDescription(html) {
  const description = stripHtml(html);
  const body = description.replace(/\s*Evidence provided by:.*$/i, "").trim();
  const exhibit = /^exhibits?\b/i.test(body);
  const flatMatch = /\bFlat\s+(\d{1,3})\b/i.exec(body);
  const floorMatch =
    /\b(\d{1,2})(?:st|nd|rd|th)\s+Floor\b/i.exec(body) ?? /\bFloor\s+(\d{1,2})\b/i.exec(body);
  const flat = flatMatch ? Number(flatMatch[1]) : null;
  const statedFloor = floorMatch ? Number(floorMatch[1]) : null;

  let kind = "statement";
  if (exhibit) kind = "exhibit";
  else if (RELATION.test(body)) kind = "relative";
  else if (/\bsupplementary\b/i.test(body)) kind = "supplementary";

  const afterPrefix = body.replace(
    /^.*?\b(?:IWS(?:tatement)?|witness statement|statement)\b.*?\bof\s+/i,
    "",
  );
  const name =
    /^(.*?)(?:,|\s+of\s|\s+&\s|\s+-\s|\s+Flat\s+\d|\s+Floor\s|\s+walkway\b|\s+and\s+(?:accompanying|exhibits?)\b|\s+(?:relative|brother|sister|mother|father|son|daughter|husband|wife|cousin|nephew|niece|friend)\b|$)/i
      .exec(afterPrefix)?.[1]
      ?.trim();

  let resolvedFlat = flat;
  let floor = floorOfFlat(flat);
  if (floor == null && flat != null && statedFloor != null && floorOfFlat(statedFloor) === flat) {
    resolvedFlat = statedFloor;
    floor = flat;
  }
  if (floor == null) {
    floor = statedFloor;
    resolvedFlat = null;
  }

  return {
    witness: name || null,
    flat: resolvedFlat,
    flat_as_written: flat,
    floor_as_written: statedFloor,
    floor,
    kind,
    description,
  };
}

/** @param {{ kind: string, floor: number|null, flat: number|null }} p */
export function roleOf(p) {
  if (p.kind === "relative") {
    return p.flat != null
      ? `relative of the Flat ${p.flat} household, floor ${p.floor}`
      : `relative of a resident, floor ${p.floor}`;
  }
  return p.flat != null
    ? `resident, floor ${p.floor}, flat ${p.flat}`
    : `resident, floor ${p.floor}`;
}

const RANKS =
  "(?:Firefighter|Crew Manager|Watch Manager|Station Manager|Group Manager|Area Manager|Deputy Assistant Commissioner|Assistant Commissioner|Deputy Commissioner|Commissioner|Sub Officer|Control Room Officer|Fire Control Officer|FF|CM|WM|SM|GM|DAC|AC)";
const RANK_PREFIX = new RegExp(`^(${RANKS})\\s+(?=\\S+\\s+\\S)`, "i");

const FIRE_BRIGADE_SEARCH = "Witness Statement LFB";
const FIRE_BRIGADE_ROLE = "London Fire Brigade";

/** True for a catalogue record whose description reads "Witness Statement - LFB - <name>". */
export function isFireBrigadeRecord(record) {
  return (
    /\.pdf$/i.test(record.title ?? "") &&
    /^witness statement\s*[-\u2013\u2014]\s*LFB\s*[-\u2013\u2014]\s*\S/i.test(
      stripHtml(record.description ?? ""),
    )
  );
}

/**
 * Reads the description of a London Fire Brigade statement, such as
 * "Witness Statement - LFB - Ann Example (note) Evidence provided by: Metropolitan Police Service."
 * A leading rank stays out of the name and goes into the role.
 * @param {string} html
 */
export function parseFireBrigadeDescription(html) {
  const description = stripHtml(html);
  const afterPrefix = description
    .replace(/\s*Evidence provided by:.*$/i, "")
    .replace(/^.*?\bLFB\b\s*[-\u2013\u2014:]?\s*/i, "")
    .replace(/^witness statement\s*[-\u2013\u2014:]?\s*(?:LFB\s*[-\u2013\u2014:]?\s*)?/i, "");
  const unbracketed = afterPrefix.replace(/\s*\(.*$/, "").trim();
  const rank = RANK_PREFIX.exec(unbracketed)?.[1] ?? null;
  const name = (rank ? unbracketed.slice(rank.length).trim() : unbracketed) || null;
  return {
    witness: name,
    flat: null,
    flat_as_written: null,
    floor_as_written: null,
    floor: null,
    kind: "statement",
    role: rank ? `${FIRE_BRIGADE_ROLE}, ${rank}` : FIRE_BRIGADE_ROLE,
    description,
  };
}

/** Same as parseDescription's kind with the exhibit and no-floor checks callers need. */
export function classify(description) {
  return parseDescription(description).kind;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2018 May 15" becomes "2018-05-15"; any partial date gives null. */
export function isoDate(covering) {
  const m = /^(\d{4}) ([A-Za-z]+) (\d{1,2})$/.exec((covering ?? "").trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return `${m[1]}-${String(month + 1).padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * Pages the series search. Without a sort the API orders ties by relevance score and the pages
 * overlap and skip records, so the sort is part of the query.
 *
 * Pages the series search and returns the unique records by id.
 * @param {ReturnType<typeof politeClient>} client
 * @param {{ onPage?: (page: number, total: number) => void }} [options]
 */
export async function searchAll(client, { onPage, query = "IWS*" } = {}) {
  const byId = new Map();
  let rows = 0;
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      "sps.searchQuery": query,
      "sps.recordSeries": "GTI 2",
      "sps.resultsPageSize": "100",
      "sps.sortByOption": "TITLE_ASCENDING",
      "sps.page": String(page),
    });
    const body = await client.getJson(`${HOST}/API/search/records?${q}`);
    if (!Array.isArray(body.records)) throw new Error(`search page ${page}: no records array`);
    rows += body.records.length;
    for (const r of body.records) byId.set(r.id, r);
    onPage?.(page, body.count);
    if (body.records.length === 0 || page * 100 >= body.count) break;
  }
  return { records: [...byId.values()], rows };
}

/** Keeps open PDF records; where a statement has two open records, keeps the `/Z/1` copy. */
export function openPdfRecords(records) {
  const byTitle = new Map();
  for (const r of records) {
    if (r.closureStatus !== "O" || !/\.pdf$/i.test(r.title ?? "")) continue;
    const have = byTitle.get(r.title);
    if (!have || (r.id.endsWith("_1") && !have.id.endsWith("_1"))) byTitle.set(r.title, r);
  }
  return [...byTitle.values()];
}

/**
 * Builds the sources.json entries for statements on floors lo to hi, then the London Fire
 * Brigade statements, which the floor range does not filter. `roles` maps an evidence id to the
 * role that replaces the one read from the description.
 * @param {ReturnType<typeof politeClient>} client
 * @param {number} lo
 * @param {number} hi
 */
export async function buildSources(client, lo, hi, { onPage, include = [], roles = {} } = {}) {
  const { records, rows } = await searchAll(client, { onPage });
  const open = openPdfRecords(records);
  const picked = [];
  for (const r of open) {
    const p = parseDescription(r.description ?? "");
    const kept = include.includes(r.title.replace(/\.pdf$/i, ""));
    if (p.kind === "exhibit" || p.floor == null) continue;
    if (!kept && (p.floor < lo || p.floor > hi)) continue;
    picked.push({ r, p });
  }
  const brigade = await searchAll(client, { query: FIRE_BRIGADE_SEARCH });
  for (const r of openPdfRecords(brigade.records.filter(isFireBrigadeRecord))) {
    picked.push({ r, p: parseFireBrigadeDescription(r.description ?? "") });
  }
  const entries = [];
  for (const { r, p } of picked) {
    const details = await client.getJson(`${HOST}/API/records/v1/details/${r.id}`);
    const evidenceId = r.title.replace(/\.pdf$/i, "");
    const entry = {
      evidence_id: evidenceId,
      file: r.title,
      url: `${HOST}/details/r/${r.id}`,
      discovery_id: r.id,
      reference: r.reference,
      witness_id: evidenceId,
      witness: p.witness,
      role: roles[evidenceId] ?? p.role ?? roleOf(p),
      kind: p.kind,
      floor: p.floor,
      flat: p.flat,
      flat_as_written: p.flat_as_written,
      floor_as_written: p.floor_as_written,
    };
    const date = isoDate(details.coveringDates);
    if (date) entry.statement_date = date;
    if (details.restrictionsOnUse) entry.restrictions_on_use = details.restrictionsOnUse;
    entry.description = p.description;
    entry.closure = details.closureStatus ?? r.closureStatus;
    entries.push(entry);
  }
  entries.sort(
    (a, b) =>
      (a.floor == null) - (b.floor == null) ||
      (a.floor ?? 0) - (b.floor ?? 0) ||
      (a.flat ?? 0) - (b.flat ?? 0) ||
      a.file.localeCompare(b.file),
  );
  return { entries, rows, unique: records.length, open: open.length };
}

function parseArgs(argv) {
  const args = {
    floors: null,
    out: "corpora/grenfell/sources.json",
    roles: "corpora/grenfell/roles.json",
    include: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--floors") args.floors = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--roles") args.roles = argv[++i];
    else if (argv[i] === "--include") args.include = argv[++i].split(",").filter(Boolean);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const m = /^(\d+)-(\d+)$/.exec(args.floors ?? "");
  if (!m) throw new Error("--floors LO-HI is required, for example --floors 16-20");
  args.lo = Number(m[1]);
  args.hi = Number(m[2]);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = politeClient();
  await client.init();
  const { entries, rows, unique, open } = await buildSources(client, args.lo, args.hi, {
    include: args.include,
    roles: JSON.parse(await readFile(args.roles, "utf8")),
    onPage: (page, total) => console.log(`search page ${page} (${total} rows)`),
  });
  await writeFile(args.out, JSON.stringify(entries, null, 2) + "\n");
  const brigade = entries.filter((e) => e.floor == null).length;
  console.log(
    `${rows} result rows, ${unique} unique records, ${open} open PDF records, ` +
      `${entries.length - brigade} statements on floors ${args.lo}-${args.hi} and ` +
      `${brigade} fire brigade statements written to ${args.out}`,
  );
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
