<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Concordance design record

The visual system for the page in `packages/ui/`. A row that changes the page reads this first.
The specification is `docs/SPEC_WITNESS_RESEARCH_TOOL.md`; the phases are in `PLAN_CONCORDANCE.md`;
open rows are in `NEXT.md`.

## The survey: what the page must show

One row per view, from the specification (lines 99 to 105, 139 to 143, 149 to 163, 167 to 176),
the plans and the code. "State today" is `main` at `39bde1a`.

| View                           | What it shows                                                                                                                                                                                        | Phase                    | State today                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The turn                       | The question, the four stages (`rewriting`, `retrieving`, `answering`, `checking`), the streamed answer, then the checked answer with a chip after every cited sentence                              | 1, done in 4             | `app.js` streams tokens into one `#answer` that the next turn replaces; the stage is one word with an ellipsis; one turn on screen at a time |
| Sentence colour                | Supported black, unsupported grey, contradicted red; hover shows the supporting span                                                                                                                 | 1 (colour), 4            | `renderChecked` colours supported and unsupported; the `done` frame carries no verdict or span yet                                           |
| The score line                 | `11 of 12 sentences supported, 2 numbers checked`; a warning above 30 % flagged; `no claim made` on an abstention                                                                                    | 1, 4                     | `n of m sentences supported` with the warning colour; an abstention reads `0 of 1 sentences supported` (C5's remainder)                      |
| Citation chip                  | Resolves `[E3]` to document, page, paragraph (or page:line, timecode); a click opens the original at the locator                                                                                     | 1                        | `[E3]` as a button with the header as its title; a click sends `open`                                                                        |
| Referenced-documents panel     | Every document cited in the session once: title, witness id, role, date, type, number of citations, a button that opens at the first cited locator; the bibliography the export carries              | 1, 6                     | An `Evidence` list of this turn's blocks (chip and header); no session bibliography; no title, role, date or type in the frame               |
| PDF viewer                     | PDF.js at the locator with the cited span highlighted; a fallback link to the original                                                                                                               | 1, 3 (highlight)         | `viewer.js` renders the page from `opened.url`; the fallback link shows only on failure; no highlight (F7)                                   |
| Filters                        | Witness, role, source body, statement date, event window, document type, language, accepted facts only                                                                                               | 3 (F7), 5                | None                                                                                                                                         |
| Threads and forks              | Threads as tabs or a side list, each with its own filters and session facts; a message forked into a new thread with its evidence                                                                    | 6 (F12)                  | One thread, `main`, in `app.js`; the protocol has no `fork`                                                                                  |
| Interruption                   | A cancel keeps the partial answer on screen marked `interrupted`                                                                                                                                     | 1                        | Done                                                                                                                                         |
| Contradiction matrix           | Witnesses on both axes per event; `agree`, `contradict`, `unrelated` per cell with the reason and two spans; grouped `time first shot fired: 7 witnesses say…`; every cell a click from both sources | 5 (F10)                  | None; `assertion_comparisons` exists in `0001_initial.sql`                                                                                   |
| Per-witness consistency report | One witness's assertions across documents by statement date; a changed value flagged with both dates                                                                                                 | 5 (F10)                  | None                                                                                                                                         |
| Timeline                       | Each assertion a point, its uncertainty a bar; SVG                                                                                                                                                   | 5 (F10)                  | None                                                                                                                                         |
| Diff of two accounts           | Two versions of one witness's account side by side; refused when the pairing is marked identity-revealing                                                                                            | 5 (F10)                  | None; the flag is F9's migration                                                                                                             |
| Accepted facts                 | The curated table; promote an assertion with a source citation; session hypotheses marked as such; who promoted what                                                                                 | 5 (F10)                  | None; `accepted_facts` exists                                                                                                                |
| Media viewer                   | `<video>` or `<audio>` seeking to `start_ms`, the transcript scrolling with playback, each segment citable                                                                                           | 6 (F12)                  | None                                                                                                                                         |
| Image viewer                   | An image with a bounding-box overlay at the locator                                                                                                                                                  | 6 (F12)                  | None                                                                                                                                         |
| Sign-in                        | Cognito user name and password on the AWS form; none on the laptop form                                                                                                                              | 1                        | `auth.js` and a form in `index.html`; its own styles                                                                                         |
| Bedrock spend banner           | Today's spend against the $25 budget; this conversation's spend                                                                                                                                      | new (U3)                 | None; `concordance-sandbox-guardrails` carries the budget and `packages/aws/checkBudget.mjs` reads it for the agents' kill switch            |
| Conversation list and replay   | Saved conversations, named, reopened; a turn replayed from its stored frames without a model call                                                                                                    | 4 (F8 log), new (U2)     | `sessions` and `session_turns` exist in `0001_initial.sql`; nothing writes them                                                              |
| Document from a conversation   | The transcript with its bibliography and the accepted facts, written as Markdown                                                                                                                     | 6 (F12 export), new (U4) | None                                                                                                                                         |
| Eval scoreboard                | The four metrics per corpus from `evals/grenfell/scoreboard.json`                                                                                                                                    | 7 (F13)                  | None                                                                                                                                         |
| Keyboard                       | Next citation, open source                                                                                                                                                                           | 1                        | Enter sends; nothing else                                                                                                                    |
| Module split                   | `chat.js`, `evidence.js`, `viewer-pdf.js`, `viewer-media.js`, `viewer-image.js`, `facts.js`, `timeline.js`                                                                                           | 6 (F12)                  | `app.js`, `auth.js`, `viewer.js`                                                                                                             |

## The brief

- **Subject.** The witness statements of a public inquiry, read through a tool that puts a
  reference on every sentence and finds where witnesses agree and contradict. The demo corpus is
  the Grenfell Tower Inquiry.
- **Audience.** A head of investigations at an international court and their analysts. A 13-inch
  laptop at a desk; a projector at the back of a room for the demo.
- **Job.** From the back of the room: every sentence carries its reference, the reference is one
  click from the original page, and the matrix shows where accounts diverge. At the desk: an
  analyst works a question to its sources in under a minute without touching the mouse.
- **Constraints, from the product rules.** Evidence is shown byte-exact and never paraphrased by
  the page. Every claim links to a locator the server resolved; the page renders only what the
  frames carry. Every automated judgement shows its evidence and can be overridden. A
  cipher-only witness has no name anywhere. The inquiry is named on screen. The statements are
  about real deaths: no decoration, no motion for its own sake, no synthesis of what a witness
  meant.

## The idea: the bundle is open at the tab

The design uses the trade's own visual language: the evidence bundle, the witness statement and
the hearing transcript as the inquiry printed them, and the schedules counsel prepare from them.

| Convention in the trade                                                                              | What it means here                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The document reference stamped on every page (`IWS00000169`) and the report's `{IWS00000169/3}` cite | A reference reads `IWS00000169 p.3 ¶11`: the document, then its page, then its paragraph. The page builds it from the frame's `documentId` and `locator`, in that order, and never from the answer's text            |
| The bundle tab: a numbered divider, and "tab 3" in argument                                          | The evidence number `[E3]` is the tab. Inline, the chip is the number on a highlighter mark; in the panel the tab stands before its full reference                                                                   |
| Counsel's highlighter on the bundle page                                                             | The highlighter is the one colour on the page. A chip sits on it; the cited span in the PDF will carry it (F7). Nothing else is yellow                                                                               |
| The statement's numbered paragraphs in the margin; the transcript's page and line                    | The locator formats: `¶11` for a statement, `p.45:3` for a transcript, `12:07` for media. The witness's words are set in the statement's own face, a serif, so the tool's prose and the evidence never look the same |
| The bundle index                                                                                     | The referenced-documents panel: one row per document cited this session, its tab numbers, its reference, how often it is cited, `Open at p.3`                                                                        |
| The Scott schedule: parties across the top, items down the side, each party's position in its cell   | The contradiction matrix. Witnesses across the top, events and predicates down the side; the cell holds the label and opens both spans                                                                               |
| The chronology                                                                                       | The timeline: assertions by time, uncertainty as a bar                                                                                                                                                               |
| The redline of two drafts                                                                            | The diff of two accounts: removed words struck once and still legible, added words in ink                                                                                                                            |
| Agreed facts (an admission both sides accept)                                                        | Accepted facts. Promotion is a slip that names the source citation and who promoted it; a session hypothesis stays in pencil                                                                                         |
| A restriction order                                                                                  | A cipher shows as the cipher. A refused side-by-side says `This pairing is marked identity-revealing` and nothing more                                                                                               |
| Black ink is the record; grey is a note; red ink is a correction                                     | A supported sentence is ink. An unsupported sentence is grey. A contradicted sentence is red ink. A dropped citation is struck through                                                                               |

Boldness is spent in one place: the reference system, the chip on its highlighter mark and the
score line under every answer. Everything else is quiet paper. The matrix inherits the same
rule: a cell is a reference.

## Tokens

Every colour, face, size, space and rule is a custom property in `packages/ui/tokens.css`. No
other file under `packages/ui/` names a colour; `test/ui/tokens.test.mjs` enforces it, and checks
that every colour token in `:root` is redefined for dark mode.

### Colour

The base is document white under room light, the ink is black, the one colour is the
highlighter.

| Token                             | Light                | Dark                 | Use                                                                     |
| --------------------------------- | -------------------- | -------------------- | ----------------------------------------------------------------------- |
| `--paper`                         | `#fbfbf9`            | `#17191c`            | the page                                                                |
| `--paper-deep`                    | `#f0f0ec`            | `#21242a`            | a second sheet: the question, the bundle panel, the viewer bar, sign-in |
| `--rule`                          | `#cfd0cb`            | `#3a3e45`            | the 1 px rules between regions and rows                                 |
| `--ink`                           | `#16191d`            | `#ecedef`            | prose, a supported sentence, labels                                     |
| `--ink-soft`                      | `#4a4f57`            | `#b5b9c0`            | secondary prose, the done stages, counts                                |
| `--grey`                          | `#6b7079`            | `#8a9099`            | an unsupported sentence, a pending stage, placeholders                  |
| `--red-ink`                       | `#a1232b`            | `#f0787e`            | a contradicted sentence, an error, a dropped citation                   |
| `--amber`                         | `#8a5a00`            | `#e3b04b`            | the score line's warning, an interrupted answer                         |
| `--highlight`, `--highlight-deep` | `#f7e36b`, `#e9cf3a` | `#5c4e0f`, `#75651a` | the chip and its hover; the cited span in the PDF                       |
| `--focus`                         | `#0b5bd3`            | `#7fb0ff`            | the focus ring                                                          |
| `--button-ink`                    | `#fbfbf9`            | `#17191c`            | text on an ink button                                                   |
| `--scrim`                         | ink at 60 %          | ink at 60 %          | behind a sheet on a narrow screen                                       |

Contrast (WCAG): ink on paper 17.0:1; ink-soft on paper 8.0:1; grey on paper 4.8:1 (4.4:1 on
paper-deep, so grey text sits on `--paper` only); red ink on paper 7.3:1; amber on paper 5.7:1;
ink on highlight 13.6:1. Dark: ink on paper 15.0:1; grey on paper 5.5:1; red ink on paper 6.5:1;
ink on highlight 7.0:1.

### Faces

Two faces. The tool speaks in a sans; the witness speaks in a serif. Nothing else distinguishes
the two voices, so the distinction is never decorative.

| Face           | Token            | Role                                                                                               | Why                                                                                                                                     |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Source Sans 3  | `--face-tool`    | The tool's voice: the answer, labels, buttons, the stage line, references, the score line, sign-in | Open (OFL), a tall x-height for a projector, tabular figures for page and paragraph numbers. Falls back to Helvetica Neue and Arial     |
| Source Serif 4 | `--face-witness` | The witness's words: every evidence block, the hover span, the diff, a cell's two spans            | The statements were typeset in a serif; the words keep their face. Falls back to Times New Roman, the face of the statements themselves |

Today both load from the system stack; self-hosting the two faces from `@fontsource` is row U1b,
because the venue's network is not ours (PDF.js loads from cdnjs today, the same concern).
References use `font-variant-numeric: tabular-nums`. Sentence case everywhere. No capitals-only
labels, no eyebrow labels, no accented single word in a heading.

### Scale

In rem on a 16 px root; the root is 20 px in presenter mode (`?present=1`, `data-present` on
`html`), so the projector gets the same page one quarter larger.

| Step  | Size   | Line | Use                                                       |
| ----- | ------ | ---- | --------------------------------------------------------- |
| small | 0.875  | 1.4  | the stage line, counts, the keys line, the viewer's page  |
| body  | 1      | 1.55 | the answer, the question, the evidence text; measure 68ch |
| lead  | 1.125  | 1.45 | the score line                                            |
| title | 1.25   | 1.3  | the product name, a panel heading                         |
| tab   | 0.8125 | 1    | the number on a chip                                      |

### Space and rule

An 8 px base (`--unit`). The gutter is two units, three in presenter mode. Rules are 1 px in
`--rule`; a region edge is a rule, never a shadow. Radius 2 px on everything (a cut sheet). A
control is at least 44 px tall and wide on a coarse pointer; an inline chip keeps its line height
and grows its hit box with a pseudo-element.

### Motion

Each motion answers an action, runs 150 ms or less, and is an instant change under
`prefers-reduced-motion`. The chip's hover and the stage change are the only motions. Nothing
enters, fades or slides.

## Layout: the three regions

The conversation, the bundle (the referenced documents and this turn's evidence) and the viewer.

Projector and wide laptop (1500 px and wider):

```
┌ Concordance   Grenfell Tower Inquiry: witness statements                 connected  ┐
├──────────────────────────────────┬────────────────────────┬──────────────────────────┤
│ You asked                        │ Referenced documents 2 │ Statement of IWS00000169 │
│ When did residents first see…    │ IWS00000169  tabs 1 3  │ ‹ p.3 of 14 ›  Open the  │
│                                  │   cited 2 times        │   original  Close        │
│ rewriting retrieving answering   │   Open at p.3          │ ┌──────────────────────┐ │
│ checking                         │ IWS00000342  tab 2     │ │                      │ │
│                                  │   cited once           │ │   the PDF page       │ │
│ Residents on the 16th floor saw  │   Open at p.7          │ │                      │ │
│ smoke at 01:14 [1]. The stairs   ├────────────────────────┤ │                      │ │
│ were dark [3]. Nobody came.      │ Evidence this turn     │ │                      │ │
│                                  │ 1 IWS00000169 p.3 ¶11  │ │                      │ │
│ 2 of 3 sentences supported       │   "The stairs were     │ └──────────────────────┘ │
│                                  │    dark."              │                          │
│ ┌ Ask about the witness statements ┐ 2 IWS00000342 p.7 ¶4 │                          │
│ └──────────────────── Send Cancel ┘ │   "…"                │                          │
│ Keys: ] next citation  [ previous  o open  Esc close  / ask                          │
└──────────────────────────────────┴────────────────────────┴──────────────────────────┘
```

- Columns `minmax(0, 5fr) minmax(0, 3fr) minmax(0, 4fr)`; the viewer column is absent until a
  document opens. The conversation scrolls; the bundle scrolls inside itself; the viewer scrolls
  its page.
- The question sits on `--paper-deep` with `You asked` above it in small type; the answer sits on
  the paper with no container. Text is left-aligned throughout.
- The composer is the last row of the conversation column and stays at the bottom.

13-inch laptop (1000 to 1499 px): two columns, `minmax(0, 3fr) minmax(0, 2fr)`; the viewer opens
above the bundle in the right column and takes 60 % of its height.

Narrow (under 1000 px): one column: header, the viewer when open, the conversation, the bundle,
the composer fixed at the foot.

## The views

Each view: what the page shows at 13 inches and on a projector, what is one click from what, and
what the keyboard does.

### The turn

The question, the four stages as a line, the answer, the score line. The stages are a sequence,
so they read as one: `rewriting  retrieving  answering  checking`, the current step in ink at
weight 600, the done steps in `--ink-soft`, the pending steps in `--grey`; when `done` arrives the
line gains the seconds from the first `status` frame. While tokens stream the answer is plain
ink; on `done` the sentences take their colour and their chips. An interrupted answer ends with
`interrupted` in amber. Projector: the stage line is the only moving thing on screen and tells
the room what the machine is doing. Keys: Enter sends, Shift+Enter breaks a line, `/` focuses the
composer from anywhere, Escape cancels a running turn when the composer has focus.

### The citation chip

Inline: the evidence number on a highlighter mark, in `--face-tool` at tab size, baseline-aligned
so the line height does not change. Its accessible name is the full reference, `Evidence 3:
IWS00000169, page 3, paragraph 11`, and its title shows it on hover. A click opens the original at
the locator. On a projector the mark reads from the back of the room because it is the one colour
on the page. Keys: `]` focuses the next chip in the newest answer, `[` the previous, Enter or `o`
opens it. A tag the server did not resolve (`checks.droppedCitations`) is struck through in red ink
and is not a button.

### The score line

Under the answer at lead size, weight 600: `11 of 12 sentences supported`, then `2 citations
dropped` when the frame carries any. Amber when `checks.warning` is true. On `checks.abstained`
it reads `No claim made` in `--ink-soft`: the corpus did not cover the question and no sentence
counts against it. Phase 4 adds the entailment verdict per sentence, red ink for `not_supported`,
and the quoted span on hover in `--face-witness`.

### The referenced-documents panel

The top of the bundle column: `Referenced documents` with the count, one row per document cited
this session (from each `done` frame's `citations`, never from the answer's text): the reference
in ink, the tabs it holds, `cited n times`, and one button, `Open at p.3`, for the first cited
locator. The frame carries `documentId`, `header`, `locator` and `text` today; title, witness id,
role, date and type arrive with row U7. Under it, `Evidence this turn`: every block the model was
given, its tab, its reference, and its text verbatim in `--face-witness` as a quotation; after
`done` the blocks the answer cited stay in ink and the rest go grey, so the room sees what the
model was given against what it used. A click on a tab or a reference opens the original. The
panel is the bibliography the export carries (U4).

### The PDF viewer

The viewer bar on `--paper-deep`: the document title, `‹ p.3 of 14 ›`, `Open the original` (a
link to `url#page=3`, present whether or not PDF.js loaded), `Close`. The page is drawn at the
column's width; the cited span is highlighted in `--highlight` once F7 stores the span. When
PDF.js cannot load or the PDF cannot render, the bar says so in one sentence and the link stays.
Keys: Escape closes; `‹` and `›` are buttons with 44 px targets; the page number is typed into
later (U7). Projector: the viewer takes the right third; the highlight is what the room looks at.

### Filters

A row under the header, hidden until F7: witness, role, statement date, then source body, event
window, document type, language and `accepted facts only`. Each filter is a `<select>` or a date
input with a visible label; the active set reads as a sentence under the row, `IWS00000169 and
IWS00000342, 2017 to 2018`, with one `Clear`. A thread owns its filters (F12).

### Threads and forks

A side list on the left of the conversation column, folded to a row of tabs on a laptop: each
thread's first question, its unread count. `Fork` on a turn's actions copies the evidence into a
new thread with the turn as its first message. A thread owns its filters and its session
hypotheses, shown at the top of its conversation in pencil. Protocol: `fork` (F12).

### The contradiction matrix

The Scott schedule. Witnesses across the top as their ciphers or ids; events and predicates down
the side, grouped by event, the group's summary in its first row (`time first saw smoke: 7
witnesses say 01:10 to 01:20, 2 say later`). A cell holds the label in one word (`agree` in ink,
`contradict` in red ink, `unrelated` in grey, blank when the witness said nothing on it) and the
object text in small type. A click opens the cell: the two spans in `--face-witness`, the
reason, the model, `Override` with the three labels and a required note. Overridden cells carry
a pencil mark. Projector: the matrix fills the screen at tab size with the labels as colour and
word, never colour alone. Keys: arrows move the focused cell, Enter opens it, `o` opens the first
span's source.

### The per-witness consistency report

One witness; their documents by `statement_date` as columns; their assertions as rows; a changed
value shown with both dates and both spans. Red ink on the cell that changed. One click from a
cell to each source.

### The timeline

SVG. Time left to right; one row per witness; each assertion a point with its uncertainty as a
bar in `--ink-soft`; a contradiction group is a bracket joining its points in red ink. A hover or
focus shows the assertion's text and reference; a click opens the source. The axis is the event
window from the filters.

### The diff of two accounts

Two versions of one witness's account, aligned paragraph by paragraph: removed words struck once
in red ink and still legible, added words in ink, unchanged words in `--ink-soft`. Both locators
in the margin. The page refuses the pair when it is marked identity-revealing and shows one
sentence.

### The media and image viewers

Media: `<video>` or `<audio>` seeking to `start_ms`; the transcript beside it in `--face-witness`,
the current segment on `--paper-deep`, each segment a reference. Image: the image at the column's
width with the bounding box as a 2 px rule in `--highlight`. Both open from a chip like the PDF.

### Sign-in

A card on `--paper-deep` centred under the header: `Sign in to Concordance`, the inquiry named
under it, user name and password with visible labels, `Sign in`, and the message in red ink with
`role="alert"`. The laptop form never shows it.

### The Bedrock spend banner

A one-line strip under the header in small type, `--paper-deep`: `Today $3.42 of $25`, a ten-cell
bar, `This conversation $0.08`. Amber at 20 % headroom, red ink at 5 %; at the cap it reads
`Budget reached. The page still opens documents.` Chat Ledger's phosphor strip is the pattern; the
voice here is paper, so no bezel and no glow. Row U3.

### The conversation list and replay

A drawer from the header: `New conversation`, then this user's conversations by last turn with
their first question. Opening one replays its turns from the stored frames without a model call,
through the same `onFrame` path, so the page cannot render a replay differently from a live turn.
Row U2.

### The document created from a conversation

`Export` on the header writes the transcript as Markdown: the questions, the checked answers with
their references as footnotes, the bibliography from the referenced-documents panel, the accepted
facts with their citations, the prompt version and model per turn. The page shows the path it was
written to and a link. Row U4.

## Words

| Say                                       | For                                   |
| ----------------------------------------- | ------------------------------------- |
| You asked                                 | the label over a question             |
| Referenced documents                      | the session bibliography              |
| Evidence this turn                        | the blocks the model was given        |
| Open at p.3; Open the original            | the viewer; the link to the file      |
| n of m sentences supported                | the score line                        |
| No claim made                             | the score line on an abstention       |
| n citations dropped                       | tags the server did not resolve       |
| interrupted                               | a cancelled turn                      |
| This pairing is marked identity-revealing | the refused side-by-side              |
| Promote to accepted fact                  | the slip that writes `accepted_facts` |
| Budget reached                            | the spend strip at the cap            |

Errors say what happened and what to do, in one sentence, in red ink, without apology.

## Adoption: the Chat Ledger chat shell

The operator asked to switch to the Chat Ledger chat (`chat/` in `chat-with-diya-gl`). The three
options, scored on the counts below.

| Criterion                            | (a) Adopt the shell: React 19, Vite, `@assistant-ui/react`, its runtime, tokens and components                                                                                                                                                                | (b) Port its patterns into the raw ESM page                                                                               | (c) Mix: raw ESM page now, the shell for the matrix and facts views later |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Coupling of `chat/src` to the domain | 45 of 70 files name books, figures, invoices or the ledger; 11 of 17 components do (the 6 that do not are the notes browser, the tool card and Explain). The runtime (`useChatRuntime.js`, 324 lines) streams Chat Ledger's SSE events, not WebSocket frames  | 0 files copied as code; 5 files read as patterns                                                                          | As (a) for the later views, so the same 45 of 70                          |
| Build step in `deploy.yml`           | Adds `vite build` before `cdk synth`; `appStack.mjs` points `Source.asset` at the build output; adds React, react-dom, Vite, `@vitejs/plugin-react`, `@assistant-ui/react`, two fontsource packages and the React ESLint plugins                              | None; the page deploys as files from `packages/ui/` with the generated `config.json`, as today                            | The build step arrives with the first shell view                          |
| Test tiers                           | Adds Chat Ledger's Playwright browser tier (`test/browser`, 9 specs) for parity; Playwright is not installed here; `test.yml` gains a browser install                                                                                                         | `test/ui/tokens.test.mjs` offline; the server tests unchanged                                                             | Both tiers                                                                |
| Licence                              | Every file brought over is `LicenseRef-Polycode-Proprietary` and needs the operator's relicensing to AGPL-3.0-only with `Copyright 2026 Polycode Limited; adapted from Chat Ledger` on the copyright line; about 25 files after pruning the domain components | The same clause on the 5 files whose shape is adapted (tokens, the colour test, the strip, the drawer, the approval slip) | Both                                                                      |
| Time to the demo                     | Rewrite of `app.js`, `auth.js` and `viewer.js` into JSX against a runtime whose transport differs, before the page is back to today; then the views. Three to four rows before F7 starts                                                                      | This row; F7 to F12 build on it                                                                                           | This row now; the shell's cost lands in F10's row                         |

**Decision: (b).** The counted reason is the coupling: two thirds of the shell is the books, and
its runtime is built for a different transport; the shell's value is its discipline (tokens, the
colour test, the strip, the drawer, the slip), and discipline ports as patterns at no build cost.
The operator asked to switch; the switch is recommended against on these counts, and the first
three files to bring over, as relicensed patterns, are the same under (a), (b) or (c):

1. `chat/src/styles/tokens.css` with the "no colour is written outside tokens.css" test from
   `test/browser/chat.spec.js` (lines 72 to 88): the shape of `packages/ui/tokens.css` and
   `test/ui/tokens.test.mjs` in this row.
2. `chat/src/components/MachineStrip.jsx` with `chat/src/lib/meter.js` and
   `src/cost/meterRoute.js`: the spend strip and its route (U3).
3. `chat/src/components/ConversationsDrawer.jsx` with `src/agents/conversation.js` and
   `scripts/lib/conversationIndex.mjs`: the conversation list, the stored-frames replay and the
   review index (U2).

Then `chat/src/components/ApprovalCard.jsx` for the promote-to-accepted-fact slip (F10) and
`src/notes/notes.js` for the export (U4). No file is copied until the operator relicenses it; the
rows list the files.

## Related documents

- `docs/SPEC_WITNESS_RESEARCH_TOOL.md`: the specification.
- `PLAN_CONCORDANCE.md`: the phases.
- `../../polycode-unpublished/chat-with-diya-gl/DESIGN_CHAT_LEDGER.md`: the record this one takes
  its shape from.
