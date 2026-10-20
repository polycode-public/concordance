// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  buildSources,
  classify,
  floorOfFlat,
  isFireBrigadeRecord,
  isoDate,
  openPdfRecords,
  parseDescription,
  parseFireBrigadeDescription,
  parseRobots,
  politeClient,
  searchAll,
} from "../../corpora/grenfell/discovery.mjs";

const ROBOTS = `User-agent: *
Disallow: /browse/
Disallow: /details/addtobasket
Disallow: /results
Allow: /API/
Allow: /checkout/download
`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function record(n, over = {}) {
  return {
    id: `id${n}_1`,
    reference: `GTI 2/R${n}/Z/1`,
    title: `IWS${String(n).padStart(8, "0")}.pdf`,
    description: "IWS of Ann Example, Flat 134, 16th Floor Evidence provided by: Firm.",
    closureStatus: "O",
    coveringDates: "2018 May 15",
    ...over,
  };
}

function fakeHost(pages, details = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return new Response(ROBOTS);
    if (u.pathname === "/API/search/records") {
      const page = Number(u.searchParams.get("sps.page"));
      return json({ records: pages[page - 1] ?? [], count: pages.flat().length });
    }
    const m = /^\/API\/records\/v1\/details\/(.+)$/.exec(u.pathname);
    if (m) {
      return json({
        coveringDates: "2018 May 15",
        restrictionsOnUse: null,
        closureStatus: "O",
        ...details[m[1]],
      });
    }
    return new Response("no", { status: 404 });
  };
  return { fetchFn, calls };
}

describe("parseDescription", () => {
  it("reads a statement with flat and floor and exhibits in the same record", () => {
    const p = parseDescription(
      "Ist witness statement of Edward Daffarn & Exhibit ED/1 - ED/26, Flat 134, 16th Floor, Flat, Refurb,Fire, Aftermath.<lb/>\n<p>Evidence provided by: Bhatt Murphy</p>",
    );
    expect(p).toMatchObject({ witness: "Edward Daffarn", flat: 134, floor: 16, kind: "statement" });
  });

  it("swaps back a flat and floor written the wrong way round", () => {
    const p = parseDescription(
      "IWStatement of Behailu Kebede and accompanying Exhibits BK/1 - BK/3 of Flat 4, 16th Floor - Flat, Refurb, Fire & Aftermath Evidence provided by: Bindmans.",
    );
    expect(p).toMatchObject({ flat: 16, floor: 4, flat_as_written: 4, floor_as_written: 16 });
    expect(p.witness).toBe("Behailu Kebede");
  });

  it("keeps the stated floor when the flat number is not a flat", () => {
    const p = parseDescription(
      "IWS of Khadija Yahya relative of Rabia Yahya (survivor) of Flat 18, 18th Floor and nearby Evidence provided by: X.",
    );
    expect(p).toMatchObject({ flat: null, flat_as_written: 18, floor: 18, kind: "relative" });
  });

  it("trusts the flat over a disagreeing floor", () => {
    const p = parseDescription("IWS of A B of Flat 152, Floor 21 Evidence provided by: X.");
    expect(p.floor).toBe(18);
  });

  it("classifies a relative and stops the name before the relation", () => {
    const p = parseDescription(
      "IWS of Marion Telfer relative of Mary Mendy (deceased) Flat 173, 20th Floor Evidence provided by: Birnberg Peirce.",
    );
    expect(p).toMatchObject({ witness: "Marion Telfer", kind: "relative", flat: 173, floor: 20 });
  });

  it("classifies a supplementary statement", () => {
    const p = parseDescription(
      "Supplementary IWS of Sener Macit of Flat 133, Floor 16 - clarification of 999 call transcripts Evidence provided by: Bindmans.",
    );
    expect(p).toMatchObject({ witness: "Sener Macit", kind: "supplementary", floor: 16 });
  });

  it("classifies an exhibit", () => {
    expect(
      classify(
        "Exhibit SA/184 - Email between Shahid Ahmed regarding noise Evidence provided by: X.",
      ),
    ).toBe("exhibit");
  });

  it("returns no floor for a description without flat or floor", () => {
    const p = parseDescription(
      "Phase 2 Witness Statement of Bobby Ross Evidence provided by: Saunders Law.",
    );
    expect(p).toMatchObject({ witness: "Bobby Ross", flat: null, floor: null, kind: "statement" });
  });
});

describe("floorOfFlat", () => {
  it("maps flats to floors", () => {
    expect(floorOfFlat(11)).toBe(4);
    expect(floorOfFlat(16)).toBe(4);
    expect(floorOfFlat(134)).toBe(16);
    expect(floorOfFlat(176)).toBe(20);
    expect(floorOfFlat(206)).toBe(23);
  });
  it("rejects numbers that are not flats", () => {
    expect(floorOfFlat(4)).toBeNull();
    expect(floorOfFlat(18)).toBeNull();
    expect(floorOfFlat(137)).toBeNull();
    expect(floorOfFlat(null)).toBeNull();
  });
});

