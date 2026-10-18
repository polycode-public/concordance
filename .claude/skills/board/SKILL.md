---
name: board
description: Render the open-work board — one table for every NEXT.md row in board order, then every PLAN_*.md in one of three sub-parts (open tasks not yet on the board, every open task boarded, nothing open: an archive candidate), the deployed stacks in polycode-sandbox, the workflow runs on main and every open PR, and a branch audit — then write the sequenced board back to NEXT.md. Ends with /compact-ready. Invoke when the operator asks for the board, the open items, or "what's in flight".
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# board

Render the current open-work board from `NEXT.md` and the `PLAN_*.md` documents at the repository
root. Read every file fresh every time; never render from memory of an earlier turn. `NEXT.md`
alone sets the order: there is no backlog file. The plans are the board's intake.

## Output shape

A mode line, then exactly five parts, in this order.

**The mode line.** Two facts, one sentence each, or one sentence for both when both are quiet.

- **Cool-down.** `/cool-down` writes its marker as the first paragraph of `NEXT.md`'s
  `## In flight` section and `/wake` deletes it: `grep -n "^\*\*COOL-DOWN is on since" NEXT.md`.
  If it is there, say so and quote its timestamp: under cool-down nothing on the board is
  dispatched, and a render that does not mention it invites the wrong next move. If it is not,
  say nothing about it.
- **Monitors.** Whether a `/watch` monitor or a background run poll is running in this session
  and over what scope (`pgrep -fl 'watch-ci.sh'`, plus this session's background Bash commands by
  label), or that none is. A red below reads differently when something is already watching it.

**Part 1: a table** of every open row in `NEXT.md`:

| # | Item | Plan | State | Where | Needs | Size | Model | Status |

Rows run in board order: in-flight rows first, then machine-only, then machine-ask, then
human-driven, then blocked. Within a group, a row that other rows wait on comes first, the most
rows unblocked (counted through the chain) ahead of fewer; then a failed run on `main` or a
deployed degradation ahead of every other row; then by `Size`, fewest files first; equal sizes
keep `NEXT.md`'s order. In the blocked group, the row whose blockers are closest to clearing comes
first. Never group rows by plan.

**Check the declared blockers before ordering.** For each row a "Blocked on" names: is it still
on `NEXT.md`? A blocker whose row has closed, whose PR merged, or whose date passed is stale;
remove it, and a row left with no live blocker moves to its class's section. An outside event (a
reply, an email, a quota change) stays live until something on the board or in the repository
records it. List the stale blockers you removed after the table, one line each, and write the
corrected blocker lines back with the rest of the write-back.

- `#`: the row's label (`P1`, `V1a`).
- `Item`: a short name.
- `Plan`: the `PLAN_*.md` that names the row's label (grep the label in every plan; the row's own
  text may name it), by the part after `PLAN_` (`CONCORDANCE`, `LAPTOP_STACK`, `AWS_SANDBOX`);
  `—` when no plan carries it.
- `State`: one word: `in-flight` (a worktree with its branch, an open PR, or a running workflow
  run, checked this render), `ready`, or `blocked`. A row whose change is on `main` and waits only
  for a passive event is `ready` with that remainder. A branch absent from `git ls-remote --heads
origin`, or whose PR `gh pr list --state all --head <branch>` reports `MERGED`, is merged: the
  row is not in flight whatever its prose says.
- `Where`: for an in-flight row, the branch, the PR and any running run, in that order
  (`claude/arclight-ingest, PR #4, run 123456789`), read from `git worktree list`, `gh pr list`
  and `gh run list`; otherwise `—`.
- `Needs`: `machine-only`, `machine-ask` (a session drives it with a human present to
  authenticate or approve: an SSO login, an AWS write, a GitHub setting) or `human-driven` (a
  person must do it: a decision between named alternatives, a contract, a signature). Judge from
  the work, not from who owns it now.
- `Size`: `~n files` from the row; `—` when unestimated.
- `Model`: `Fable`, `Opus`, `Sonnet`, `Haiku`, the lowest that fits; `operator` for a human row.
- `Status`: one clause, 12 words or fewer. A `machine-ask` row names the ask; when the ask is a
  command, print it in full in a fenced block with the `!` prefix.

**Part 2: the plans.** Every `PLAN_*.md` at the repository root appears in exactly one of three
sub-parts, so a missing plan reads as a plan that was not looked at.

**Part 2a: one list per plan with open tasks not on the board**, each headed `**PLAN_<NAME>.md**`,
holding only the plan's tasks that are **open and not on `NEXT.md`**. A task is anything the plan
offers as work with a label or a phase name: a phase in its phases table, a `- [ ] **<label>.`
row, a row held off the board. A task is open when the plan's own text does not record it as
landed (a merge commit, a PR, "on `main`", "shipped in"); it is on the board when its label, or a
`NEXT.md` row that names it, appears in `NEXT.md` (grep both, never recall).

Within a list, one task per line, in the plan's own order: the task's label or phase name, a
short name, then a bracketed status of two fields:

```
**PLAN_LAPTOP_STACK.md**
- LS3 Ollama embed batch size [ready, —]
- LS7 pgvector index tuning [blocked, LS3]
```

