// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Alignment: the candidate pairs of assertions that may be about the same matter. A pair needs a
// claim similar enough by embedding and an anchor it shares. The same witness across two documents
// is a self pair, ordered by statement date; its anchors are the event, the subject, the object or
// place entity and the normalised predicate, and above a stronger similarity it needs none. Two
// witnesses make a cross pair, which always needs an anchor, and only the event, a person, group or
// thing as the shared subject, or a shared object entity of kind place, vehicle or unit anchor it:
// two witnesses who each went to bed are two events, so a shared predicate is no anchor. Two
// first-person claims of two witnesses pair only when both are observations of a shared event. A
// person or group named only by a pronoun or by a possessive kin term ("my daughter") with no
// register entry is somebody different in each statement, so it makes no cross pair at all. A
// claim about someone's age, health, home, family or job is about that one person: it pairs across
// witnesses only when both subjects resolve to one register entry, never by an event, an object or
// words. A witness assertion against an accepted fact makes an accepted pair. Every bound is a
// constant here.
import { normaliseSpan } from "./registers.mjs";

/** Cosine at or above which an anchored pair is a candidate. */
export const ALIGN_SIMILARITY = 0.6;
/** Cosine at or above which a self pair with no shared anchor is a candidate. */
export const ALIGN_SIMILARITY_ALONE = 0.85;
/** Assertions below this confidence are stored but not compared; a null confidence is compared. */
export const MIN_CONFIDENCE = 0.5;
/** The most pairs one assertion takes part in, over self and cross. */
export const MAX_PARTNERS = 8;
/** The most pairs in one group (an event, or a predicate where no event is named). */
export const MAX_PAIRS_PER_GROUP = 120;
/** The most witness assertions compared against one accepted fact. */
export const MAX_PAIRS_PER_FACT = 40;

/** The object entity kinds that anchor a cross pair. */
export const CROSS_OBJECT_KINDS = Object.freeze(["place", "vehicle", "unit"]);

/** What a claim states: the witness's own attribute, act or observation, or a report. */
export const CLAIM_KINDS = Object.freeze(["attribute", "action", "observation", "report"]);

/**
 * Subjects that name nobody in particular: a pronoun, or a bare man or woman. Two of them in two
 * sentences are not one person or thing by their words.
 */
export const PRONOUN_SUBJECTS = Object.freeze([
  "he",
  "she",
  "they",
  "him",
  "her",
  "them",
  "himself",
  "herself",
  "themselves",
  "it",
  "you",
  "someone",
  "somebody",
  "everyone",
  "everybody",
  ...["this", "that", "the", "a"].flatMap((d) =>
    ["man", "woman", "person", "lady", "gentleman", "boy", "girl"].map((n) => `${d} ${n}`),
  ),
]);

const PRONOUN_SET = new Set(PRONOUN_SUBJECTS);

/** True when a subject span is a pronoun or a bare man or woman. */
export const pronounSubject = (text) =>
  PRONOUN_SET.has(
    normaliseSpan(text ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, ""),
  );

/** The kin and household nouns that, after a possessive, name somebody of the witness's own. */
export const KIN_TERMS = Object.freeze([
  "daughter",
  "son",
  "child",
  "children",
  "kids",
  "baby",
  "husband",
  "wife",
  "partner",
  "boyfriend",
  "girlfriend",
  "fiance",
  "fiancee",
  "mother",
  "father",
  "mum",
  "mom",
  "dad",
  "parent",
  "parents",
  "brother",
  "sister",
  "sibling",
  "grandmother",
  "grandfather",
  "grandson",
  "granddaughter",
  "grandchildren",
  "nan",
  "aunt",
  "uncle",
  "cousin",
  "niece",
  "nephew",
  "family",
  "relative",
  "neighbour",
  "neighbor",
  "flatmate",
  "friend",
  "carer",
  "household",
]);

const KIN_SET = new Set(KIN_TERMS);
const POSSESSIVES = new Set(["my", "our", "his", "her", "their"]);
const PLURAL_PRONOUNS = new Set(["we", "us"]);

