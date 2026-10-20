// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

const FENCE_OPEN = /^```[A-Za-z]*[ \t]*\r?\n?/;

/** The text of the first brace-balanced object in `text`, or null. Braces inside strings do not count. */
function firstObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse the JSON object in a model reply. A reply may be a bare object, a fenced block followed
 * by prose, or an object inside prose.
 * @param {string} content
 * @param {string} describe  names the model in the error
 */
export function parseJsonReply(content, describe) {
  const trimmed = content.trim();
  let candidate;
  const open = FENCE_OPEN.exec(trimmed);
  if (open) {
    const rest = trimmed.slice(open[0].length);
    const close = rest.indexOf("```");
    candidate = close < 0 ? rest : rest.slice(0, close);
  } else {
    candidate = firstObject(trimmed);
  }
  try {
    if (candidate === null) throw new Error("no JSON object");
    return JSON.parse(candidate);
  } catch {
    throw new Error(`${describe} returned invalid JSON: ${content.slice(0, 200)}`);
  }
}
