<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# CLAUDE.md: concordance

A witness research tool over public inquiry witness statements: hybrid retrieval, a citation on
every sentence, a checking layer that colours what the evidence supports, and a fact store that
finds where witnesses agree and contradict. The demo corpus is the Grenfell Tower Inquiry. The
specification is `docs/SPEC_WITNESS_RESEARCH_TOOL.md`; the plan of record is `PLAN_CONCORDANCE.md`;
open work is `NEXT.md`.

**The build here is the laptop path.** Postgres 16 with pgvector in Docker, Ollama for models,
Node 24 behind a small HTTP and WebSocket server, a raw ESM page. AWS stays behind the provider
interface: a thin sandbox stack deploys from `main` so the pipeline is proven, and the full port is
a later phase (`PLAN_AWS_SANDBOX.md`).

## Start of every session, and after every compaction

1. Read `NEXT.md`, then the `PLAN_*.md` its rows name.
2. Run `TaskList` for tracked tasks.
3. Read your inbox, `~/.claude/inboxes/concordance.md` (protocol: `~/.claude/inboxes/README.md`).
4. Do not start new work before these.

When the operator gives a new requirement, add it to the plan it belongs to (verbatim under
"Operator assertions" when it is one) or to a new `PLAN_<DESCRIPTION>.md` at the repository root,
and track it as a task.

## This repository

| What           | Where                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Runtime        | Node >= 24, ES modules (`"type": "module"`), plain JS (`.mjs`), no TypeScript, no framework                |
| Core           | `packages/core/` (providers, ingest, chunking, retrieval, checks, facts, protocol); provider-neutral       |
| Laptop server  | `packages/local/server.mjs` (HTTP + WebSocket; `npm run dev`)                                              |
| Page           | `packages/ui/` (raw ESM, CSS custom properties)                                                            |
| Database       | `docker-compose.yml` (pgvector/pgvector:pg16), `db/migrations/*.sql`, `npm run db:migrate`                 |
| Models         | Ollama; `scripts/models-pull.sh`; names in `.env` (`EMBED_MODEL`, `CHAT_MODEL`, `EXTRACT_MODEL`)           |
| Evals          | `evals/run.mjs`, gold sets under `evals/<corpus>/gold.jsonl`; `npm run eval -- --provider=laptop\|bedrock` |
| Corpora        | `corpora/<name>/` (fetch code and `manifest.jsonl` committed; `raw/ text/ chunks/ media/` gitignored)      |
| Infrastructure | CDK in JS: `cdk.json`, `infra/bin/app.mjs`, `infra/lib/*.mjs`; account record `AWS_ACCOUNT.md`             |
| Pipeline       | `.github/workflows/test.yml` (every branch), `deploy.yml` (`main`, sandbox); agent workflows dispatch-only |
| Factory        | `.claude/skills/` (`/board`, `/refine`, `/do-next`, `/watch`, `/auto-merge`, `/iterate`, …)                |
| Capabilities   | `REPORT_CAPABILITIES.md` (the `capabilities` skill creates and maintains it)                               |

### Commands

```bash
npm ci                 # from the lockfile
npm test               # vitest, offline tier (no Docker, no Ollama)
npm run check:all      # test:unit, check:format, check:lint, check:synth
npm run db:up          # Postgres 16 + pgvector on :5432
npm run db:migrate     # apply db/migrations in order
npm run models:pull    # ollama pull the laptop models
npm run dev            # the local server on :8787
npm run eval -- --provider=laptop
CONCORDANCE_DB_TESTS=1 npm test       # adds the Postgres tier
CONCORDANCE_OLLAMA_TESTS=1 npm test   # adds the Ollama tier
```

### Product rules (from the specification; they bind every row)

- **Evidence is never altered.** Originals are stored byte-exact with their SHA-256, source URL,
  fetch time and licence. Derived text carries a provenance row back to the original.
- **Every claim links to a locator.** The model cites chunk ids (`[E3]`); the server resolves them
  to page, paragraph, page:line or timecode. The model never writes a citation string itself.
  Locators are stored at ingest, never derived at query time.
