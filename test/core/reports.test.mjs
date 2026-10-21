// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import {
  REPORT_LIMITS,
  REPORT_PROMPT_VERSION,
  REPORT_SYSTEM_PROMPT,
  deleteReport,
  keepKnownTags,
  latestReport,
  listReports,
  parseReport,
  readOutline,
  reportScores,
  reportVersions,
  reportsResponse,
  requestReport,
  runReport,
  storeReport,
  stripTags,
} from "../../packages/core/reports.mjs";
import { isReportFilename } from "../../packages/core/protocol.mjs";
import { MAX_HITS } from "../../packages/core/retrieval/expand.mjs";
import { CHUNK_ROWS, DOCUMENT_ROWS, createReportsStore } from "./reportsFakeStore.mjs";

const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";

const TWO_SECTIONS = {
  title: "Smoke on the stairs",
  sections: [
    { heading: "The stairs", evidence: [1] },
    { heading: "The lift", evidence: [2] },
  ],
};

/** A fake provider whose chat calls answer with the given texts in order. */
function scripted(texts, outline = TWO_SECTIONS) {
  const outlines = [];
  const chats = [];
  const base = createFakeProvider({
    tokens: [],
    delayMs: 0,
    embedDim: 1024,
    extractJson: (args) => {
      outlines.push(args);
      return typeof outline === "function" ? outline(args) : outline;
    },
  });
  const queue = [...texts];
  return {
    ...base,
    outlines,
    chats,
    async chat(args) {
      chats.push(args);
      if (!queue.length) throw new Error("the script has no more replies");
      return createFakeProvider({ tokens: [queue.shift()], delayMs: 0 }).chat(args);
    },
  };
}

describe("report helpers", () => {
  it("accepts a lower-case .md filename and nothing else", () => {
    expect(isReportFilename("stairs-and-lift.md")).toBe(true);
    for (const bad of ["Stairs.md", "-x.md", "x.txt", "../x.md", "a b.md", `${"a".repeat(126)}.md`])
      expect(isReportFilename(bad)).toBe(false);
  });

  it("drops a tag that names no block it was given and counts it", () => {
    expect(keepKnownTags("Dark [E1, E9]. Hot [E9]. Cold [E2].", new Set([1, 2]))).toEqual({
      text: "Dark [E1]. Hot. Cold [E2].",
      dropped: 2,
    });
    expect(stripTags("Dark [E1][E2]. Hot [E3, E4].")).toBe("Dark. Hot.");
  });

  it("reads a stored body back into its title and sections", () => {
    expect(parseReport("# T\n\n## A\n\nOne [E1].\n\n## B\n\nTwo.")).toEqual({
      title: "T",
      sections: [
        { heading: "A", text: "One [E1]." },
        { heading: "B", text: "Two." },
      ],
    });
  });

  it("keeps an outline's known block numbers, counts the rest and needs a title", () => {
    const blocks = [{ evidence: 1 }, { evidence: 2 }];
    const read = readOutline(
      { title: "# T\n", sections: [{ heading: "A", evidence: [2, 9, 2] }, { heading: "B" }] },
      blocks,
    );
    expect(read.title).toBe("T");
    expect(read.outlineSections.map((s) => [s.heading, s.blocks.map((b) => b.evidence)])).toEqual([
      ["A", [2]],
      ["B", []],
    ]);
    expect(read.droppedEvidence).toBe(1);
    expect(() => readOutline({ sections: [{ heading: "A" }] }, blocks)).toThrow(/no title/);
    expect(() => readOutline({ title: "T", sections: [] }, blocks)).toThrow(/no sections/);
  });
});

