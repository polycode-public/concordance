// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  InvalidThread,
  NothingToExport,
  exportConversation,
  isNoteKey,
  noteKey,
  renderConversation,
} from "../../packages/core/export.mjs";

const SESSION = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
const CORPUS = { id: "grenfell", title: "Grenfell Tower Inquiry" };
const frame = (type, rest) => ({ type, thread: "main", turnId: "x", ...rest });

const TURNS = [
  {
    userText: "Was the stair lit?\nAnd the lobby?",
    promptVersion: "p9",
    modelId: "eu.model-1",
    createdAt: "2026-10-19T09:30:00.000Z",
    frames: [
      frame("status", { stage: "answering" }),
      frame("token", { text: "The stairs were dark [E1]. " }),
      frame("token", { text: "The lobby was lit [E2][E1]. Nobody came [E9]." }),
      frame("done", {
        checks: { sentences: 3, supported: 2, droppedCitations: 1, abstained: false },
        citations: [
          { evidence: 1, locator: { document: "IWS00000169", page: 3, paragraph: 11 } },
          { evidence: 2, locator: { document: "IWS00000170", page: null, paragraph: 4 } },
        ],
      }),
    ],
  },
  {
    userText: "Who owned the flat?",
    promptVersion: "p9",
    modelId: "eu.model-1",
    createdAt: "2026-10-19T09:31:00.000Z",
    frames: [
      frame("token", { text: "The corpus does not say." }),
      frame("done", {
        checks: { sentences: 1, supported: 0, droppedCitations: 0, abstained: true },
        citations: [],
      }),
    ],
  },
];

const EXPECTED = `# Grenfell Tower Inquiry: conversation 2026-10-19

Session 6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b, thread main

## Turn 1

You asked:

> Was the stair lit?
> And the lobby?

The stairs were dark [^1-E1]. The lobby was lit [^1-E2][^1-E1]. Nobody came ~~[E9]~~.

Unresolved tags: [E9]

2 of 3 sentences supported, 1 citation dropped

Prompt p9, model eu.model-1

[^1-E1]: IWS00000169, page 3, paragraph 11
[^1-E2]: IWS00000170, paragraph 4

## Turn 2

You asked:

> Who owned the flat?

The corpus does not say.

No claim made

Prompt p9, model eu.model-1

## Referenced documents

- IWS00000169: 1 citation
- IWS00000170: 1 citation

## Accepted facts

None promoted in this conversation.
`;

const render = (turns = TURNS) =>
  renderConversation({ corpus: CORPUS, session: { sessionId: SESSION, thread: "main" }, turns });

describe("the conversation document", () => {
  it("renders two turns byte for byte", () => {
    expect(render()).toBe(EXPECTED);
    expect(render()).toBe(render());
  });

  it("takes every footnote from the stored citations and never from the answer text", () => {
    const turns = [
      {
        ...TURNS[0],
        frames: [
          frame("token", { text: "Claimed [E1] in IWS99999999 page 7." }),
          frame("done", {
            checks: { sentences: 1, supported: 1, droppedCitations: 0, abstained: false },
            citations: [{ evidence: 1, locator: { document: "IWS1", page: 2, paragraph: 5 } }],
          }),
        ],
      },
    ];
    const md = render(turns);
    expect(md).toContain("[^1-E1]: IWS1, page 2, paragraph 5");
    expect(md).not.toContain("[^1-E1]: IWS99999999");
    expect(md).toContain("- IWS1: 1 citation");
  });

  it("strikes a tag with no citation and lists it as unresolved", () => {
    const md = render();
    expect(md).toContain("Nobody came ~~[E9]~~.");
    expect(md).toContain("Unresolved tags: [E9]");
    expect(md).not.toContain("[^1-E9]");
  });

  it("states an interrupted turn and an errored turn without a score", () => {
    const md = render([
      { ...TURNS[0], frames: [frame("token", { text: "Part" }), frame("cancelled", {})] },
      { ...TURNS[1], frames: [frame("error", { message: "model unreachable" })] },
    ]);
    expect(md).toContain("Not completed: interrupted");
    expect(md).toContain("Not completed: model unreachable");
  });

  it("counts a document once with its citations across turns", () => {
    const again = {
      ...TURNS[1],
      frames: [
        frame("token", { text: "Dark [E1]." }),
        frame("done", {
          checks: { sentences: 1, supported: 1, droppedCitations: 0, abstained: false },
          citations: [
            { evidence: 1, locator: { document: "IWS00000169", page: 3, paragraph: 12 } },
          ],
        }),
      ],
    };
    expect(render([TURNS[0], again])).toContain("- IWS00000169: 2 citations");
  });
});

describe("note keys", () => {
  it("builds notes/<session>/<thread>-<time>.md with a lower-case timestamp", () => {
    expect(
      noteKey({ sessionId: SESSION, thread: "main", now: new Date("2026-10-19T09:30:01.234Z") }),
    ).toBe(`notes/${SESSION}/main-2026-10-19t09-30-01.234z.md`);
  });

  it("accepts segments of [a-z0-9][a-z0-9._-]{0,79} to a depth of four", () => {
    expect(isNoteKey("notes/a/b/c.md")).toBe(true);
    expect(isNoteKey("notes/a/b/c/d.md")).toBe(false);
    expect(isNoteKey(`notes/${"a".repeat(80)}`)).toBe(true);
    expect(isNoteKey(`notes/${"a".repeat(81)}`)).toBe(false);
    for (const bad of [
      "notes",
      "notes/",
      "notes/../x",
      "notes/A",
      "notes/a b",
      "other/a",
      "notes//a",
      "notes/.a",
    ]) {
      expect(isNoteKey(bad)).toBe(false);
    }
  });

  it("refuses a thread that does not fit a segment", () => {
    expect(() => noteKey({ sessionId: SESSION, thread: "Main Thread" })).toThrow(/not a valid key/);
  });
});

describe("exporting a thread", () => {
  const db = (turns) => ({
    query: async (text) =>
      /FROM sessions/.test(text) ? { rows: turns ? [{}] : [] } : { rows: turns ?? [] },
  });
  const row = (turn) => ({
    thread: "main",
    turn_id: "x",
    user_text: turn.userText,
    prompt_version: turn.promptVersion,
    model_id: turn.modelId,
    frames: turn.frames,
    created_at: turn.createdAt,
  });
  const which = { sessionId: SESSION, userId: "u", thread: "main" };

  it("renders the stored turns and hands the key and Markdown to the writer", async () => {
    const written = [];
    const result = await exportConversation({
      db: db(TURNS.map(row)),
      which,
      corpus: CORPUS,
      now: new Date("2026-10-19T10:00:00.000Z"),
      write: async (key, markdown) => (
        written.push({ key, markdown }),
        { key, bytes: 1, url: "u" }
      ),
    });
    expect(result.key).toBe(`notes/${SESSION}/main-2026-10-19t10-00-00.000z.md`);
    expect(written[0].markdown).toBe(EXPECTED);
  });

  it("throws when the session is not the user's or the thread is empty", async () => {
    const write = async () => {
      throw new Error("must not write");
    };
    await expect(
      exportConversation({ db: db(null), which, corpus: CORPUS, write }),
    ).rejects.toThrow(NothingToExport);
    await expect(exportConversation({ db: db([]), which, corpus: CORPUS, write })).rejects.toThrow(
      NothingToExport,
    );
    await expect(
      exportConversation({
        db: db([]),
        which: { ...which, thread: "../x" },
        corpus: CORPUS,
        write,
      }),
    ).rejects.toThrow(InvalidThread);
  });
});
