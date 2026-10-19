// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Turns fused hits into numbered evidence blocks: each passage hit takes its
// previous and next passage, hits that share a section become that section, and
// the context stops at a character budget.

export const MAX_HITS = 12;
export const MAX_BLOCKS = 12;
export const CHARS_PER_TOKEN = 4;
export const MAX_CONTEXT_TOKENS = 6000;
export const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

const MIN_OVERLAP = 20;

/**
 * Joins two passages from a sliding window. When the end of `a` repeats the
 * start of `b`, the repeated text appears once.
 * @param {string} a
 * @param {string} b
 */
export function joinOverlapping(a, b) {
  for (let k = Math.min(a.length, b.length); k >= MIN_OVERLAP; k--) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  }
  return `${a} ${b}`;
}

/** The size of a block in characters as the prompt sends it. */
export const blockChars = (block) => (block.header ?? "").length + 1 + block.text.length;

/**
 * The ids of the neighbours and parent sections that the hits need.
 * @param {object[]} hits chunk rows
 * @param {Map<string, object>} loaded rows already loaded
 */
export function neighbourIds(hits, loaded) {
  const want = new Set();
  for (const hit of hits) {
    if (hit.level !== "passage") continue;
    for (const id of [hit.prev_id, hit.next_id, hit.parent_id]) {
      if (id != null && !loaded.has(id)) want.add(id);
    }
  }
  return [...want];
}

/**
 * Builds the evidence blocks in fusion order.
 * @param {string[]} hitIds fused ids, best first
 * @param {Map<string, object>} rows every hit, neighbour and parent row by id
 * @param {{ maxHits?: number, maxBlocks?: number, maxChars?: number }} [limits]
 * @returns {{ evidence: number, chunkId: string, chunkIds: string[], level: string,
 *   documentId: string, locator: object, header: string | null, text: string }[]}
 */
export function buildEvidence(
  hitIds,
  rows,
  { maxHits = MAX_HITS, maxBlocks = MAX_BLOCKS, maxChars = MAX_CONTEXT_CHARS } = {},
) {
  const row = (id) => {
    const r = rows.get(id);
    if (!r) throw new Error(`chunk ${id} was not loaded`);
    return r;
  };
  const hits = hitIds.slice(0, maxHits).map(row);
  const sectionHits = new Set(hits.filter((h) => h.level === "section").map((h) => h.id));
  const passagesPerSection = new Map();
  for (const h of hits) {
    if (h.level === "passage" && h.parent_id != null) {
      passagesPerSection.set(h.parent_id, (passagesPerSection.get(h.parent_id) ?? 0) + 1);
    }
  }

  const covered = new Set();
  const coveredSections = new Set();
  const blocks = [];
  let used = 0;

  const isCovered = (r) =>
    covered.has(r.id) || (r.parent_id != null && coveredSections.has(r.parent_id));

  const add = (candidate, chunkIds, section) => {
    const size = blockChars(candidate);
    if (used + size > maxChars) return;
    used += size;
    for (const id of chunkIds) covered.add(id);
    if (section) coveredSections.add(section);
    blocks.push({ evidence: blocks.length + 1, ...candidate, chunkIds });
  };

  for (const hit of hits) {
    if (blocks.length >= maxBlocks) break;
    if (isCovered(hit)) continue;
    if (hit.level === "section") {
      add(fromRow(hit, hit.text), [hit.id], hit.id);
      continue;
    }
    const parent = hit.parent_id;
    if (parent != null && (sectionHits.has(parent) || passagesPerSection.get(parent) > 1)) {
      const section = row(parent);
      add(fromRow(section, section.text), [section.id], section.id);
      continue;
    }
    const parts = [hit.prev_id, hit.id, hit.next_id]
      .filter((id) => id != null)
      .map(row)
      .filter((r) => r.id === hit.id || (r.document_id === hit.document_id && !isCovered(r)));
    const text = parts.map((r) => r.text).reduce(joinOverlapping);
    add(
      fromRow(hit, text),
      parts.map((r) => r.id),
      null,
    );
  }
  return blocks;
}

function fromRow(r, text) {
  if (r.locator == null || typeof r.locator !== "object" || Array.isArray(r.locator)) {
    throw new Error(`chunk ${r.id} has no locator object`);
  }
  return {
    chunkId: r.id,
    level: r.level,
    documentId: r.document_id,
    locator: r.locator,
    header: r.header,
    text,
  };
}

const isoDate = (value) => {
  if (value == null) return null;
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
};

/**
 * The document and witness facts the page shows for each cited document. A cipher-only witness
 * carries its cipher only; the title and role stay out of the frame.
 * @param {{ query: Function }} db
 * @param {string[]} documentIds
 * @returns {Promise<Map<string, { title: string | null, witnessId: string | null, cipherOnly: boolean,
 *   role: string | null, statementDate: string | null, type: string, pages: number | null }>>}
 */
export async function loadDocuments(db, documentIds) {
  const out = new Map();
  const ids = [...new Set(documentIds)];
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT d.id, d.title, d.witness_id, d.role, d.statement_date, d.format, d.page_count,
            w.cipher_only, w.role AS witness_role
       FROM documents d LEFT JOIN witnesses w ON w.id = d.witness_id
      WHERE d.id = ANY($1::text[])`,
    [ids],
  );
  for (const row of rows) {
    const cipherOnly = row.cipher_only === true;
    out.set(String(row.id), {
      title: cipherOnly ? null : (row.title ?? null),
      witnessId: row.witness_id ?? null,
      cipherOnly,
      role: cipherOnly ? null : (row.role ?? row.witness_role ?? null),
      statementDate: isoDate(row.statement_date),
      type: row.format,
      pages: row.page_count ?? null,
    });
  }
  return out;
}

/**
 * Adds `document` to every block.
 * @param {{ documentId: string }[]} blocks
 * @param {Map<string, object>} documents from loadDocuments
 */
export function withDocuments(blocks, documents) {
  return blocks.map((block) => {
    const document = documents.get(block.documentId);
    if (!document) throw new Error(`document ${block.documentId} was not loaded`);
    return { ...block, document };
  });
}