describe("runReport", () => {
  it("drafts an outline whose headings name their blocks, over more hits than a turn", async () => {
    const db = createReportsStore();
    const provider = scripted(["The stairs were dark [E1].", "The lift stopped [E2]."]);
    const stages = [];
    await runReport({
      corpus: "grenfell",
      topic: "The stairs",
      provider,
      db,
      onStage: (s) => stages.push(s),
    });
    expect(stages).toEqual(["drafting", "writing", "reviewing"]);
    expect(REPORT_LIMITS.maxHits).toBeGreaterThan(MAX_HITS);
    expect(provider.outlines).toHaveLength(1);
    const [{ prompt, schema }] = provider.outlines;
    expect(prompt).toContain("[E1] [Grenfell Inquiry | Witness IWS1 | p.3 para 11]");
    expect(prompt).toContain("[E2] [Grenfell Inquiry | Witness IWS2 | p.2 para 4]");
    expect(prompt).toContain("Report topic: The stairs");
    expect(schema.properties.sections.items.required).toEqual(["heading", "evidence"]);
  });

  it("writes two sections, every sentence cited or abstaining, at temperature 0", async () => {
    const db = createReportsStore();
    const provider = scripted([
      "The stairs were dark [E1]. Smoke filled them [E1].",
      "The corpus does not say how the lift was called.",
    ]);
    const report = await runReport({
      corpus: "grenfell",
      topic: "The stairs and the lift",
      provider,
      db,
    });
    expect(report.body).toBe(
      [
        "# Smoke on the stairs",
        "## The stairs",
        "The stairs were dark [E1]. Smoke filled them [E1].",
        "## The lift",
        "The corpus does not say how the lift was called.",
      ].join("\n\n"),
    );
    expect(report.citations).toEqual([
      { evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } },
    ]);
    for (const mark of report.checks.marks) expect(mark.supported || mark.abstains).toBe(true);
    expect(report.checks).toMatchObject({
      sentences: 3,
      supported: 2,
      abstained: 1,
      flaggedRatio: 0,
      flagged: 0,
      removed: 0,
      droppedCitations: 0,
      promptVersion: REPORT_PROMPT_VERSION,
      model: "fake-chat",
    });
    expect(report.promptVersion).toBe(REPORT_PROMPT_VERSION);
    expect(provider.chats).toHaveLength(2);
    for (const call of provider.chats) {
      expect(call.temperature).toBe(0);
      expect(call.promptVersion).toBe(REPORT_PROMPT_VERSION);
      expect(call.messages[0]).toEqual({ role: "system", content: REPORT_SYSTEM_PROMPT });
    }
    expect(provider.chats[0].messages[1].content).toContain("[E1] [Grenfell");
    expect(provider.chats[0].messages[1].content).not.toContain("[E2]");
    expect(provider.chats[0].messages[1].content).toContain("Section heading: The stairs");
  });

  it("sends a flagged sentence back once and keeps the rewrite", async () => {
    const db = createReportsStore();
    const provider = scripted(
      [
        "The stairs were dark [E1]. Nobody came.",
        "The stairs were dark [E1]. Nobody came up them [E1].",
      ],
      { title: "T", sections: [{ heading: "The stairs", evidence: [1] }] },
    );
    const report = await runReport({ corpus: "grenfell", topic: "The stairs", provider, db });
    expect(provider.chats).toHaveLength(2);
    const rewrite = provider.chats[1].messages;
    expect(rewrite.at(-2)).toEqual({
      role: "assistant",
      content: "The stairs were dark [E1]. Nobody came.",
    });
    expect(rewrite.at(-1).content).toContain("1. Nobody came.");
    expect(report.body).toContain("Nobody came up them [E1].");
    expect(report.checks).toMatchObject({ flagged: 1, rewritten: 1, removed: 0, supported: 2 });
  });

  it("removes a sentence the one rewrite leaves without a citation", async () => {
    const db = createReportsStore();
    const provider = scripted(["Dark [E1]. Nobody came.", "Dark [E1]. Nobody came."], {
      title: "T",
      sections: [{ heading: "The stairs", evidence: [1] }],
    });
    const report = await runReport({ corpus: "grenfell", topic: "The stairs", provider, db });
    expect(provider.chats).toHaveLength(2);
    expect(report.body).toBe("# T\n\n## The stairs\n\nDark [E1].");
    expect(report.checks).toMatchObject({ flagged: 1, rewritten: 0, removed: 1, sentences: 1 });
  });

  it("never trusts the model's citation: a tag with no block given is dropped and counted", async () => {
    const db = createReportsStore();
    const provider = scripted(
      ["Dark [E1][E9]. The lift stopped [E2].", "Dark [E1]. The corpus does not say."],
      {
        title: "T",
        sections: [{ heading: "The stairs", evidence: [1, 9] }],
      },
    );
    const report = await runReport({ corpus: "grenfell", topic: "The stairs", provider, db });
    expect(report.body).not.toMatch(/\[E9\]|\[E2\]/);
    expect(report.citations.map((c) => c.evidence)).toEqual([1]);
    expect(report.checks).toMatchObject({ droppedEvidence: 1, droppedCitations: 2, flagged: 1 });
  });

  it("abstains without a model call when nothing is retrieved", async () => {
    const db = createReportsStore({ chunks: [] });
    const provider = scripted([]);
    const report = await runReport({ corpus: "grenfell", topic: "The roof", provider, db });
    expect(report.body).toBe("# The roof\n\n## Findings\n\nThe corpus does not say.");
    expect(provider.outlines).toEqual([]);
    expect(report.citations).toEqual([]);
    expect(report.checks).toMatchObject({ sentences: 1, abstained: 1, supported: 0 });
  });

  it("restricts retrieval to the named documents", async () => {
    const db = createReportsStore();
    const provider = scripted(["The lift stopped [E1]."], {
      title: "T",
      sections: [{ heading: "The lift", evidence: [1] }],
    });
    const report = await runReport({
      corpus: "grenfell",
      topic: "The lift",
      documentIds: ["IWS2"],
      provider,
      db,
    });
    const ranked = db.calls.filter((c) => /^\s*SELECT id FROM chunks/.test(c.text));
    expect(ranked).toHaveLength(4);
    for (const c of ranked) {
      expect(c.text).toContain("document_id = ANY(");
      expect(c.params).toContainEqual(["IWS2"]);
    }
    expect(report.citations).toEqual([
      { evidence: 1, locator: { document: "IWS2", page: 2, paragraph: 4 } },
    ]);
  });

  it("takes the previous version, without its tags, and the change prompt as input", async () => {
    const db = createReportsStore();
    const provider = scripted(["The stairs were dark [E1] and hot [E1]."], {
      title: "T",
      sections: [{ heading: "The stairs", evidence: [1] }],
    });
    await runReport({
      corpus: "grenfell",
      topic: "The stairs",
      previous: "# T\n\n## The stairs\n\nThe stairs were dark [E4].",
      changePrompt: "Say whether they were hot.",
      provider,
      db,
    });
    const { prompt } = provider.outlines[0];
    expect(prompt).toContain("Change request: Say whether they were hot.");
    expect(prompt).toContain("## The stairs\n\nThe stairs were dark.");
    expect(prompt).not.toContain("[E4]");
    const user = provider.chats[0].messages[1].content;
    expect(user).toContain("Change request: Say whether they were hot.");
    expect(user).toContain("The previous version of this section follows");
    expect(user).toContain("The stairs were dark.");
    await expect(
      runReport({
        corpus: "grenfell",
        topic: "x",
        previous: "# T",
        changePrompt: " ",
        provider,
        db,
      }),
    ).rejects.toThrow(/change prompt/);
  });
});

