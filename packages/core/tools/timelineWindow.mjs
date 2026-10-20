// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// timeline_window: the assertions of one corpus whose stated time, parsed as a window on the
// night, overlaps a clock range, earliest first.
import { factsTimeline } from "../facts/views.mjs";
import {
  MAX_TOOL_ROWS,
  ToolInputError,
  assertionSide,
  clockRange,
  eventIdByName,
  optionalText,
  overlaps,
  withEvidence,
} from "./shared.mjs";

export const timelineWindow = {
  name: "timeline_window",
  description:
    "Lists the stored assertions of this corpus whose stated time overlaps a clock range on " +
    "the night, earliest first, with the window each time phrase gives and the sentence as an " +
    "evidence block. from and to are HH:MM; a time from 18:00 is the evening before. Optional " +
    "filters: a witness id and an event name. Returns at most 50 assertions and says when " +
    "there are more.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "HH:MM" },
      to: { type: "string", description: "HH:MM" },
      witness: { type: "string" },
      event: { type: "string" },
    },
    required: ["from", "to"],
  },
  async run({ db, corpus }, input) {
    const range = clockRange(input);
    if (!range) throw new ToolInputError("the tool needs from and to");
    const eventId = await eventIdByName(db, optionalText(input, "event"));
    const { points } = await factsTimeline(db, {
      corpus,
      eventId: eventId,
      witnessId: optionalText(input, "witness"),
    });
    const inside = points.filter((p) => overlaps(p.window, range));
    const shown = inside.slice(0, MAX_TOOL_ROWS).map((p) => ({
      ...assertionSide(p),
      window: { from: p.window.startClock, to: p.window.endClock, hedged: p.window.hedged },
    }));
    return withEvidence(db, shown, {
      total: inside.length,
      truncated: inside.length > MAX_TOOL_ROWS,
    });
  },
};
