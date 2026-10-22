// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Generated reports: a longer answer over a topic, built in one request through a draft, write
// and review cycle, and stored with versions. The model writes [En] tags over the evidence
// blocks it was given; the server resolves them with checkAnswer, as it does for a turn.
import { TAG, tagNumbers } from "./checks/citations.mjs";
import { CorpusError, requireCorpusId } from "./corpora.mjs";
import { ABSTAIN_PHRASE } from "./prompt.mjs";
import { isReportFilename } from "./protocol.mjs";
import { NO_EVIDENCE_ANSWER, checkAnswer } from "./query.mjs";
import {
  CHARS_PER_TOKEN,
  buildEvidence,
  loadDocuments,
  neighbourIds,
  withDocuments,
} from "./retrieval/expand.mjs";
import { loadChunks, retrieve } from "./retrieval/hybrid.mjs";

export const REPORT_PROMPT_VERSION = "report-closed-world-v1";

/** A report draws on more of the corpus than a turn: the turn's caps are 40, 12 and 6000. */
export const REPORT_LIMITS = Object.freeze({
  maxHits: 100,
  maxBlocks: 30,
  maxChars: 16000 * CHARS_PER_TOKEN,
});

export const MAX_SECTIONS = 8;
export const MAX_TITLE = 200;
export const MAX_REPORTS = 100;

export const REPORT_SYSTEM_PROMPT = [
  "You write one section of a report about a corpus of witness statements.",
  "Write only from the evidence blocks you are given.",
  "Never use prior knowledge about the real event.",
  "Write [En] after every sentence, where n is the number of the evidence block it relies on.",
  "Put one number in each bracket and write [E3][E4], never [E3, E4].",
  "If the evidence blocks do not cover the section, write only 'The corpus does not say.'",
  "If they cover part of it, write 'the corpus does not say' for the part they do not cover.",
  "Report what each witness says and attribute it to the witness; never say what a witness really meant.",
  "Write short paragraphs of plain sentences; use no headings, bullets or tables.",
].join(" ");

export const OUTLINE_INSTRUCTIONS = [
  "Plan a report about a corpus of witness statements from the evidence blocks below.",
  "Use only the evidence blocks; never use prior knowledge about the real event.",
  `Return a title and between one and ${MAX_SECTIONS} sections.`,
  "Each section has a heading and the numbers of the evidence blocks it will draw on.",
  "Give a section only block numbers that appear below.",
  "A part of the topic that no block covers gets a section with no block numbers.",
].join(" ");

export const OUTLINE_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["heading", "evidence"],
        properties: {
          heading: { type: "string" },
          evidence: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
});

/** Removes every [En] tag; the previous version's numbers name blocks of an older retrieval. */
export const stripTags = (text) =>
  text
    .replace(TAG, "")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");

/**
 * Rewrites every tag as one bracket per number and drops the numbers that name no block the
 * section was given.
 * @param {string} text
 * @param {Set<number>} allowed
 * @returns {{ text: string, dropped: number }}
 */
export function keepKnownTags(text, allowed) {
  let dropped = 0;
  const out = text.replace(TAG, (...match) => {
    const numbers = tagNumbers(match);
    const known = numbers.filter((n) => allowed.has(n));
    dropped += numbers.length - known.length;
    return known.map((n) => `[E${n}]`).join("");
  });
  return { text: out.replace(/[ \t]+([.,;:])/g, "$1"), dropped };
}

/** The evidence blocks as the report prompts send them, each under its report-wide number. */
export const reportEvidence = (blocks) =>
  blocks.length
    ? blocks.map((b) => `[E${b.evidence}] ${b.header ?? ""}\n${b.text}`).join("\n\n")
    : "Evidence blocks: none.";

/**
 * Splits a stored report body into its title and sections.
 * @param {string} markdown
 * @returns {{ title: string | null, sections: { heading: string, text: string }[] }}
 */
