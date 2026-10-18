---
name: do-next
description: Work NEXT.md top to bottom as waves of concurrent worktree sub-agents, land them on one batch branch, push in batches, raise one PR, and hand over to /watch. Invoke when the operator says "do next", "work the board", "clear NEXT.md", or when a landed batch leaves rows still open.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# do-next: work `NEXT.md` with the coordinator model

You are the coordinator. You plan, dispatch, merge, push and answer the operator. You do not write
the code. Keep the main chat free: anything long-running goes to a sub-agent or a background task.

Work `NEXT.md` top to bottom, taking the unblocked rows. As a blocker clears, promote the row and
resequence the board. Keep going until the board has nothing a machine can start, or the operator
stops you. A green suite, a landed wave and a tidy summary are the middle of the work.

The master plan is `PLAN_CONCORDANCE.md`; the others are the root's `PLAN_*.md`
(`PLAN_LAPTOP_STACK.md`, `PLAN_AWS_SANDBOX.md`). `NEXT.md`'s shape rules are in `CLAUDE.md` and
`test/repo/nextShape.test.mjs`.

## If cool-down is on, wake first

When `NEXT.md` carries the cool-down marker, run `/wake` first and in full: invoking this skill is
the operator's word to lift it. Waking ends with a board render, so that render is this skill's
`/board` step. If a wake step cannot complete, say which and stay cool.

## Start with `/board`

Invoke `/board` before dispatching anything. It reads `NEXT.md` fresh, orders the rows, reports
the stacks, runs and branches, and writes the sequenced board back, so the order you work is the
order on disk.

## Check the inbox

`~/.claude/inboxes/concordance.md`, if you have not in the last five minutes, at two moments:
while waiting on a run, and when a sub-agent reports back, before you merge its work. Act on
every `[unread]` block, then mark it `[read]`.

## The shape of a batch

**One branch. One PR. Waves inside it.**

The batch branch is `claude/<codename>-<theme>`, taken from `main`. Every sub-agent worktree
branches from the batch branch, so each wave builds on what the last landed. A worktree for an
analysis or review agent branches from `origin/main` after a fetch; the brief names that commit.
Give the batch branch its own worktree (`.claude/worktrees/<codename>`) and leave the primary
checkout on `main`: you merge into the batch worktree and edit `NEXT.md` on `main`.

### Naming the batch

`CODENAMES.txt` holds 26 lines, one per letter, nine names each. The code name comes from the line
after the last batch's letter (wrapping `z` to `a`), picked at random within the line. The theme is
one or two words for the area most rows touch (`ingest`, `retrieval`, `facts`, `ui`, `cdk`,
`docs`, `evals`). Example: `claude/arclight-retrieval`, then `claude/basalt-facts`.

```bash
used=$(git for-each-ref --sort=-committerdate --format='%(refname:short) %(subject)' refs/heads refs/remotes/origin \
  | cat - <(git log origin/main --merges --format=%s -n 400) \
  | grep -oE 'claude/[a-z]+-' | sed -e 's#claude/##' -e 's/-$//')
last=$(printf '%s\n' "$used" | awk 'NR==FNR{for(i=1;i<=NF;i++) n[$i]=1; next} ($1 in n){print; exit}' CODENAMES.txt -)
letter=$(printf '%s' "${last:-z}" | cut -c1)
line=$(( ( $(printf '%d' "'$letter") - 96 ) % 26 + 1 ))
set -- $(sed -n "${line}p" CODENAMES.txt)
shift $(( RANDOM % $# ))
echo "$1"
```

No match for the last batch means none has run yet: start at the `a` line.

**`NEXT.md` never travels on the batch branch.** The board is maintained on `main` under the docs
exception. If a merge drags it on, restore it to the branch point in the same commit.

## Waves

A wave is a set of concurrent workstreams, sized so no two agents own the same file. Fill it until
file contention stops you, not until a count does.

1. **Sequence the board.** Take the unblocked rows in board order and group them by where they
   live: `infra/**`, `packages/**` with their tests, `db/**`, `evals/**`, `corpora/**`,
   `.github/workflows/**` and `scripts/**`, `.claude/skills/**`, and the root documents.
2. **Rows that share a file are one workstream: one agent, one brief,** "do A, then B, a commit
   per row", in the order the plan fixes. If the total is more than one agent can finish, it
   commits what is done and reports where it stopped. A four-line change on a contended file rides
   along as its own commit, named as unrelated. Extend a running agent with `SendMessage` rather
   than dispatching a second one onto the same files.
3. **Run a design wave when the plan is not rich enough to execute.** A higher tier writes the
   design into the plan; cheaper models build from it. The test is whether a Sonnet or Haiku agent
   could build from the document without asking a question. Never put a design task and a
   mechanical sweep in one wave.
4. **Pick each workstream's tier deliberately**, the lowest that fits: Fable, Opus, Sonnet, Haiku.
   Opus for a decision with architectural weight, Sonnet for a bounded change against an existing
   pattern, Haiku for renames, sweeps and one-file edits.

## Briefing a sub-agent

A fresh agent carries none of your context, so the brief stands alone. Every brief says:

