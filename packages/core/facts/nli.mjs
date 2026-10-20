// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Labelling a candidate pair. The rules pass decides what the stored fields already decide: the
// same claim with opposite polarity, or with time windows that do not overlap, contradicts; the
// same claim with the same polarity, place and an overlapping or absent time agrees. Every other
// pair goes to the model pass, which labels a batch of pairs in one call. Each label carries a
// one-line reason and one span from each side; a span the code cannot find in its sentence, or in
// the accepted fact's text, rejects the label.

import { normalisePredicate, sameObject, samePlace } from "./align.mjs";
import { normaliseSpan } from "./registers.mjs";
import { parseTimeWindow, windowsDisjoint } from "./timeline.mjs";

export const RULES_MODEL = "rules-v1";
export const NLI_PROMPT_VERSION = "nli-v1";
export const PAIRS_PER_CALL = 8;
export const REASON_MAX = 240;

export const WITNESS_LABELS = Object.freeze(["agree", "contradict", "unrelated"]);
export const ACCEPTED_LABELS = Object.freeze(["consistent", "inconsistent", "not_covered"]);

/** The labels a pair of this kind may take. */
export const labelsFor = (kind) => (kind === "accepted" ? ACCEPTED_LABELS : WITNESS_LABELS);

const AS_ACCEPTED = { agree: "consistent", contradict: "inconsistent" };

/** The text side B of a pair is read from: the other sentence, or the accepted fact. */
export const textB = (pair) => (pair.kind === "accepted" ? pair.fact.text : pair.b.sentence);

/** True when a span is a non-empty part of a text, compared after whitespace is collapsed. */
export function spanIn(span, text) {
  if (typeof span !== "string") return false;
  const s = normaliseSpan(span);
  return s.length > 0 && normaliseSpan(text ?? "").includes(s);
}

/**
 * The rules label for a pair, or null when the stored fields do not decide it.
 * @returns {{ label: string, reason: string, spanA: string, spanB: string } | null}
 */
export function rulesLabel(pair) {
  const { kind, a } = pair;
  const b = pair.b;
  if (!b) return null;
  const predicate = normalisePredicate(a.predicate);
  if (predicate !== normalisePredicate(b.predicate) || !sameObject(a, b)) return null;
  const about = a.objectText ? `"${predicate}" "${normaliseSpan(a.objectText)}"` : `"${predicate}"`;
  let decided = null;
  if (a.polarity !== b.polarity) {
    decided = {
      label: "contradict",
      reason: `polarity: ${a.polarity} against ${b.polarity} on the same predicate and object ${about}`,
      spanA: a.predicate,
      spanB: b.predicate,
    };
  } else {
    const wa = parseTimeWindow(a.timeText);
    const wb = parseTimeWindow(b.timeText);
    if (wa && wb && windowsDisjoint(wa, wb)) {
      decided = {
        label: "contradict",
        reason: `time: "${a.timeText}" (${wa.startClock}-${wa.endClock}) and "${b.timeText}" (${wb.startClock}-${wb.endClock}) do not overlap for ${about}`,
        spanA: a.timeText,
        spanB: b.timeText,
      };
    } else if (samePlace(a, b) && ((wa && wb) || (!a.timeText && !b.timeText))) {
      decided = {
        label: "agree",
        reason: wa
          ? `same predicate, object, polarity and place for ${about}; times "${a.timeText}" and "${b.timeText}" overlap`
          : `same predicate, object, polarity and place for ${about}`,
        spanA: a.predicate,
        spanB: b.predicate,
      };
    }
  }
  if (!decided) return null;
  if (!spanIn(decided.spanA, a.sentence) || !spanIn(decided.spanB, textB(pair))) return null;
  if (kind === "accepted") decided.label = AS_ACCEPTED[decided.label];
  decided.reason = decided.reason.slice(0, REASON_MAX);
  return decided;
}

const WITNESS_RULES = [
  "You compare two sentences from witness statements to a public inquiry.",
  "For each numbered pair, label how sentence B relates to sentence A on the matter they share:",
  "agree when B states the same thing as A; contradict when B and A cannot both be true (a different time, place, person, number or a denial); unrelated when they are not about the same matter.",
  "Different wording, more detail, or a hedge such as 'about' is not a contradiction. Times stated with 'about' or 'around' agree when they are within ten minutes.",
];
const ACCEPTED_RULES = [
  "You compare a sentence from a witness statement with an accepted fact.",
  "For each numbered pair, label the witness sentence A against the accepted fact B:",
  "consistent when A agrees with B; inconsistent when A and B cannot both be true; not_covered when B says nothing about the matter of A.",
];
const COMMON_RULES = [
  "Use only the two texts of each pair. Do not use anything you know about the real event, and do not judge the witness.",
  "reason is one line of at most 30 words naming what agrees or differs.",
  "span_a is the exact words from A that the label rests on, copied with the same spelling and case; span_b is the exact words from B. Do not paraphrase.",
  'Reply as JSON: {"labels": [{"pair": n, "label": "...", "reason": "...", "span_a": "...", "span_b": "..."}]}, one entry for each pair.',
];

/** The prompt for one batch of pairs of one family (witness pairs, or accepted pairs). */
export function nliPrompt(batch) {
  const accepted = batch[0].kind === "accepted";
  const lines = [...(accepted ? ACCEPTED_RULES : WITNESS_RULES), ...COMMON_RULES, ""];
  batch.forEach((pair, i) => {
    lines.push(`Pair ${i + 1}`);
    lines.push(`A: ${normaliseSpan(pair.a.sentence)}`);
    lines.push(`B: ${normaliseSpan(textB(pair))}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/** The schema of a reply to nliPrompt. */
export function nliSchema(kind) {
  return {
    type: "object",
    properties: {
      labels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            pair: { type: "integer" },
            label: { enum: [...labelsFor(kind)] },
            reason: { type: "string" },
            span_a: { type: "string" },
            span_b: { type: "string" },
          },
          required: ["pair", "label", "reason", "span_a", "span_b"],
        },
      },
    },
    required: ["labels"],
  };
}

const reject = (reason, value) => ({ ok: false, reason, value });

/**
 * Checks one label the model returned against its batch.
 * @param {unknown} raw
 * @param {object[]} batch
 * @returns {{ ok: true, index: number, label: string, reason: string, spanA: string,
 *   spanB: string } | { ok: false, reason: string, value: unknown }}
 */
export function checkLabel(raw, batch) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("not-an-object", raw);
  const index = raw.pair - 1;
  const pair = Number.isInteger(raw.pair) ? batch[index] : undefined;
  if (!pair) return reject("not-a-pair", raw.pair);
  if (!labelsFor(pair.kind).includes(raw.label)) return reject("label-not-allowed", raw.label);
  if (typeof raw.reason !== "string" || !normaliseSpan(raw.reason))
    return reject("no-reason", raw.reason);
  if (/[\r\n]/.test(raw.reason.trim())) return reject("reason-not-one-line", raw.reason);
  if (!spanIn(raw.span_a, pair.a.sentence)) return reject("span-a-not-in-sentence", raw.span_a);
  if (!spanIn(raw.span_b, textB(pair))) return reject("span-b-not-in-sentence", raw.span_b);
  return {
    ok: true,
    index,
    label: raw.label,
    reason: normaliseSpan(raw.reason).slice(0, REASON_MAX),
    spanA: normaliseSpan(raw.span_a),
    spanB: normaliseSpan(raw.span_b),
  };
}