export function parseReport(markdown) {
  let title = null;
  const sections = [];
  for (const line of markdown.split("\n")) {
    if (title === null && sections.length === 0 && line.startsWith("# ")) {
      title = line.slice(2).trim();
    } else if (line.startsWith("## ")) {
      sections.push({ heading: line.slice(3).trim(), lines: [] });
    } else if (sections.length) {
      sections.at(-1).lines.push(line);
    }
  }
  return {
    title,
    sections: sections.map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() })),
  };
}

/** The prompt of the draft stage, for extractJson. */
export function outlinePrompt({ topic, blocks, previous, changePrompt }) {
  const parts = [OUTLINE_INSTRUCTIONS, "", reportEvidence(blocks), "", `Report topic: ${topic}`];
  if (previous) {
    parts.push(
      "",
      `Change request: ${changePrompt}`,
      "The previous version of the report follows. It is not evidence; keep its structure where the change request does not alter it.",
      stripTags(previous),
    );
  }
  return parts.join("\n");
}

/** The chat messages of the write stage for one section. */
export function sectionMessages({ topic, heading, blocks, previousSection, changePrompt }) {
  const parts = [
    reportEvidence(blocks),
    "",
    `Report topic: ${topic}`,
    `Section heading: ${heading}`,
  ];
  if (changePrompt) parts.push(`Change request: ${changePrompt}`);
  if (previousSection) {
    parts.push(
      "The previous version of this section follows. It is not evidence; apply the change request to it.",
      stripTags(previousSection),
    );
  }
  return [
    { role: "system", content: REPORT_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];
}

/** The follow-up message of the review stage: the flagged sentences, for one rewrite. */
export function rewriteMessage(flagged) {
  return [
    "These sentences have no [En] tag for a block you were given:",
    ...flagged.map((text, i) => `${i + 1}. ${text}`),
    "Rewrite the whole section. Give every sentence an [En] tag from the evidence blocks above, or write 'the corpus does not say' in its place. Return only the section text.",
  ].join("\n");
}

const isAbstainSentence = (mark) =>
  mark.tags.length === 0 && mark.text.toLowerCase().includes(ABSTAIN_PHRASE);

const cleanSectionText = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Checks a section paragraph by paragraph against its blocks.
 * @returns {{ paragraphs: { text: string, supported: boolean, abstains: boolean, tags: number[] }[][],
 *   citations: object[], dropped: number }}
 */
function checkSection(raw, blocks) {
  const allowed = new Set(blocks.map((b) => b.evidence));
  const { text, dropped } = keepKnownTags(cleanSectionText(raw), allowed);
  const citations = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const scored = checkAnswer(p, blocks);
      citations.push(...scored.citations);
      return scored.checks.marks.map((m) => ({ ...m, abstains: isAbstainSentence(m) }));
    });
  return { paragraphs, citations, dropped };
}

const flaggedOf = (paragraphs) => paragraphs.flat().filter((m) => !m.supported && !m.abstains);

const sumUsage = (a, b) => {
  if (!b) return a;
  const sum = {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
  };
  for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
    if (a && field in a) sum[field] = a[field];
    if (field in b) sum[field] = (sum[field] ?? 0) + b[field];
  }
  return sum;
};

/**
 * Runs the cycle and returns the report to store.
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.corpus the corpus the evidence comes from
 * @param {string[]} [args.documentIds] empty means the whole corpus
 * @param {string} [args.filename]
 * @param {string | null} [args.previous] the latest version's body
 * @param {string | null} [args.changePrompt]
 * @param {import('./providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {{ query: Function }} args.db
 * @param {AbortSignal} [args.signal]
 * @param {(stage: 'drafting' | 'writing' | 'reviewing') => void} [args.onStage]
 * @param {{ maxHits?: number, maxBlocks?: number, maxChars?: number }} [args.limits]
 */