const subjectWords = (text) =>
  normaliseSpan(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(" ")
    .filter(Boolean);

/** True when a subject span is a possessive followed by a kin or household noun as its head. */
export function kinSubject(text) {
  const words = subjectWords(text);
  if (words.length < 2 || !POSSESSIVES.has(words[0])) return false;
  const head = words.at(-1).replace(/'s$/, "");
  return KIN_SET.has(head) || (head.endsWith("s") && KIN_SET.has(head.slice(0, -1)));
}

/**
 * True when a person or group subject names nobody the registers know: a pronoun, or a possessive
 * kin term, with no subject entity.
 */
export function unnamedSubject(a) {
  if (a.subjectKind !== "person" && a.subjectKind !== "group") return false;
  if (a.subjectEntityId) return false;
  const words = subjectWords(a.subjectText);
  return (
    pronounSubject(a.subjectText) ||
    (words.length === 1 && PLURAL_PRONOUNS.has(words[0])) ||
    kinSubject(a.subjectText)
  );
}

const LEADING_WORDS = new Set([
  "i",
  "we",
  "he",
  "she",
  "they",
  "you",
  "it",
  "then",
  "also",
  "had",
  "have",
  "has",
  "was",
  "were",
  "did",
  "do",
  "would",
  "could",
  "must",
  "then",
  "just",
  "first",
]);

/** The predicate in lower case without punctuation, a leading pronoun or auxiliary. */
export function normalisePredicate(predicate) {
  const words = normaliseSpan(predicate ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && LEADING_WORDS.has(words[0])) words.shift();
  return words.join(" ");
}

const normaliseObject = (text) =>
  normaliseSpan(text ?? "")
    .toLowerCase()
    .replace(/^(the|a|an|my|our|his|her|their) /, "");

/** True when the witness is the subject of the claim (I, we, me). */
export const firstPerson = (a) => a.subjectKind === "witness";

/**
 * The text a claim is embedded by: a subject other than the witness, the predicate and its object.
 */
export const claimText = (a) =>
  [firstPerson(a) ? null : a.subjectText, a.predicate, a.objectText].filter(Boolean).join(" ");

/**
 * True when two assertions have one subject: the same witness in the first person, or a witness's
 * first person against a subject resolved to that witness, or one resolved subject entity, or the
 * same words for a person, group or thing that are not a pronoun. An assertion with no recorded
 * subject shares none.
 */
export function sameSubject(a, b) {
  if (!a.subjectKind || !b.subjectKind) return false;
  if (firstPerson(a) && firstPerson(b)) return a.witnessId === b.witnessId;
  if (firstPerson(a) || firstPerson(b)) {
    const [self, other] = firstPerson(a) ? [a, b] : [b, a];
    return Boolean(other.subjectWitnessId) && other.subjectWitnessId === self.witnessId;
  }
  if (a.subjectEntityId && b.subjectEntityId) return a.subjectEntityId === b.subjectEntityId;
  if (pronounSubject(a.subjectText) || pronounSubject(b.subjectText)) return false;
  const subject = normaliseObject(a.subjectText);
  return subject !== "" && subject === normaliseObject(b.subjectText);
}

/**
 * True when two assertions' subjects resolve to one register entry: one subject entity, or a
 * witness's first person against a subject resolved to that witness.
 */
export function sameRegisteredSubject(a, b) {
  if (firstPerson(a) && firstPerson(b)) return false;
  if (firstPerson(a) || firstPerson(b)) {
    const [self, other] = firstPerson(a) ? [a, b] : [b, a];
    return Boolean(other.subjectWitnessId) && other.subjectWitnessId === self.witnessId;
  }
  return Boolean(a.subjectEntityId) && a.subjectEntityId === b.subjectEntityId;
}

/** True when two assertions name one event. */
export const sameEvent = (a, b) => Boolean(a.eventId) && a.eventId === b.eventId;

/** True when two assertions are about the same object: the same entity, or the same words. */
export function sameObject(a, b) {
  if (a.objectEntityId && b.objectEntityId) return a.objectEntityId === b.objectEntityId;
  return normaliseObject(a.objectText) === normaliseObject(b.objectText);
}

/** True when two assertions state the same place, or neither states one. */
export function samePlace(a, b) {
  if (a.placeEntityId && b.placeEntityId) return a.placeEntityId === b.placeEntityId;
  return normaliseObject(a.placeText) === normaliseObject(b.placeText);
}

/** The anchors two assertions share, by name: those of a self pair or of a cross pair. */
export function sharedAnchors(a, b) {
  const out = [];
  const sameObjectEntity = Boolean(a.objectEntityId) && a.objectEntityId === b.objectEntityId;
  if (a.witnessId !== b.witnessId) {
    if (unnamedSubject(a) || unnamedSubject(b)) return [];
    const event = sameEvent(a, b);
    if (firstPerson(a) && firstPerson(b)) {
      return event && a.claimKind === "observation" && b.claimKind === "observation"
        ? ["event"]
        : [];
    }
    if (a.claimKind === "attribute" || b.claimKind === "attribute") {
      return sameRegisteredSubject(a, b) ? ["subject"] : [];
    }
    if (event) out.push("event");
    if (sameSubject(a, b)) out.push("subject");
    if (sameObjectEntity && CROSS_OBJECT_KINDS.includes(a.objectEntityKind)) out.push("object");
    return out;
  }
  if (sameEvent(a, b)) out.push("event");
  if (sameSubject(a, b)) out.push("subject");
  if (sameObjectEntity) out.push("object");
  if (a.placeEntityId && a.placeEntityId === b.placeEntityId) out.push("place");
  if (normalisePredicate(a.predicate) === normalisePredicate(b.predicate)) out.push("predicate");
  return out;
}

/** True when a pair with these anchors and this similarity is a candidate. */
const anchored = (a, b, anchors, s, alone) =>
  anchors.length > 0 || (a.witnessId === b.witnessId && s >= alone);

export const eligible = (a) =>
  Boolean(a.witnessId) &&
  (a.confidence === null || a.confidence === undefined || a.confidence >= MIN_CONFIDENCE);

export function unit(vector) {
  const v = Float32Array.from(vector);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (!(norm > 0)) throw new Error("an embedding has no length");
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function dot(x, y) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * y[i];
  return s;
}

const byStatement = (x, y) =>
  (x.statementDate ?? "9999").localeCompare(y.statementDate ?? "9999") ||
  String(x.documentId).localeCompare(String(y.documentId)) ||
  Number(x.id) - Number(y.id);

/** The group a pair is shown in: its event, or the earlier assertion's predicate. */
export function groupOf(a, b) {
  const eventId = a.eventId ?? b?.eventId ?? null;
  return { eventId, topic: normalisePredicate(a.predicate) };
}

export const groupKey = ({ eventId, topic }) => (eventId ? `event:${eventId}` : `topic:${topic}`);

/** The identity of a pair, the same in memory and in the store. */
export const pairKey = ({ kind, a, b, fact }) => `${kind}:${a.id}:${b?.id ?? 0}:${fact?.id ?? 0}`;

/** Texts sent to one embed call; a run that stops loses at most this many vectors. */
export const EMBED_BATCH = 64;

/**
 * Embeds the distinct texts once and returns a lookup of unit vectors.
 * @param {{ embed: (texts: string[]) => Promise<number[][]> }} provider
 * @param {string[]} texts
 * @param {number} [batch]
 */
export async function embedTexts(provider, texts, batch = EMBED_BATCH) {
  const distinct = [...new Set(texts)];
  const vectors = new Map();
  for (let i = 0; i < distinct.length; i += batch) {
    const slice = distinct.slice(i, i + batch);
    const out = await provider.embed(slice);
    if (out.length !== slice.length)
      throw new Error(`embed returned ${out.length} vectors for ${slice.length} texts`);
    slice.forEach((text, j) => vectors.set(text, unit(out[j])));
  }
  return vectors;
}

/**
 * The self and cross candidate pairs over eligible assertions. Candidates are taken most similar
 * first; a pair is dropped when either assertion already has MAX_PARTNERS pairs or its group
 * already has MAX_PAIRS_PER_GROUP.
 * @param {object[]} assertions eligible assertions
 * @param {Map<string, Float32Array>} vectors by claimText
 * @param {object} [bounds]
 * @param {() => boolean} [shouldStop] checked once per assertion; true ends the scan at once
 * @returns {{ pairs: object[], candidates: number, dropped: number, stopped?: true }}
 */
export function alignAssertions(
  assertions,
  vectors,
  {
    similarity = ALIGN_SIMILARITY,
    alone = ALIGN_SIMILARITY_ALONE,
    maxPartners = MAX_PARTNERS,
    maxPerGroup = MAX_PAIRS_PER_GROUP,
  } = {},
  shouldStop,
) {
  const items = assertions.map((a) => ({ a, v: vectors.get(claimText(a)) }));
  for (const { a, v } of items) if (!v) throw new Error(`assertion ${a.id} has no claim vector`);
  const candidates = [];
  for (let i = 0; i < items.length; i++) {
    if (shouldStop?.()) return { pairs: [], candidates: 0, dropped: 0, stopped: true };
    const x = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const y = items[j];
      if (x.a.witnessId === y.a.witnessId && x.a.documentId === y.a.documentId) continue;
      const s = dot(x.v, y.v);
      if (s < similarity) continue;
      const anchors = sharedAnchors(x.a, y.a);
      if (!anchored(x.a, y.a, anchors, s, alone)) continue;
      const [a, b] = [x.a, y.a].sort(byStatement);
      const kind = a.witnessId === b.witnessId ? "self" : "cross";
      candidates.push({ kind, a, b, fact: null, similarity: s, anchors, ...groupOf(a, b) });
    }
  }
  candidates.sort(
    (p, q) =>
      q.similarity - p.similarity ||
      Number(p.a.id) - Number(q.a.id) ||
      Number(p.b.id) - Number(q.b.id),
  );
  const degree = new Map();
  const perGroup = new Map();
  const pairs = [];
  let dropped = 0;
  for (const p of candidates) {
    const g = groupKey(p);
    if (
      (degree.get(p.a.id) ?? 0) >= maxPartners ||
      (degree.get(p.b.id) ?? 0) >= maxPartners ||
      (perGroup.get(g) ?? 0) >= maxPerGroup
    ) {
      dropped++;
      continue;
    }
    degree.set(p.a.id, (degree.get(p.a.id) ?? 0) + 1);
    degree.set(p.b.id, (degree.get(p.b.id) ?? 0) + 1);
    perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    pairs.push(p);
  }
  return { pairs, candidates: candidates.length, dropped };
}

/** The text an accepted fact is embedded by: its source assertion's claim, else its own text. */
export const factText = (fact, source) => (source ? claimText(source) : fact.text);

/**
 * The accepted pairs: each witness assertion similar to an accepted fact, at most
 * MAX_PAIRS_PER_FACT a fact, most similar first. A fact made from an assertion is not compared
 * with that assertion.
 * @param {{ id: string, assertionId: string | null, text: string }[]} facts
 * @param {object[]} assertions eligible assertions
 * @param {Map<string, object>} byId every loaded assertion by id
 * @param {Map<string, Float32Array>} vectors by claimText and factText
 */
export function alignFacts(
  facts,
  assertions,
  byId,
  vectors,
  {
    similarity = ALIGN_SIMILARITY,
    alone = ALIGN_SIMILARITY_ALONE,
    maxPerFact = MAX_PAIRS_PER_FACT,
  } = {},
) {
  const pairs = [];
  for (const fact of facts) {
    const source = fact.assertionId ? (byId.get(fact.assertionId) ?? null) : null;
    const fv = vectors.get(factText(fact, source));
    if (!fv) throw new Error(`accepted fact ${fact.id} has no vector`);
    const found = [];
    for (const a of assertions) {
      if (a.id === fact.assertionId) continue;
      const s = dot(fv, vectors.get(claimText(a)));
      if (s < similarity) continue;
      const anchors = source ? sharedAnchors(a, source) : [];
      if (source && !anchored(a, source, anchors, s, alone)) continue;
      found.push({
        kind: "accepted",
        a,
        b: source,
        fact,
        similarity: s,
        anchors,
        ...groupOf(a, source),
      });
    }
    found.sort((p, q) => q.similarity - p.similarity || Number(p.a.id) - Number(q.a.id));
    pairs.push(...found.slice(0, maxPerFact));
  }
  return { pairs };
}
