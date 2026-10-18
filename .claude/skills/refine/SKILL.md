---
name: refine
description: Refine every open row on NEXT.md in the main context before a wave is dispatched — check each reference against origin/main, make each brief complete enough for its sub-agent and pick the lowest model that fits, share the facts one row's check turns up with every row they help, split the human step out of any row that mixes one with machine work, and test every declared dependency — then write the file back and render /board. Invoke when the operator asks for a readiness or feasibility pass over the board, or says "refine the board".
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# refine

Five passes over `NEXT.md`, in the main context and with no sub-agents, then the write-back and
`/board`. A sub-agent reads only its brief; every fact it would otherwise rediscover costs tokens,
and every fact it gets wrong costs a redeploy. The passes do that discovery once.

## Before the passes

```bash
git fetch -q origin && git pull -q --ff-only origin main && git log --oneline -1
```

Every check runs against that commit. Read the inbox (`~/.claude/inboxes/concordance.md`) and act
on each `[unread]` block first: a row's facts may have changed in another session.

## Pass 1: references

For every path, symbol, line number, run id, issue number, plan section and external fact a row
names:

- **Paths exist:** one loop over every backtick path, `[ -e "$f" ] || echo MISS`. A missing file
  is usually a moved one: `find . -name '<basename>' -not -path './node_modules/*'`.
- **Line numbers match:** a row names the anchor text with the line (`fuseRanks` (line 52)); this
  pass corrects the number, never the anchor.
- **Symbols exist:** `grep -n '<symbol>' <file>` for each function, constant, env var, workflow
  job, npm script and SQL table the row names. A label another row or a plan once used is not a
  reference; replace it with the command or file it stood for (`git log -S'<label>' -- NEXT.md`
  finds the text).
- **Counts are current:** a row that quotes a count (tests, files, chunks, eval scores) gets the
  count re-run and the number replaced.
- **Versions are current:** a row that pins a package or a model name gets it checked
  (`npm view <pkg> version`; `ollama list` for a local model).
- **External state is current:** stacks, workflow runs, open PRs, the sandbox account. Read-only
  AWS and `gh` reads need no approval. A blocker that has cleared moves the row up a section.
- **The deployed line** matches the live stacks (`/board` Part 3).

Write each correction into the row as you go.

## Pass 2: feasibility

For every row a sub-agent will run, read the code it points at and ask what the agent would have
to discover to finish. Put that in the brief. Checks that pay for themselves here:

- **The mechanism is the one the platform has.** A row naming a Postgres, pgvector, Ollama or AWS
  feature names the call and the version it was checked against. Unchecked, it goes to a
  research row first.
- **The test can reach what it asserts.** A unit test runs offline; a retrieval or SQL claim needs
  the Docker tier; an embedding or generation claim needs the Ollama tier; a CDK change is proven
  by `npx cdk synth --quiet` and a template assertion; a deploy is proven by `deploy.yml` after
  merge. The brief names the tier and the environment variable that turns it on.
- **The runtime the agent will find.** A fresh worktree has no `node_modules`
  (`scripts/worktree-add.sh` links the main checkout's), no running database and no pulled models.
  The brief says which of them the proof needs.
- **The data.** `corpora/*/raw`, `text`, `chunks` and `media` are gitignored. A row that reads
  them names the fixture in the repository that stands in for them.
- **A gate or threshold is set from measured runs.** An eval threshold or a retrieval cut-off
  comes from a run on the same corpus and model, read first; the brief names the run.
- **The lint and format gates.** Every brief that writes code carries `npx eslint` and
  `npx prettier --check` on its files, and `npx cdk synth --quiet` for `infra/`.
- **Shell scripts run under `/bin/bash` 3.2:** `bash -n` and `shellcheck` before commit; no
  associative arrays or `mapfile`.
- **The call site and forbidden patterns:** the exact file:line the change lands on, and the
  patterns the rules forbid that it could reach (compatibility aliases, silent fallbacks,
  whole-tree formatting, a citation produced without a source span).
- **The model:** the lowest that fits. A one-file mechanical edit is Haiku; a bounded change
  against an existing pattern is Sonnet; a design a Sonnet then builds from, or a change to
  ranking or the contradiction engine with real judgement, is Opus. A row over about 25 files is a
  two-agent chain. Change the row's **Model** when the check disagrees.
- **The brief's constants:** worktree path and branch, `cd <worktree>` in every Bash call,
  absolute paths for every file tool, the evidence (run ids, log lines, file:line), "commit before
  a long verification", "a wait is a sleep loop inside one Bash call, never a Monitor", the
  licence header for new files, no plan/row/date references in comments or test names, `git add`
  only its own files, push nothing, never call the Agent tool, and the report-back contract
  (branch, worktree, commits, files, proof lines, anything undone). A brief that touches a
  workflow carries the called-workflow checklist; a brief that dispatches one names the exact
  inputs.

## Pass 3: context

A fact one row's check turned up usually serves another row. Add it to every row it helps, in one
sentence, naming the other row:

- rows that share a file say so in both places, so the wave gives them to one agent;
- rows that touch the same module run in sequence in one agent, or the later brief carries the
  earlier row's changes;
- a row whose output another consumes names the shape it writes and the row that reads it, so the
  sequence is in the file and not in a coordinator's memory;
- a fact that removes a blocker or a sub-task rewrites the blocked row's blocker line.

## Pass 4: the human step, split out

A row that mixes a human step with machine work stalls at the human step. Split it:

- **The human row** is the smallest step a person must take (a decision between named
  alternatives, an SSO login, a licence check on a corpus, a value only they hold). It names what
  to do, where, and where the result lands. It goes to `## Human-driven` when the person must
  navigate it, `## Machine-ask` when a session drives it with the person present. Label it
  `O<n>`.
- **The machine row** keeps everything a session can build or verify without that step, and its
  blocker line names only the human row.
- A row whose every step is human stays whole. A row whose only human step is merging its PR is
  machine-only already.

## Pass 5: dependencies

- **Live or stale.** A blocker is live while its row is open or its event has no record yet;
  stale otherwise. Remove stale blockers; a row left with none moves to its class's section.
- **Cycles.** Two rows naming each other cannot both be first; split the part each needs.
- **Splittable.** A row blocked for one step can often do the rest now (the code before its live
  proof); split it into a ready row and a blocked row.
- **Missing links.** A blocker naming a row nobody wrote is a gap: write the row or rewrite the
  blocker.
- **Where a plan keeps the graph,** update it in the same commit so the plan and the board agree.

Record each change in the commit message: the stale blockers removed, the cycles broken, the
splits made.

## Write-back

`NEXT.md` in board order (in flight, machine-only, machine-ask, human-driven, blocked; within a
section by size, fewest files first), the deployed line current. Edit each row with the Edit tool
on its own paragraph (from `- [ ] **` to the blank line), never by line-number spans. Count the
rows before and after with `grep -c '^- \[ \] \*\*' NEXT.md` and verify they match. Run
`npx prettier --write NEXT.md`, `npx prettier --check NEXT.md` and
`npx vitest run test/repo/nextShape.test.mjs`. Commit the `NEXT.md`-only change to `main` (docs
exception) only when all checks pass, with a message that carries the corrections, splits and
removed blockers. Push it as its own command. Then `/board`, whose render proves the file and the
table agree.