export async function runReport({
  topic,
  corpus,
  documentIds = [],
  filename = null,
  previous = null,
  changePrompt = null,
  provider,
  db,
  signal,
  onStage,
  limits = REPORT_LIMITS,
}) {
  if (!db) throw new Error("runReport needs a database");
  if (!corpus) throw new Error("runReport needs a corpus");
  if (typeof topic !== "string" || !topic.trim()) throw new Error("runReport needs a topic");
  if (previous && !changePrompt?.trim()) throw new Error("an edit needs a change prompt");
  const timings = {};
  let stageStart = performance.now();
  const endStage = (name) => {
    const now = performance.now();
    timings[name] = now - stageStart;
    stageStart = now;
  };

  onStage?.("drafting");
  const question = previous ? `${topic}\n${changePrompt}` : topic;
  const { fused } = await retrieve({
    queries: [question],
    corpus,
    provider,
    db,
    signal,
    documentIds,
  });
  const hitIds = fused.slice(0, limits.maxHits).map((f) => f.id);
  const rows = await loadChunks(db, hitIds);
  for (const [id, r] of await loadChunks(db, neighbourIds([...rows.values()], rows))) {
    rows.set(id, r);
  }
  signal?.throwIfAborted();
  const built = buildEvidence(hitIds, rows, limits);
  const blocks = withDocuments(
    built,
    await loadDocuments(
      db,
      built.map((b) => b.documentId),
    ),
  );

  let title;
  let outlineSections;
  let droppedEvidence = 0;
  let sectionsDropped = 0;
  if (!blocks.length) {
    title = previous ? (parseReport(previous).title ?? topic) : topic;
    outlineSections = [{ heading: "Findings", blocks: [] }];
  } else {
    const outline = await provider.extractJson({
      prompt: outlinePrompt({ topic, blocks, previous, changePrompt }),
      schema: OUTLINE_SCHEMA,
      signal,
    });
    signal?.throwIfAborted();
    ({ title, outlineSections, droppedEvidence, sectionsDropped } = readOutline(outline, blocks));
  }
  title = title.slice(0, MAX_TITLE);
  endStage("drafting");

  onStage?.("writing");
  const previousSections = previous ? parseReport(previous).sections : [];
  const previousFor = (heading) =>
    previousSections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())?.text ?? null;
  let model = null;
  let usage = null;
  const record = (result) => {
    model = result.model ?? model;
    usage = sumUsage(usage, result.usage);
  };
  const drafts = [];
  for (const section of outlineSections) {
    if (!section.blocks.length) {
      drafts.push({ section, text: NO_EVIDENCE_ANSWER, messages: null });
      continue;
    }
    const messages = sectionMessages({
      topic,
      heading: section.heading,
      blocks: section.blocks,
      previousSection: previousFor(section.heading),
      changePrompt: previous ? changePrompt : null,
    });
    const result = await provider.chat({
      messages,
      signal,
      temperature: 0,
      promptVersion: REPORT_PROMPT_VERSION,
    });
    signal?.throwIfAborted();
    record(result);
    drafts.push({ section, text: result.text, messages });
  }
  endStage("writing");

  onStage?.("reviewing");
  const sections = [];
  for (const draft of drafts) {
    const { section } = draft;
    let checked = checkSection(draft.text, section.blocks);
    let dropped = checked.dropped;
    const flagged = flaggedOf(checked.paragraphs);
    if (flagged.length && draft.messages) {
      const result = await provider.chat({
        messages: [
          ...draft.messages,
          { role: "assistant", content: draft.text },
          { role: "user", content: rewriteMessage(flagged.map((m) => m.text)) },
        ],
        signal,
        temperature: 0,
        promptVersion: REPORT_PROMPT_VERSION,
      });
      signal?.throwIfAborted();
      record(result);
      checked = checkSection(result.text, section.blocks);
      dropped += checked.dropped;
    }
    const removed = flaggedOf(checked.paragraphs).length;
    const kept = checked.paragraphs
      .map((p) => p.filter((m) => m.supported || m.abstains))
      .filter((p) => p.length);
    if (!kept.length)
      kept.push([{ text: NO_EVIDENCE_ANSWER, supported: false, abstains: true, tags: [] }]);
    sections.push({
      heading: section.heading,
      evidence: section.blocks.map((b) => b.evidence),
      paragraphs: kept,
      citations: checked.citations,
      flagged: flagged.length,
      removed,
      dropped,
    });
  }

  const body = [
    `# ${title}`,
    ...sections.flatMap((s) => [
      `## ${s.heading}`,
      ...s.paragraphs.map((p) => p.map((m) => m.text).join(" ")),
    ]),
  ].join("\n\n");

  const citations = [];
  const cited = new Set();
  for (const s of sections) {
    for (const c of s.citations) {
      if (cited.has(c.evidence)) continue;
      if (!s.paragraphs.flat().some((m) => m.tags.includes(c.evidence))) continue;
      cited.add(c.evidence);
      citations.push(c);
    }
  }
  citations.sort((a, b) => a.evidence - b.evidence);

  const marks = sections.flatMap((s) =>
    s.paragraphs.flat().map((m) => ({
      section: s.heading,
      text: m.text,
      supported: m.supported,
      abstains: m.abstains,
      tags: m.tags,
    })),
  );
  const supported = marks.filter((m) => m.supported).length;
  const abstained = marks.filter((m) => m.abstains).length;
  const flagged = sections.reduce((n, s) => n + s.flagged, 0);
  endStage("reviewing");
  return {
    filename,
    title,
    body,
    citations,
    evidenceBlocks: blocks,
    model,
    promptVersion: REPORT_PROMPT_VERSION,
    checks: {
      sentences: marks.length,
      supported,
      abstained,
      flaggedRatio: marks.length ? (marks.length - supported - abstained) / marks.length : 0,
      flagged,
      rewritten: sections.reduce((n, s) => n + Math.max(0, s.flagged - s.removed), 0),
      removed: sections.reduce((n, s) => n + s.removed, 0),
      droppedCitations: sections.reduce((n, s) => n + s.dropped, 0),
      droppedEvidence,
      sectionsDropped,
      evidenceBlocks: blocks.length,
      sections: sections.map((s) => ({
        heading: s.heading,
        evidence: s.evidence,
        sentences: s.paragraphs.flat().length,
        flagged: s.flagged,
        removed: s.removed,
      })),
      marks,
      model,
      promptVersion: REPORT_PROMPT_VERSION,
      usage,
      timings,
    },
  };
}