- **Every automated judgment is reversible by a person.** Support colours, contradiction labels and
  accepted facts are shown with their evidence and can be overridden; the log records who promoted
  each accepted fact.
- **Closed world.** The answer comes only from the evidence blocks; "the corpus does not say" when
  they do not cover the question; no prior knowledge about the real event. Temperature 0, a fixed
  prompt version stored with every response.
- **Cipher-only witnesses have no real identity anywhere in the system**, and the page refuses to
  show two documents side by side when that pairing is marked identity-revealing.
- **A witness assertion is never a fact.** Facts are the curated `accepted_facts` rows, each with a
  source citation; session hypotheses are marked as such.
- **Respect for the test data.** Grenfell statements are public records about real deaths. Name the
  inquiry on screen; never synthesise what a witness "really meant"; no real ICC evidence touches
  the system.
- **The contradiction engine is the product; chat is the on-ramp.**

### Laptop first (hard rule)

The local provider is the one prompts are tuned on. A feature is complete when it runs with
`MODEL_PROVIDER=laptop` and its eval passes there. The Bedrock provider implements the same
interface later; nothing in `packages/core/` imports an AWS SDK. This dev machine is a 64 GB Intel
i9 (CPU inference), so the defaults are 7B-class models; sizes for the demo machine are in
`PLAN_LAPTOP_STACK.md`.

### Licence headers

Every new comment-capable file starts with:

```js
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
```

(`<!-- … -->` in Markdown and HTML, `#` in shell, YAML and TOML, `--` in SQL, `/* … */` in CSS.)
`test/repo/licenceHeaders.test.mjs` enforces it. Files adapted from DIY Accounting Limited's
factory keep a provenance clause on the copyright line.

## An approved plan is the authorisation

If the operator approved a plan, or the prompt says "complete X", work it to the end without asking
permission to continue. A green suite, a landed phase, a clean commit and a tidy summary are
checkpoints, not decision points. Only three things stop the work: a hard safety rule, a blocker
with no next action left anywhere in the plan, or the operator saying stop. Ask only what the plan
does not decide, and ask it before the work.

**Write status as you go.** When a phase closes, mark it in the plan and delete its row from
`NEXT.md` in the same commit as the fix. Sub-agents get the same instruction and the right to edit
their own rows.

**Never stop or defer because of the time of day or how long the session has run.**

## NEXT.md holds open work only

It never records what is done, what was decided against, or how something was fixed. When a task
closes, delete its row in the same commit; when part closes, delete that part. Completed work lives
in `git log` and the pull requests. Its shape (five sections, then Discipline; every row ends with
**Size** and **Model**) is checked by `test/repo/nextShape.test.mjs`.

## Working model: coordinator and background sub-agents

The main session is the coordinator: it plans, dispatches, merges and answers the operator. Big
work runs in concurrent background sub-agents.

- Split work by file ownership; serialise on shared files.
- Pick the lowest model tier that fits (Fable, Opus, Sonnet, Haiku). Design with architectural
  weight earns Opus; a bounded change against an existing pattern earns Sonnet; mechanical sweeps
  earn Haiku. Group tasks of a similar level into one workstream.
- **The main chat stays free for the operator.** Anything that runs longer than a few seconds or
  takes more than two or three tool calls (ingest runs, model pulls, evals, deploys, log reads, a
  diagnosis) goes to a background Bash command or a sub-agent; the coordinator does short reads,
  file edits, dispatches, merges and answers in the foreground.
- A sub-agent sharing a tree may only `git add` its own files and commit, never `stash`, `reset`,
  `checkout --` or `clean`. It never pushes, opens a pull request, edits `NEXT.md` or calls the
  Agent tool.
- A sub-agent's "done" is not proof: check for a live process, then its worktree's `git status
--short` and `git log`, before accepting or resuming it. Never resume a round whose worktree is
  gone; dispatch a fresh one.
- Create worktrees with `scripts/worktree-add.sh <path> <branch> <base>` (links `node_modules`).
  Worktree and branch removal is the operator's: print the one command with the `!` prefix when it
  stops being needed, and in every `/board` render until it is gone. Nothing waits on it.
- Merge each verified sub-agent result as it arrives; do not hold everything for one sweep.
- Refer to sub-agents by a short label from their task ("the ingest agent"), never by raw id.