describe("the reports store", () => {
  const report = (filename, extra = {}) => ({
    sessionId: SESSION,
    userId: "sub-1",
    corpus: "grenfell",
    filename,
    title: "T",
    topic: "The stairs",
    documentIds: ["IWS1"],
    body: "# T\n\n## A\n\nDark [E1].",
    citations: [{ evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } }],
    checks: { sentences: 1, supported: 1 },
    promptVersion: REPORT_PROMPT_VERSION,
    model: "m",
    ...extra,
  });

  it("numbers versions per user, corpus and filename, lists, reads and deletes every version", async () => {
    const db = createReportsStore();
    db.sessions.set(SESSION, "sub-1");
    expect((await storeReport(db, report("a.md"))).version).toBe(1);
    expect((await storeReport(db, report("a.md", { title: "T2" }))).version).toBe(2);
    expect((await storeReport(db, report("b.md"))).version).toBe(1);
    await storeReport(db, report("a.md", { userId: "sub-2" }));
    expect((await storeReport(db, report("a.md", { corpus: "ucpi" }))).version).toBe(1);
    const insert = db.calls.find((c) => /INSERT INTO reports/.test(c.text));
    expect(insert.text).toMatch(/COALESCE\(max\(version\), 0\) \+ 1/);
    expect(insert.params[6]).toEqual(["IWS1"]);

    expect(await listReports(db, { userId: "sub-1", corpus: "grenfell" })).toEqual([
      { filename: "b.md", title: "T", versions: [1], updatedAt: expect.any(String) },
      { filename: "a.md", title: "T2", versions: [1, 2], updatedAt: expect.any(String) },
    ]);
    const versions = await reportVersions(db, {
      userId: "sub-1",
      corpus: "grenfell",
      filename: "a.md",
    });
    expect(versions.map((v) => [v.version, v.title])).toEqual([
      [1, "T"],
      [2, "T2"],
    ]);
    expect(versions[0]).toMatchObject({
      sessionId: SESSION,
      bodyMarkdown: "# T\n\n## A\n\nDark [E1].",
      documentIds: ["IWS1"],
      citations: [{ evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } }],
      promptVersion: REPORT_PROMPT_VERSION,
      modelId: "m",
    });
    expect(
      (await latestReport(db, { userId: "sub-1", corpus: "grenfell", filename: "a.md" })).version,
    ).toBe(2);
    expect(
      await latestReport(db, { userId: "sub-1", corpus: "grenfell", filename: "c.md" }),
    ).toBeNull();

    expect(await deleteReport(db, { userId: "sub-1", corpus: "grenfell", filename: "a.md" })).toBe(
      2,
    );
    expect(
      await reportVersions(db, { userId: "sub-1", corpus: "grenfell", filename: "a.md" }),
    ).toEqual([]);
    expect(
      await reportVersions(db, { userId: "sub-2", corpus: "grenfell", filename: "a.md" }),
    ).toHaveLength(1);
    expect(
      await reportVersions(db, { userId: "sub-1", corpus: "ucpi", filename: "a.md" }),
    ).toHaveLength(1);
    expect(await listReports(db, { userId: "sub-1", corpus: "ucpi" })).toEqual([
      { filename: "a.md", title: "T", versions: [1], updatedAt: expect.any(String) },
    ]);
    await expect(storeReport(db, report("c.md", { corpus: undefined }))).rejects.toThrow(/corpus/);
  });

  it("refuses a filename that is not a lower-case .md name before any query", async () => {
    const db = createReportsStore();
    await expect(storeReport(db, report("../x.md"))).rejects.toThrow(/filename/);
    await expect(
      deleteReport(db, { userId: "u", corpus: "grenfell", filename: "X.md" }),
    ).rejects.toThrow(/filename/);
    expect(db.calls).toEqual([]);
  });
});