- Field 1, the state, exactly one of `ready` or `blocked`, by the same tests Part 1 uses (nothing
  in flight belongs here: in-flight work has a board row).
- Field 2, the blocker: the label, date, event or operator's word the plan names, `—` when ready.

These lists are the board's intake: a `ready` task here is what `/refine` pulls onto `NEXT.md`
next, and under cool-down nothing is pulled. Pulling is not part of a render; a render reads the
plans and never edits them.

**Part 2b: one line per plan whose every open task is on the board**, in the shape
`PLAN_<NAME>.md: <the open tasks>, as rows <labels>`, so the reader sees the plan is still live
and where its work sits.

**Part 2c: one line per plan whose every task is closed, or that carries no task** (a design, a
record of decisions, a plan whose phases have all landed): `PLAN_<NAME>.md: <why>`, each a
candidate for the archive. Say which it is; the operator decides what moves. A render never moves
or edits a plan.

**Part 3: deployments.** Read-only, needs `aws sso login --profile polycode-sandbox`; otherwise
"unverified: no SSO session".

```bash
aws --profile polycode-sandbox --region eu-west-2 cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName,'concordance-')].[StackName,StackStatus,LastUpdatedTime]" \
  --output text
```

| Stack | Status | Last updated (UTC) | Follow-up |

A stack in a failed or rollback state is a follow-up: say what. Keep `NEXT.md`'s "Deployed" line
and `AWS_ACCOUNT.md` matching.

**Part 4: workflow runs.** The newest `test.yml` and `deploy.yml` runs on `main` and on each open
PR's branch:

```bash
gh pr list --state open --json number,headRefName,isDraft,mergeStateStatus \
  --jq '.[] | "\(.number) \(.headRefName) \(.isDraft) \(.mergeStateStatus)"'
gh run list --branch <branch> --limit 5 --json databaseId,workflowName,status,conclusion,headSha,url \
  --jq '.[] | "\(.databaseId) \(.workflowName) \(.status) \(.conclusion) \(.headSha[0:8]) \(.url)"'
```

| Branch | PR | Run | Status | Head | Action |

A failed run on `main` is the top machine-only row on the board until it is green.

**Part 5: branch audit.** `git fetch --prune origin`, then for every local branch and every
`origin/*` branch except `main`: commits ahead of `main`; whether its tip is an ancestor of the
current batch branch; and for branches with commits nowhere else, whether their content is already
on `main` (`git diff main <ref> -- $(git diff --name-only main...<ref>)` empty means it is).

| Branch | Where | Ahead of main | Last commit | Class | Action |

- `open`: content not on `main`, carried by an open PR or the batch branch.
- `unique, desirable`: content not on `main` and on no PR, belonging to an open row: needs a PR or
  folding into the batch.
- `stale`: every commit on `main`, or content identical to `main`. Removal is the operator's.

Summarise `worktree-agent-*` branches as one line. Never delete anything from this skill. After the
table print one fenced `!` block removing every stale worktree and local branch, joined with `;`,
and repeat it in every render until it is empty:

```
! git worktree remove --force --force <path1>; git branch -D <branch1>
```

## Rules

- Open work only. Nothing done, decided against, or removed.
- Never annotate a row "deferred" or "later"; status words describe state.
- No commentary beyond the parts, unless something this session changed a row since the file was
  last written: then one sentence per row, after the table.
- **Keep `NEXT.md` in board order.** Its rows sit under `## In flight`, `## Machine-only`,
  `## Machine-ask`, `## Human-driven`, `## Blocked`, then `## Discipline`. The heading is the
  classification. Move any row whose class, state or position no longer matches (a row whose
  branch merged leaves `## In flight` for its class's section with its remainder, or leaves the
  file; a row whose ask is answered moves up to `## Machine-only`; a row that gained a blocker
  moves down to `## Blocked`).
- **Write the statuses and the sequencing back.** After rendering, update every row whose entry no
  longer matches what you printed, and move rows so the file holds the order the table printed.
  Edit each row with the Edit tool on its own paragraph (from `- [ ] **` to the blank line;
  prettier wraps it, so an edit matches the whole paragraph), never by line-number spans. Count
  the rows before and after with `grep -c '^- \[ \] \*\*' NEXT.md` and verify they match the
  change. Run `npx prettier --write NEXT.md`, `npx prettier --check NEXT.md` and `npx vitest run
test/repo/nextShape.test.mjs`. Commit the `NEXT.md`-only change to `main` (docs exception) only
  when all checks pass, and push it as its own command. Never add rendered status for a task that
  is not on `NEXT.md`; the plans are read, never edited, by a render.
- **Show every operator command in full**, in a fenced block with the `!` prefix.

## Then `/compact-ready`

Every render ends with `/compact-ready`, after the write-back is pushed. The file and the table
agree, so the next thing to settle is whether the session's work in flight is in a state a
compaction keeps. `not yet` is only for an agent mid-edit with no commit or a merge between its
gates and its verification; a PR in CI, a running deploy and a pending ask are `yes`, named in the
summary. Its output is the last thing in the reply.
