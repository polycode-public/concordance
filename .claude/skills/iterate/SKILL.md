---
name: iterate
description: Run the delivery cycle unattended until the board has no machine-only row that can start — board, a wave of isolated sub-agent batches on one branch and one PR, watch, auto-merge, watch, board, again. A Plan–Do–Check–Act cycle in the orchestrator–workers shape. Invoke when the operator says "iterate", "run the cycle", or "keep going until the board is clear".
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# iterate

The cycle, run under `/loop` in dynamic mode:

```
/board → /do-next (one wave) → /watch → /auto-merge → /watch → /board → …
```

until `/board` shows no machine-only row in state `ready`. The parts are the existing skills; this
one fixes their order and carries the rules that keep the cycle cheap.

It is a Plan–Do–Check–Act cycle in the orchestrator–workers shape: the coordinator plans (the
board), workers do (the wave), CI checks (the watch), the merge acts, and the next board is the
next plan. Trunk-based, short-lived branches, one batch branch per wave, `main`'s deploy as the
integration proof, and a work-in-progress limit set by file ownership.

## Before the first cycle

1. **Remote control.** If nothing says the session is connected, print `/rc` once for the
   operator; it is their command. On a connected session never print it: it would disconnect.
2. **SSO.** Only when the cycle needs an AWS fact: `aws --profile polycode-sandbox sts
get-caller-identity`. If it fails, print `aws sso login --profile polycode-sandbox` once and
   carry on with the rows that need no AWS. Read every AWS fact a cycle needs while the token is
   fresh.
3. **GitHub.** `gh auth status`; if it fails, print `gh auth login` for the operator.
4. **Inbox.** `~/.claude/inboxes/concordance.md`; act on every `[unread]` block, then mark it
   `[read]`.
5. **Cool-down.** If `NEXT.md`'s `## In flight` carries the cool-down marker, run `/wake` first:
   invoking `/iterate` is the operator's word to lift it. A wake step that cannot complete keeps
   the session cool, and the loop does not start; say which step and why.
6. **Start the loop.** `/loop` with this skill's cycle as the prompt and no interval. Agent
   completions, Monitor events and background exits are the wake signals; `ScheduleWakeup` is the
   fallback heartbeat.

## One cycle

1. **Board.** `/refine` first when the session's first wave is about to go out or the board has
   gained rows since the last pass. Then `/board` with its write-back (a docs commit straight to
   `main`). The wave's input is the `ready`, `machine-only` rows, in board order.
2. **Wave.** `/do-next`'s shape: one batch branch, every agent worktree from it via
   `scripts/worktree-add.sh`, `NEXT.md` never on it; one agent per row, rows sharing a file in one
   brief; fill until file contention stops you; lowest tier that fits, and a hard row never shares
   a batch with mechanical ones. Every brief carries the constants `/do-next` lists. Land each
   report as it arrives (status check, squash merge, one commit per row, content proof). Before
   the first push, run `npm run check:all` as one background command under `bash -c` that appends
   `check:all exit $?` to its log file (note `PIPESTATUS` is empty under the background shell's
   zsh); the push is written only after the coordinator reads `exit 0`, and a log without the line
   is a failed check. Then one PR and `/watch`.
3. **Watch.** The monitor runs until the PR's workflow runs are terminal. A red is diagnosed from
   the run's own jobs and logs; the fix rides the same batch branch as another commit.
4. **Merge.** On `MERGEABLE`, `/auto-merge`: gates re-read, the merge, its verification, local
   `main` updated, then `/watch` over `main`'s runs and its `deploy.yml` run. If the merge call is
   refused by the permission classifier, `/auto-merge` prints the command in a `!` block, marks
   the PR **handed over** in its result table, retries once on the next cycle, and carries on.
5. **Close the cycle.** When `main` is green, `/board` again with its write-back, and the removal
   block for the wave's worktrees and branches in full with the `!` prefix.

## Pacing

- Check for a queued operator message before every dispatch, merge, push and poll. Mid-turn
  messages arrive alongside tool results; after each tool call, read the inbox. Any message saying
  stop, exit, cool down or asking a direct question ends the current step at once: send
  `ScheduleWakeup` `stop: true` for stop or exit, invoke `/cool-down` for cool down, or reply with
  the answer as the whole message for a question. Nothing in flight is interrupted mid-edit; tell
  any running agent to commit and stop (the `/cool-down` rule 3 shape).
- With nothing running and the next unblock at a known time, hold with hourly ticks.
- With nothing startable, stop the loop: one notification with the outcome, naming every operator
  decision that would restart it (a `machine-ask` row's approval, a `human-driven` decision), and
  stop any Monitor. The operator restarts with `/iterate`.

## Blocked commands

`git worktree remove`, `git branch -D`, deleting a remote branch, AWS writes outside the
workflow, and GitHub settings, secrets and variables are the operator's. Print each as one fenced
block with the `!` prefix when it arises, collect them in the next board, and carry on; nothing
waits on them.

## Report

Each cycle ends with one line per PR merged (number, rows, merge commit), the deployed stacks, and
what the next cycle starts with or why the loop stopped.