describe("requestReport", () => {
  it("stores version 1, then an edit of the same filename as version 2", async () => {
    const db = createReportsStore();
    db.sessions.set(SESSION, "sub-1");
    const runs = [];
    const run = async (args) => {
      runs.push(args);
      return {
        title: `T${runs.length}`,
        body: `# T${runs.length}\n\n## A\n\nDark [E1].`,
        citations: [{ evidence: 1, locator: { document: "IWS1", page: 3, paragraph: 11 } }],
        checks: { sentences: 1, supported: 1, marks: [] },
        promptVersion: REPORT_PROMPT_VERSION,
        model: "m",
      };
    };
    const ask = (topic, documentIds = []) =>
      requestReport({
        db,
        provider: {},
        userId: "sub-1",
        sessionId: SESSION,
        request: { topic, documentIds, filename: "stairs.md", corpus: "grenfell" },
        run,
      });
    const first = await ask("The stairs", ["IWS1", "IWS2"]);
    expect(first).toMatchObject({ filename: "stairs.md", version: 1, title: "T1" });
    expect(runs[0]).toMatchObject({
      topic: "The stairs",
      changePrompt: null,
      previous: null,
      documentIds: ["IWS1", "IWS2"],
      corpus: "grenfell",
    });
    const second = await ask("Add the lift.");
    expect(second).toMatchObject({ version: 2, title: "T2" });
    expect(runs[1]).toMatchObject({
      topic: "The stairs",
      changePrompt: "Add the lift.",
      previous: "# T1\n\n## A\n\nDark [E1].",
      documentIds: ["IWS1", "IWS2"],
    });
    expect(db.reports.map((r) => [r.version, r.topic, r.change_prompt])).toEqual([
      [1, "The stairs", null],
      [2, "The stairs", "Add the lift."],
    ]);
    expect(reportScores(second.checks)).toEqual({ sentences: 1, supported: 1 });
  });

  it("runs the whole cycle and stores what it wrote", async () => {
    const db = createReportsStore();
    db.sessions.set(SESSION, "sub-1");
    const provider = scripted(["Dark [E1].", "The lift stopped [E2]."]);
    const stored = await requestReport({
      db,
      provider,
      userId: "sub-1",
      sessionId: SESSION,
      request: { topic: "The stairs", documentIds: [], filename: "stairs.md", corpus: "grenfell" },
    });
    expect(stored).toMatchObject({ version: 1, title: "Smoke on the stairs" });
    expect(db.reports[0]).toMatchObject({
      body_markdown:
        "# Smoke on the stairs\n\n## The stairs\n\nDark [E1].\n\n## The lift\n\nThe lift stopped [E2].",
      prompt_version: REPORT_PROMPT_VERSION,
      model_id: "fake-chat",
      document_ids: [],
      corpus: "grenfell",
    });
    expect(db.reports[0].citations.map((c) => c.evidence)).toEqual([1, 2]);
  });
});

