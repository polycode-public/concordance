// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The corpus the page reads: one of config.json's corpora, chosen in the header and kept per
// browser. Every route the page fetches names it as ?corpus=.

export const STORAGE_KEY = "concordance.corpus";

/**
 * The corpora of config.json, checked: at least one, each with an id and a name.
 * @param {{ corpora?: unknown }} config
 * @returns {{ id: string, name: string }[]}
 */
export function configCorpora(config) {
  const corpora = config?.corpora;
  if (!Array.isArray(corpora) || corpora.length === 0) {
    throw new Error("config.json lists no corpora");
  }
  for (const c of corpora) {
    if (typeof c?.id !== "string" || !c.id || typeof c.name !== "string" || !c.name) {
      throw new Error("config.json has a corpus without an id and a name");
    }
  }
  return corpora;
}

/**
 * The stored choice when config.json still lists it, else the first corpus.
 * @param {{ id: string }[]} corpora
 * @param {string | null} stored
 */
export const chooseCorpus = (corpora, stored) =>
  corpora.some((c) => c.id === stored) ? stored : corpora[0].id;

/**
 * A route URL with the corpus in its query; the URL may be relative to the page.
 * @param {string} url
 * @param {string} corpus
 * @param {string} [pageUrl]
 */
export function withCorpus(url, corpus, pageUrl = globalThis.location?.href) {
  const absolute = new URL(url, pageUrl);
  absolute.searchParams.set("corpus", corpus);
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
    ? absolute.href
    : `${absolute.pathname}${absolute.search}${absolute.hash}`;
}

/** The stored choice, or null where the browser keeps no storage for the page. */
export function readStoredCorpus(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Keeps the choice for the next visit, where the browser allows it. */
export function storeCorpus(corpus, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, corpus);
  } catch {
    // A private window or blocked storage forgets the choice; the page still works.
  }
}