describe("isoDate", () => {
  it("accepts a full date only", () => {
    expect(isoDate("2018 May 15")).toBe("2018-05-15");
    expect(isoDate("2015 July 1")).toBe("2015-07-01");
    expect(isoDate("2018 May")).toBeNull();
    expect(isoDate(undefined)).toBeNull();
  });
});

describe("robots", () => {
  it("allows and refuses paths by the longest matching rule, ignoring case", () => {
    const r = parseRobots(ROBOTS);
    expect(r.allows("/API/search/records?x=1")).toBe(true);
    expect(r.allows("/checkout/download/abc")).toBe(true);
    expect(r.allows("/Details/AddtoBasket")).toBe(false);
    expect(r.allows("/browse/x")).toBe(false);
  });

  it("refuses a disallowed URL before any request is sent", async () => {
    const { fetchFn, calls } = fakeHost([]);
    const client = politeClient({ fetch: fetchFn, delayMs: 0 });
    await client.init();
    await expect(
      client.get("https://discovery.nationalarchives.gov.uk/results?q=1"),
    ).rejects.toThrow("robots.txt disallows /results");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/robots.txt"]);
  });

  it("sends the User-Agent on every request", async () => {
    const { fetchFn, calls } = fakeHost([[]]);
    const client = politeClient({ fetch: fetchFn, delayMs: 0 });
    await client.init();
    await client.getJson("https://discovery.nationalarchives.gov.uk/API/search/records?sps.page=1");
    for (const c of calls) {
      expect(c.headers["User-Agent"]).toBe("concordance-research/0.1 (+antony@polycode.co.uk)");
    }
  });

  it("fails when robots.txt cannot be read", async () => {
    const client = politeClient({
      fetch: async () => new Response("", { status: 500 }),
      delayMs: 0,
    });
    await expect(client.init()).rejects.toThrow("robots.txt: HTTP 500");
  });
});

describe("search paging", () => {
  it("pages until the count is covered and dedupes by id", async () => {
    const pages = [
      [record(1), record(2)],
      [record(2), record(3)],
    ];
    const fetchFn = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/robots.txt") return new Response(ROBOTS);
      const page = Number(u.searchParams.get("sps.page"));
      expect(u.searchParams.get("sps.sortByOption")).toBe("TITLE_ASCENDING");
      expect(u.searchParams.get("sps.recordSeries")).toBe("GTI 2");
      return json({ records: pages[page - 1] ?? [], count: 250 });
    };
    const client = politeClient({ fetch: fetchFn, delayMs: 0 });
    await client.init();
    const { records, rows } = await searchAll(client);
    expect(rows).toBe(4);
    expect(records.map((r) => r.id)).toEqual(["id1_1", "id2_1", "id3_1"]);
  });
});

describe("openPdfRecords", () => {
  it("keeps open PDFs and prefers the _1 copy of a title", () => {
    const kept = openPdfRecords([
      record(1, { id: "abc", closureStatus: "O" }),
      record(1),
      record(2, { closureStatus: "D" }),
      record(3, { title: "IWS00000003.docx" }),
    ]);
    expect(kept.map((r) => r.id)).toEqual(["id1_1"]);
  });
});