describe("the corpus of a report", () => {
  it("retrieves from the request's corpus only", async () => {
    const db = createReportsStore({
      chunks: [
        ...CHUNK_ROWS,
        { ...CHUNK_ROWS[0], id: "9", document_id: "UCPI1", corpus: "ucpi", text: "HN1 met him." },
      ],
      documents: {
        ...DOCUMENT_ROWS,
        UCPI1: { id: "UCPI1", title: "Witness statement of HN1", witness_id: "HN1", format: "pdf" },
      },
    });
    const provider = scripted(["Dark [E1]."], {
      title: "T",
      sections: [{ heading: "A", evidence: [1] }],
    });
    const report = await runReport({ corpus: "ucpi", topic: "The meeting", provider, db });
    expect(report.evidenceBlocks.map((b) => b.documentId)).toEqual(["UCPI1"]);
    await expect(runReport({ topic: "The meeting", provider, db })).rejects.toThrow(/corpus/);
  });

  it("answers 400 to a reports request without a corpus", async () => {
    const db = createReportsStore();
    for (const corpus of [undefined, "../x"]) {
      expect(await reportsResponse(db, { method: "GET", userId: "u", corpus })).toMatchObject({
        status: 400,
      });
    }
    expect(db.calls).toEqual([]);
    expect(await reportsResponse(db, { method: "GET", userId: "u", corpus: "ucpi" })).toEqual({
      status: 200,
      body: { reports: [] },
    });
  });
});