The skills under `.claude/skills/` carry the cycle: `/board`, `/refine`, `/do-next`, `/watch`,
`/auto-merge`, `/compact-ready`, and `/iterate` to run them unattended; `/cool-down` settles a
batch that stacks problems faster than it lands them, and `/wake` lifts it on the operator's word;
`/clean` removes merged worktrees, branches and build output; `/capabilities` keeps the index.

## Test the blast radius, not the whole suite

Mid-task, run what your change can reach: the file you edited, what imports it, and what the
change's reason names. The full set (`npm run check:all`, plus the Postgres and Ollama tiers when
the ingest or query path changed) runs once, when the change becomes someone else's problem: a
push, a pull request. A radius you cannot see is a reason to run everything; say so.

**Model calls cost time, not money, on the laptop; they still cost minutes.** A test that calls
Ollama is in the opt-in tier and names the model and the number of calls in its brief. An eval run
is a background command.

## Tee before you filter

Never pipe into `tail`, `head` or `grep` without teeing first:

```bash
cmd 2>&1 | tee /tmp/some-file.log | tail -20
```

Vitest switches reporter when its output is not a TTY, so a quiet log mid-run says nothing about
progress; check the process table. A background Bash call runs under zsh, which does not split an
unquoted `$VAR`; use `bash -c` or quoted arrays for lists.

## Concurrent sessions

Other Claude sessions may work on this machine. Files can change under you: re-read before editing
if time has passed. Commit only your own changes; never `reset --hard`, `clean` or `stash` a tree
you did not dirty.

**Inboxes.** This repository's handle is `concordance`. Send only two kinds of message, both about
a change in the recipient's repository: a change you need them to make, or a change you have made
that they are blocked on. Never status, progress, ideas or acknowledgements. Format and cadence:
`~/.claude/inboxes/README.md`.

## Git and GitHub

The repository is `github.com/polycode-public/concordance`. Use `gh` for pull requests, runs,
logs and repository variables. Never trigger a workflow without the operator's instruction, except
as `/do-next` and `/watch` say.

- **You may:** create branches, commit, push branches, open pull requests, and push docs-only
  commits (`.md` files only) straight to `main`. The PreToolUse hook
  `.claude/hooks/guard-main-push.sh` blocks any other push to `main`; a push to `main` is a
  standalone command, never chained.
- **A feature is built on a `claude/*` branch and reaches `main` through a pull request** whose
  `test.yml` run is green. `main`'s `deploy.yml` run is the integration proof once the sandbox
  role exists.
- **You may not:** delete branches, rewrite pushed history, force-push.
- **Merging** happens only through `/auto-merge`, which merges nothing that has not passed its
  gates (no unresolved review thread, no uncommitted work in the branch's worktree, the branch not
  ahead of origin, the pull request's head equal to the branch tip, the head's latest `test.yml`
  run green). A bare `gh pr merge` outside that skill is forbidden.
- **Merge strategy:** sub-agent branches land on the batch branch squashed, one commit per row;
  the batch merges to `main` with `--merge`, never squashed.
- **Branch names:** `claude/<ns>-<n>-<topic>` or `claude/<ns>-<topic>` (`ns` such as `ingest`,
  `retrieval`, `facts`, `ui`, `cdk`, `evals`, `docs`); a board batch is `claude/<codename>-<theme>`,
  the code name taken from `CODENAMES.txt` as `/do-next` says.

