// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Builds the contextual header that prefixes every embedded string, in this
 * field order: corpus, witness, role, statement date, event date, section heading, locator.
 * Missing fields are left out.
 * Example: [Grenfell Inquiry | Witness IWS00001200 | resident, floor 18 |
 * statement 6 Aug 2019 | event 14 Jun 2017 | p.3 para 11]
 * @param {{ corpus: string, witnessId?: string, role?: string, heading?: string,
 *   statementDate?: string | Date, eventDate?: string | Date,
 *   locator?: string | { page?: number, paragraph?: number, line?: number,
 *     startMs?: number } }} fields
 */
export function buildHeader({
  corpus,
  witnessId,
  role,
  statementDate,
  eventDate,
  heading,
  locator,
}) {
  const parts = [
    corpus,
    witnessId && `Witness ${witnessId}`,
    role,
    statementDate && `statement ${formatDate(statementDate)}`,
    eventDate && `event ${formatDate(eventDate)}`,
    heading,
    formatLocator(locator),
  ].filter(Boolean);
  return `[${parts.join(" | ")}]`;
}

/** ISO dates and Date objects become "6 Aug 2019"; other strings pass through. */
export function formatDate(value) {
  if (value instanceof Date) {
    return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]} ${value.getUTCFullYear()}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!iso) return String(value);
  return `${Number(iso[3])} ${MONTHS[Number(iso[2]) - 1]} ${iso[1]}`;
}

/** Page and paragraph become "p.3 para 11"; page and line become "p.12:5"; media becomes "t 01:14:30". */
export function formatLocator(locator) {
  if (!locator) return "";
  if (typeof locator === "string") return locator;
  const parts = [];
  if (locator.page != null) {
    parts.push(locator.line != null ? `p.${locator.page}:${locator.line}` : `p.${locator.page}`);
  }
  if (locator.paragraph != null) parts.push(`para ${locator.paragraph}`);
  if (locator.startMs != null) parts.push(`t ${formatMs(locator.startMs)}`);
  return parts.join(" ");
}

function formatMs(ms) {
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