describe("buildSources", () => {
  it("filters floors and exhibits, sorts, and reads the date from the details call", async () => {
    const pages = [
      [
        record(9, {
          description: "IWS of Zed Last, Flat 171, Floor 20 Evidence provided by: F.",
          id: "z_1",
        }),
        record(5, { description: "Exhibit ED/1 - Flat 134, 16th Floor Evidence provided by: F." }),
        record(7, {
          description: "IWS of Low Down, Flat 64, 9th Floor Evidence provided by: F.",
        }),
        record(2, {
          description:
            "Supplementary IWS of Ann Example of Flat 134, 16th Floor Evidence provided by: F.",
          id: "a_1",
        }),
        record(1, { id: "b_1" }),
      ],
    ];
    const { fetchFn } = fakeHost(pages, {
      a_1: { coveringDates: "2019 June" },
      b_1: { restrictionsOnUse: "None" },
    });
    const client = politeClient({ fetch: fetchFn, delayMs: 0 });
    await client.init();
    const { entries, open } = await buildSources(client, 16, 20);
    expect(open).toBe(5);
    expect(entries.map((e) => e.file)).toEqual([
      "IWS00000001.pdf",
      "IWS00000002.pdf",
      "IWS00000009.pdf",
    ]);
    expect(entries[0]).toMatchObject({
      evidence_id: "IWS00000001",
      witness_id: "IWS00000001",
      url: "https://discovery.nationalarchives.gov.uk/details/r/b_1",
      discovery_id: "b_1",
      reference: "GTI 2/R1/Z/1",
      witness: "Ann Example",
      role: "resident, floor 16, flat 134",
      kind: "statement",
      floor: 16,
      flat: 134,
      statement_date: "2018-05-15",
      restrictions_on_use: "None",
      closure: "O",
    });
    expect(entries[1].statement_date).toBeUndefined();
    expect(entries[1].kind).toBe("supplementary");
  });

  it("keeps an included evidence id outside the floor range with its real floor", async () => {
    const pages = [
      [
        record(1, {
          description:
            "IWStatement of Behailu Kebede of Flat 4, 16th Floor Evidence provided by: B.",
          id: "k_1",
        }),
        record(2, { description: "IWS of Low Down, Flat 64, 9th Floor Evidence provided by: F." }),
      ],
    ];
    const { fetchFn } = fakeHost(pages);
    const client = politeClient({ fetch: fetchFn, delayMs: 0 });
    await client.init();
    expect((await buildSources(client, 16, 20)).entries).toHaveLength(0);
    const { entries } = await buildSources(client, 16, 20, { include: ["IWS00000001"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ evidence_id: "IWS00000001", floor: 4, flat: 16 });
  });

  it("writes the same entries on a second run", async () => {
    const pages = [
      [
        record(1),
        record(2, { description: "IWS of B C, Flat 176, Floor 20 Evidence provided by: F." }),
      ],
    ];
    const run = async () => {
      const { fetchFn } = fakeHost(pages);
      const client = politeClient({ fetch: fetchFn, delayMs: 0 });
      await client.init();
      return JSON.stringify((await buildSources(client, 16, 20)).entries);
    };
    expect(await run()).toBe(await run());
  });
});

describe("parseFireBrigadeDescription", () => {
  const TAIL = " Evidence provided by: Metropolitan Police Service.";

  it("reads the name from each dash and capitalisation used", () => {
    for (const head of [
      "Witness Statement - LFB - ",
      "Witness statement - LFB - ",
      "Witness Statement \u2013 LFB - ",
    ]) {
      expect(parseFireBrigadeDescription(`${head}Ann O'Example${TAIL}`)).toMatchObject({
        witness: "Ann O'Example",
        kind: "statement",
        floor: null,
        flat: null,
        role: "London Fire Brigade",
      });
    }
  });

  it("drops a bracketed note from the name", () => {
    const p = parseFireBrigadeDescription(
      `Witness Statement - LFB - Ann Example (references to MET00000001 are to a duplicate statement)${TAIL}`,
    );
    expect(p.witness).toBe("Ann Example");
  });

  it("moves a leading rank into the role", () => {
    const p = parseFireBrigadeDescription(
      `Witness statement - LFB - Station Manager Ann Example${TAIL}`,
    );
    expect(p).toMatchObject({
      witness: "Ann Example",
      role: "London Fire Brigade, Station Manager",
    });
  });
});

describe("isFireBrigadeRecord", () => {
  it("accepts the catalogue shape and refuses other records that mention the brigade", () => {
    const pdf = (description, title = "MET00000001.pdf") => ({ title, description });
    expect(
      isFireBrigadeRecord(pdf("Witness Statement - LFB - Ann Example Evidence provided by: M.")),
    ).toBe(true);
    expect(isFireBrigadeRecord(pdf("Witness statement\u2014LFB\u2014Ann Example"))).toBe(true);
    expect(
      isFireBrigadeRecord(pdf("Witness statement - non-resident - Ann Example. Refers to the LFB")),
    ).toBe(false);
    expect(isFireBrigadeRecord(pdf("Witness Statement - LFB - Ann Example", "notes.doc"))).toBe(
      false,
    );
  });
});

describe("buildSources with fire brigade statements", () => {
  const brigade = (n, over = {}) => ({
    id: `fb${n}`,
    reference: `GTI 2/B${n}/Z`,
    title: `MET${String(n).padStart(8, "0")}.pdf`,
    description:
      "Witness Statement - LFB - Ann Example Evidence provided by: Metropolitan Police Service.",
    closureStatus: "O",
    ...over,
  });

  it("keeps them without a floor, prefers the /Z/1 copy and applies a role override", async () => {
    const pages = [
      [
        record(1),
        brigade(7),
        brigade(7, { id: "fb7_1", reference: "GTI 2/B7/Z/1" }),
        brigade(2, { description: "Witness statement - LFB - Ben Other Evidence provided by: M." }),
      ],
    ];
    const { fetchFn } = fakeHost(pages);
    const client = politeClient({ fetch: fetchFn, delayMs: 0 });
    await client.init();
    const { entries } = await buildSources(client, 16, 20, {
      roles: { MET00000002: "London Fire Brigade, watch manager; floor 16" },
    });
    expect(entries.map((e) => e.file)).toEqual([
      "IWS00000001.pdf",
      "MET00000002.pdf",
      "MET00000007.pdf",
    ]);
    expect(entries[1]).toMatchObject({
      witness: "Ben Other",
      role: "London Fire Brigade, watch manager; floor 16",
      floor: null,
      flat: null,
    });
    expect(entries[2]).toMatchObject({ discovery_id: "fb7_1", role: "London Fire Brigade" });
  });
});