**Commit trailers**, in this order:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Model: <the exact model id of the session, e.g. claude-fable-5-1>
Claude-Session: <the session url>
```

## AWS

One account, polycode-sandbox (`687443513271`), workloads in eu-west-2 (`AWS_ACCOUNT.md`).
Profile `polycode-sandbox`; log in with `aws sso login --profile polycode-sandbox`.

- **Read-only AWS calls are always permitted** (describe, get, list, logs).
- **Always ask before writing to AWS.** Present the command, say what it does, wait for "yes".
  The path for infrastructure is CDK code, a pull request, `deploy.yml` on `main`.
- The project's cloud ceiling is the specification's $25 ingest cap; the sandbox stack carries a
  $25 monthly budget on the `project=concordance` tag. Nothing deployed may cost money at idle.
- When the operator says "confirm each command": present it, stop, wait for approval, run that
  one command, present the next.

## Code quality

- Trace the code path before running tests.
- No reformatting of lines you are not changing; no import reordering.
- No fallback paths for silent failures: throw, do not skip. A bad PDF fails its own document and
  never the batch (that is a queue, not a fallback).
- No compatibility aliases or legacy shims; rename everywhere.
- Name it, do not comment it. Comments explain a non-obvious why only, and never reference a plan,
  a row label, a commit, a date or an operator directive; nor do test names.
- Stacks are cleanly destroyable (`RemovalPolicy.DESTROY`); data protection comes from the
  originals bucket's versioning and the laptop copy, not from refusing to delete.
- Never commit secrets, corpus files under `raw/ text/ chunks/ media/`, or model weights.

## Cheapest option first

Before proposing any integration or mechanism, list the ways to do it as a table ordered by cost
and visibility, cheapest and most visible first, and recommend from that table. The first row is
always "Postgres already does it" or "the browser does it": a `tsvector`, a view, a PDF.js call. A
new service, a second store or a paid API is proposed only when the table shows the free row
cannot do the job. When the operator questions a recorded decision, re-derive it from the goal
before defending it.

## Don't narrow scope on your own

A second bug found while fixing the first is folded into the current fix by default. Only
genuinely separate, large work becomes its own row, and you say so explicitly.

## No performative diligence

Report only what could change the operator's next action. No recited empty status, no flagged
"judgement call" that was already forced, no caveat whose only job is to look careful. Flag a
decision only when real alternatives existed; then state them. Plan and NEXT sentences serve open
items only.

## Default to contraction

When asked to make a document shorter or forward-looking, delete or compress to one line; do not
explain and caveat. Ask "does this belong here at all" before "is this worded right".

## Never document capability walls

In live docs, never write that something is permanently impossible or out of scope forever. Name
today's absence as a horizon, or say nothing. Decisions (voice is out of the first demo) and safety
invariants (no real identity for a ciphered witness) are stated as decisions.

## Writing style

Facts, observations and theories. Fewest words. Flat and mechanical. Short sentences, active voice,
everyday words. Tables and lists over prose. A correction is one sentence. The `plain-prose` skill
holds the full rules.

### Answer shape

Open with the answer in one line (the count, the state, the blocker), then a flat list of what
follows. No preamble, no summary after the list. Operator steps are numbered, one action each,
with the URL or command verbatim, and ownership stated once at the top ("Steps 1–3 are yours; 4–6
are Claude Code's"). A direct question gets its answer as the whole reply; resume work next turn.
Commands the operator must run (denied, blocked or theirs) go in a fenced block with the `!`
prefix, never as prose only.

### Stance prose: cut it

Each pattern below performs a stance instead of stating a fact. The test is functional: delete the
part; if the reader lost nothing they could act on, it was stance. Cut it and any synonym that
would replace it.

| Name                           | Shape                                                              | Fix                                |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------- |
| Sincerity markers              | genuinely, truly, actually, really, honestly, to be clear, in fact | State it                           |
| Negative parallelism           | not X but Y; not just X, it's Y; X rather than Y                   | Say Y                              |
| Significance signposting       | the key insight is; which is the point; -ing tails                 | Fact, then "because <cause>"       |
| Work narration                 | I found, I confirmed, I'll now, let me look at                     | Give the result                    |
| Sycophantic opener             | great question, good catch, absolutely                             | Answer                             |
| Service closer                 | let me know if, would you like me to, happy to                     | Stop at the last fact              |
| Hedging                        | it's possible that, generally, tends to, arguably                  | Commit, with the evidence          |
| Rule of three                  | three parallel items by reflex                                     | The true count                     |
| Punctuation as glue            | em-dashes joining clauses; the colon reveal                        | A full stop, a comma, or "because" |
| Restatement                    | a closing summary; "in short"                                      | End on the last fact               |
| Filler                         | at its core; fundamentally; this changes things                    | Delete                             |
| Comparative negatives on scope | "no need to X" when no one proposed X                              | State what to do                   |