- **Its worktree path and branch**, and that it works only there. It may `git add` its own files
  and commit; never `stash`, `reset`, `checkout --` or `clean`; never push, open a PR or edit
  `NEXT.md`.
- **It must not call the Agent tool or fork.** Only the coordinator fans out. A brief whose work
  needs splitting is split by the coordinator before dispatch.
- **Every Bash call starts with `cd <worktree>`**, and every Read, Edit and Write path is absolute
  under the worktree; a repository-relative path resolves against the primary checkout.
- **Worktrees come from `scripts/worktree-add.sh <path> <branch> <base>`**, which links
  `node_modules` and fails when it cannot.
- **A wait is a `sleep` loop inside one Bash call**, never a Monitor: an agent that hands its wait
  to a Monitor ends its turn and never resumes. A background command that expands a list runs under
  `bash -c`.
- **What it owns and what it must not touch**, with the reason; name a nearby agent in the wave.
- **The licence header on every new comment-capable file:** `SPDX-License-Identifier:
AGPL-3.0-only` and `Copyright 2026 Polycode Limited`, before the first commit.
  `test/repo/licenceHeaders.test.mjs` fails the suite without it.
- **Tiers that need a service:** the Docker (Postgres and pgvector) and Ollama tiers are opt-in by
  environment variable. A proof that needs one names the variable, the model and the expected
  number of calls. The default proof runs offline.
- **A brief that touches a workflow** carries three facts: a called workflow inherits its caller's
  `github.event_name`; it may request no permission its callers do not grant; `gh` in a job with no
  checkout needs `--repo`. Grep the sibling workflows for the same defect before committing.
- **The evidence, not just the task:** run ids, log lines, file:line.
- **Commit before a long verification.** A long command is promoted to the background, which
  ends the agent's turn; told to verify first, it stops with work uncommitted. Write, commit, then
  verify, and add a fixing commit if needed. Fast checks (vitest on one file, eslint, prettier)
  run before the commit as normal.
- **Blast-radius testing only:** the tests its change reaches (`npx vitest run <files>`),
  `npx eslint` and `npx prettier --check` on its files, `npx cdk synth --quiet` for `infra/`. The
  full `npm run check:all` is the coordinator's, once per batch.
- **A report-back contract:** what it changed and why, what it did not do, any adjacent bug with
  file and line, the commands run with counts, and its commit SHAs.
- **What would change your mind.** For a design or a judgement call, ask for the rejected options
  and the reasons.

## Landing a wave

Merge each workstream as its notification arrives.

- **A sub-agent's "done" is not proof.** `git status --short` in its worktree first.
- `git merge --squash <agent-branch>` into the batch worktree, then one commit naming the row,
  keeping the agent's explanation of why. Fixing commits fold into the row they fix.
- Run that change's blast radius on the merged tree.
- Update `NEXT.md` on `main` in the same breath: delete the row once its checks pass, or leave its
  remainder. A bug the agent surfaced is that row's remainder unless it is separate work; say so.
- Prove the content landed (`git diff <agent-branch> <batch> -- $(git diff --name-only
<batch>...<agent-branch>)` empty), then print the removal for the operator:
  `! git worktree remove --force --force <path>; git branch -D <agent-branch>`. Join several
  with `;`. `/board` lists each again until it is gone. Nothing waits on it.

**Editing `NEXT.md` is where rows get lost.** Split on the row boundary, filter by label, rejoin;
count the rows (`grep -c '^- \[ \] \*\*' NEXT.md`) before and after.

## Pushing

**Push once per wave.** Before the first push of a batch, run `npm run check:all` as one background
command under `bash -c` that appends `check:all exit $?` to its log file (note `PIPESTATUS` is
empty under the background shell's zsh). The push command is written only after the coordinator
reads `exit 0`; a log without the line is a failed check. Only `main` deploys, so a branch push
never races a deploy.

Raise the PR as soon as the branch is pushed, so its runs and its description grow together:

```bash
gh pr create --base main --head <batch> --title "<codename>: <rows>" \
  --body "<what each row turned out to be>"
```

**Then invoke `/watch`.**

## When something goes red

Gather the whole run's failures before fixing anything: one run's worth, diagnosed together, fixed
together, pushed once. Read the failing job's log, not the summary:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | "\(.databaseId) \(.name)"'
gh api repos/polycode-public/concordance/actions/jobs/<job-id>/logs --allow-escape-sequences \
  | tee /tmp/job.log | grep -iE "error|fail" | tail -20
```

Name the layer you fixed, not the symptom. Check what changed underneath you (a registry, an
upstream package, an AWS limit). Workflow fixes ride on the next batch.

## Merging

The batch merges to `main` with `--merge`, never squashed, through `/auto-merge` only. Compare
the PR's head with the branch tip first: anything pushed after the head was last updated is left
behind otherwise. Anything orphaned goes into the next batch with its own branch and PR.

## What not to do

- Do not let a sub-agent push, merge, open a PR or edit `NEXT.md`.
- Do not give a workstream its own PR when it could ride the batch.
- Do not report a run's state from memory or from `gh pr checks`. Open the run.
- Do not stop at a green suite or a landed wave to ask whether to continue.
