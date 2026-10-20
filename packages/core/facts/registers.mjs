// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The witness and entity registers in memory, and the alias resolver over them. A witness is
// known by its id and aliases only; there is no name column. A cipher-only witness resolves to
// its cipher and nothing else: no entity alias can attach another name to it.

/** Whitespace collapsed and trimmed, in NFC, so a span and a stored name compare as text. */
export function normaliseSpan(text) {
  return String(text).normalize("NFC").replace(/\s+/g, " ").trim();
}

const key = (text) => normaliseSpan(text).toLowerCase();

/**
 * @typedef {{ type: 'witness', id: string, cipherOnly: boolean }} WitnessMatch
 * @typedef {{ type: 'entity', id: string, kind: string, canonical: string }} EntityMatch
 */

/**
 * Builds the resolver from register rows.
 * @param {{ witnesses: { id: string, cipher_only: boolean, aliases?: string[] | null }[],
 *   entities: { id: string, kind: string, canonical: string, aliases?: string[] | null }[] }} rows
 */
export function createRegisters({ witnesses = [], entities = [] }) {
  const witnessByName = new Map();
  const cipherNames = new Set();
  for (const w of witnesses) {
    const match = { type: "witness", id: w.id, cipherOnly: Boolean(w.cipher_only) };
    for (const name of [w.id, ...(w.aliases ?? [])]) {
      const k = key(name);
      if (!k) continue;
      const other = witnessByName.get(k);
      if (other && other.id !== w.id) {
        throw new Error(`the name ${name} belongs to witnesses ${other.id} and ${w.id}`);
      }
      witnessByName.set(k, match);
      if (match.cipherOnly) cipherNames.add(k);
    }
  }

  const entityByName = new Map();
  const ignoredAliases = [];
  const addEntity = (e) => {
    const match = { type: "entity", id: String(e.id), kind: e.kind, canonical: e.canonical };
    const names = [e.canonical, ...(e.aliases ?? [])].map(key).filter(Boolean);
    // An entity that names a cipher is that cipher; its other names would tie a real
    // identity to it, so they are left out of the index.
    const touchesCipher = names.some((k) => cipherNames.has(k));
    for (const k of names) {
      if (touchesCipher && !cipherNames.has(k)) {
        ignoredAliases.push({ entityId: match.id, alias: k });
        continue;
      }
      if (!entityByName.has(k)) entityByName.set(k, match);
    }
    return match;
  };
  for (const e of entities) addEntity(e);

  return {
    /** Entity names left out of the index because the entity names a cipher. */
    ignoredAliases,

    /**
     * The witness or entity a span names, compared without case, or null. A witness wins
     * over an entity of the same name.
     * @param {string} span
     * @returns {WitnessMatch | EntityMatch | null}
     */
    resolve(span) {
      const k = key(span ?? "");
      if (!k) return null;
      return witnessByName.get(k) ?? entityByName.get(k) ?? null;
    },

    /** Adds an entity row written after the registers loaded. */
    addEntity,
  };
}

/**
 * Loads both registers from the store.
 * @param {{ query: Function }} db
 */
export async function loadRegisters(db) {
  const [witnesses, entities] = await Promise.all([
    db.query("SELECT id, cipher_only, aliases FROM witnesses"),
    db.query("SELECT id, kind, canonical, aliases FROM entities"),
  ]);
  return createRegisters({ witnesses: witnesses.rows, entities: entities.rows });
}

/** The two document ids in the order identity_revealing_pairs stores them. */
export function pairKey(a, b) {
  if (!a || !b || a === b) throw new Error("a pair needs two different document ids");
  return a < b ? [a, b] : [b, a];
}

/**
 * True when the two documents are marked as revealing an identity together.
 * @param {{ query: Function }} db
 */
export async function isIdentityRevealingPair(db, a, b) {
  const { rows } = await db.query(
    "SELECT 1 FROM identity_revealing_pairs WHERE document_a = $1 AND document_b = $2",
    pairKey(a, b),
  );
  return rows.length > 0;
}