/**
 * Reads the outline the model returned. Block numbers that name no retrieved block are dropped
 * and counted; a heading must be one line of text.
 */
export function readOutline(outline, blocks) {
  if (!outline || typeof outline !== "object") throw new Error("the outline is not an object");
  const title = typeof outline.title === "string" ? oneLine(outline.title) : "";
  if (!title) throw new Error("the outline has no title");
  if (!Array.isArray(outline.sections) || outline.sections.length === 0) {
    throw new Error("the outline has no sections");
  }
  const byNumber = new Map(blocks.map((b) => [b.evidence, b]));
  let droppedEvidence = 0;
  const outlineSections = outline.sections.slice(0, MAX_SECTIONS).map((s, i) => {
    const heading = typeof s?.heading === "string" ? oneLine(s.heading) : "";
    if (!heading) throw new Error(`outline section ${i + 1} has no heading`);
    const numbers = Array.isArray(s.evidence) ? s.evidence : [];
    const chosen = [];
    for (const n of numbers) {
      if (byNumber.has(n) && !chosen.includes(byNumber.get(n))) chosen.push(byNumber.get(n));
      else if (!byNumber.has(n)) droppedEvidence += 1;
    }
    return { heading, blocks: chosen };
  });
  return {
    title,
    outlineSections,
    droppedEvidence,
    sectionsDropped: Math.max(0, outline.sections.length - MAX_SECTIONS),
  };
}

const oneLine = (text) =>
  text
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const REPORT_COLUMNS = `id, session_id::text AS session_id, filename, version, title, topic, change_prompt,
            document_ids, body_markdown, citations, checks, prompt_version, model_id,
            to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at`;

