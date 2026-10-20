// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

/** The filename the reports routes accept. */
export const FILENAME = /^[a-z0-9][a-z0-9-]*\.md$/;
export const FILENAME_MAX = 128;

const WORDS = 6;

/**
 * A filename from a topic: its first words, lower-case, joined by dashes.
 * @param {string} topic
 * @returns {string}
 */
export function slugFilename(topic) {
  const words = topic.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let slug = words
    .slice(0, WORDS)
    .join("-")
    .slice(0, FILENAME_MAX - ".md".length);
  slug = slug.replace(/-+$/, "");
  return `${slug || "report"}.md`;
}

/**
 * The first filename in a chat message that names a report the user has, or null.
 * @param {string} text
 * @param {string[]} filenames
 * @returns {string | null}
 */
export function editTarget(text, filenames) {
  const known = new Set(filenames);
  for (const match of text
    .toLowerCase()
    .matchAll(/(?<![\w.-])([a-z0-9][a-z0-9-]*\.md)(?![\w-])/g)) {
    if (known.has(match[1])) return match[1];
  }
  return null;
}