const fromRow = (r) => ({
  id: String(r.id),
  sessionId: r.session_id,
  filename: r.filename,
  version: Number(r.version),
  title: r.title,
  topic: r.topic,
  changePrompt: r.change_prompt ?? null,
  documentIds: r.document_ids ?? [],
  bodyMarkdown: r.body_markdown,
  citations: r.citations,
  checks: r.checks,
  promptVersion: r.prompt_version,
  modelId: r.model_id ?? null,
  createdAt: r.created_at,
});

const requireFilename = (filename) => {
  if (!isReportFilename(filename)) {
    throw new Error(`report filename ${JSON.stringify(filename)} is not a lower-case .md name`);
  }
};

/**
 * A user's reports in one corpus, newest first: each filename with its versions and the latest
 * title.
 * @param {{ query: Function }} db
 * @param {{ userId: string, corpus: string }} which
 */
export async function listReports(db, { userId, corpus }) {
  const { rows } = await db.query(
    `SELECT filename,
            array_agg(version ORDER BY version)::int[] AS versions,
            (array_agg(title ORDER BY version DESC))[1] AS title,
            to_char(max(created_at) AT TIME ZONE 'UTC', ${ISO}) AS updated_at
       FROM reports
      WHERE user_id = $1 AND corpus = $2
      GROUP BY filename
      ORDER BY max(created_at) DESC, filename
      LIMIT ${MAX_REPORTS}`,
    [userId, corpus],
  );
  return rows.map((r) => ({
    filename: r.filename,
    title: r.title,
    versions: (r.versions ?? []).map(Number),
    updatedAt: r.updated_at,
  }));
}

/**
 * Every version of one of a user's reports in a corpus, oldest first.
 * @param {{ query: Function }} db
 * @param {{ userId: string, corpus: string, filename: string }} which
 */
export async function reportVersions(db, { userId, corpus, filename }) {
  requireFilename(filename);
  const { rows } = await db.query(
    `SELECT ${REPORT_COLUMNS} FROM reports WHERE user_id = $1 AND corpus = $2 AND filename = $3
      ORDER BY version`,
    [userId, corpus, filename],
  );
  return rows.map(fromRow);
}

/**
 * The latest version of one of a user's reports in a corpus, or null.
 * @param {{ query: Function }} db
 * @param {{ userId: string, corpus: string, filename: string }} which
 */
export async function latestReport(db, { userId, corpus, filename }) {
  requireFilename(filename);
  const { rows } = await db.query(
    `SELECT ${REPORT_COLUMNS} FROM reports WHERE user_id = $1 AND corpus = $2 AND filename = $3
      ORDER BY version DESC LIMIT 1`,
    [userId, corpus, filename],
  );
  return rows.length ? fromRow(rows[0]) : null;
}

/**
 * Stores a report as the next version of its filename for the user in its corpus. The version is
 * computed in the insert, and the unique key refuses a concurrent write of the same version.
 * @param {{ query: Function }} db
 * @param {{ sessionId: string, userId: string, corpus: string, filename: string, title: string, topic: string,
 *   changePrompt?: string | null, documentIds: string[], body: string, citations: object[],
 *   checks: object, promptVersion: string, model: string | null }} report
 * @returns {Promise<{ id: string, version: number, createdAt: string }>}
 */
export async function storeReport(db, report) {
  requireFilename(report.filename);
  if (!report.userId) throw new Error(`report ${report.filename} has no user id`);
  if (!report.corpus) throw new Error(`report ${report.filename} has no corpus`);
  const { rows } = await db.query(
    `INSERT INTO reports
       (session_id, user_id, filename, version, title, topic, change_prompt, document_ids,
        body_markdown, citations, checks, prompt_version, model_id, corpus)
     SELECT $1::uuid, $2, $3, COALESCE(max(version), 0) + 1, $4, $5, $6, $7::text[], $8,
            $9::jsonb, $10::jsonb, $11, $12, $13
       FROM reports WHERE user_id = $2 AND corpus = $13 AND filename = $3
     RETURNING id, version, to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at`,
    [
      report.sessionId,
      report.userId,
      report.filename,
      report.title,
      report.topic,
      report.changePrompt ?? null,
      report.documentIds,
      report.body,
      JSON.stringify(report.citations),
      JSON.stringify(report.checks),
      report.promptVersion,
      report.model ?? null,
      report.corpus,
    ],
  );
  return {
    id: String(rows[0].id),
    version: Number(rows[0].version),
    createdAt: rows[0].created_at,
  };
}

/**
 * Deletes every version of one of a user's reports in a corpus. Resolves to the number of
 * versions removed.
 * @param {{ query: Function }} db
 * @param {{ userId: string, corpus: string, filename: string }} which
 */
export async function deleteReport(db, { userId, corpus, filename }) {
  requireFilename(filename);
  const { rows } = await db.query(
    "DELETE FROM reports WHERE user_id = $1 AND corpus = $2 AND filename = $3 RETURNING version",
    [userId, corpus, filename],
  );
  return rows.length;
}

/**
 * The answer to one reports request: the HTTP routes on AWS and on the laptop answer with it.
 * The corpus is the request's `?corpus=`.
 * @param {{ query: Function }} db
 * @param {{ method: string, filename?: string, userId: string, corpus: unknown }} request
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function reportsResponse(db, { method, filename, userId, corpus: raw }) {
  let corpus;
  try {
    corpus = requireCorpusId(raw);
  } catch (err) {
    if (err instanceof CorpusError) return { status: 400, body: { message: err.message } };
    throw err;
  }
  if (filename === undefined) {
    if (method !== "GET") return { status: 405, body: { message: "Use GET for the list." } };
    return { status: 200, body: { reports: await listReports(db, { userId, corpus }) } };
  }
  if (!isReportFilename(filename)) {
    return { status: 400, body: { message: "The filename is not a lower-case .md name." } };
  }
  if (method === "DELETE") {
    const deleted = await deleteReport(db, { userId, corpus, filename });
    if (!deleted) return { status: 404, body: { message: "No such report." } };
    return { status: 200, body: { filename, deleted } };
  }
  if (method !== "GET") return { status: 405, body: { message: "Use GET or DELETE." } };
  const versions = await reportVersions(db, { userId, corpus, filename });
  if (!versions.length) return { status: 404, body: { message: "No such report." } };
  return { status: 200, body: { filename, versions } };
}

/**
 * One report request from start to store: a filename the user already has in the request's
 * corpus becomes an edit, with the request's topic as the change prompt and the latest version as
 * input.
 * @param {object} args
 * @param {{ query: Function }} args.db
 * @param {import('./providers/modelProvider.mjs').ModelProvider} args.provider
 * @param {string} args.userId
 * @param {string} args.sessionId
 * @param {{ topic: string, documentIds: string[], filename: string, corpus: string }} args.request
 * @param {AbortSignal} [args.signal]
 * @param {(stage: string) => void} [args.onStage]
 * @param {typeof runReport} [args.run]
 */
export async function requestReport({
  db,
  provider,
  userId,
  sessionId,
  request,
  signal,
  onStage,
  run = runReport,
}) {
  const { topic, filename, corpus } = request;
  const latest = await latestReport(db, { userId, corpus, filename });
  const documentIds = request.documentIds.length
    ? request.documentIds
    : (latest?.documentIds ?? []);
  const report = await run({
    topic: latest ? latest.topic : topic,
    changePrompt: latest ? topic : null,
    previous: latest ? latest.bodyMarkdown : null,
    corpus,
    documentIds,
    filename,
    provider,
    db,
    signal,
    onStage,
  });
  signal?.throwIfAborted();
  const stored = await storeReport(db, {
    sessionId,
    userId,
    corpus,
    filename,
    title: report.title,
    topic: latest ? latest.topic : topic,
    changePrompt: latest ? topic : null,
    documentIds,
    body: report.body,
    citations: report.citations,
    checks: report.checks,
    promptVersion: report.promptVersion,
    model: report.model,
  });
  return {
    ...stored,
    filename,
    title: report.title,
    citations: report.citations,
    checks: report.checks,
  };
}

/** The check scores without the per-sentence marks, for a frame. */
export function reportScores(checks) {
  const scores = { ...checks };
  delete scores.marks;
  return scores;
}
