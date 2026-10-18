---
name: watch
description: Arm a background Monitor over this repository's GitHub Actions runs (main plus every open PR's branch), then act on what it reports until the whole scope is green. Invoke when the operator says "watch the builds", "keep it green", or hands over a branch to get through CI.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# watch

A brief for one background monitor. Arm it, keep working, and act on the events it sends. The
watch ends on evidence, never on elapsed time and never on a check summary.

**Use the `Monitor` tool on `scripts/watch-ci.sh <state-dir>`, for 30 minutes, and re-arm it on
every expiry notice while anything in scope is in flight.** Each stdout line becomes a
notification, so the session stays free while CI runs. Do not write a foreground poll loop: it
occupies the session for the length of a build. For a single "tell me when it finishes", a `Bash`
call with `run_in_background: true` that exits on the condition is lighter.

## Scope

`main` plus the head branch of every open PR, re-read each cycle:

```bash
{ echo main; gh pr list --state open --limit 50 --json headRefName --jq '.[].headRefName'; } | sort -u
```

A PR opening or merging changes the scope, and picking that up is this skill's job.

## What the monitor emits

It polls every 75 seconds, seeds silently on its first pass (one `SEEDED` line with the counts),
then emits:

- `RED <branch> <workflow> run <id> (<conclusion>)` once per newly failed latest run;
- `MERGEABLE #<n> <branch> (<sha>)` once per PR per head, when every latest run is on the head,
  terminal and not failed;
- `NOT GATING <branch>: …` once per set of runs from events other than push and pull_request;
- `TALLY: …` and exit 0 when nothing in scope is running for two cycles;
- `NO DATA` and exit 1 after three cycles with no runs at all.

What it covers:

- **Every terminal state.** `failure`, `timed_out`, `action_required` and `startup_failure` are
  red; `success`, `skipped`, `cancelled` and `neutral` are not.
- **State from the API.** `gh run list --json` with `jq`, never a log grep. Empty result sets are
  counted, not read as green. A failed `gh` call skips the cycle.
- **Only push and pull_request runs gate a PR.** A workflow dispatch or a scheduled run is not a
  check on the PR; the monitor reports it as `NOT GATING` and does not hold the PR back.
- **Skipped and cancelled do not hold a PR back.** A workflow can skip under a `paths:` filter,
  and a cancelled run is usually a supersession.

Re-arm it after each push: a new head means new runs.

## When a mergeable PR appears

Run `/auto-merge`. Never merge by hand: that skill re-checks what a shell probe cannot see
(uncommitted work in the branch's worktree, a branch ahead of origin, unresolved review threads, a
head that moved). The probe is a hint, not a verdict: green runs on a stale head look ready and
are not, and a PR whose runs have not registered yet looks unready and is merely early.

If `/auto-merge` merges anything, the scope changes: the PR's branch leaves it and `main` gains a
`deploy.yml` run. Re-read the scope on the next cycle.

## When a red arrives

Gather the whole run's failures before fixing anything. Open the run; never report its state from
memory or from `gh pr checks`.

```bash
gh run view <run-id> --json jobs \
  --jq '.jobs[]|select(.conclusion=="failure")|.steps[]|select(.conclusion=="failure")|[.number,.name]|@tsv'
```

`gh run view --log-failed` often returns nothing useful when the failure is buried in a step's
output. Fetch the job log directly, strip the ANSI codes, and tee before filtering:

```bash
gh api "repos/polycode-public/concordance/actions/jobs/<job-id>/logs" --allow-escape-sequences \
  | sed 's/\x1b\[[0-9;]*m//g' | tee /tmp/job.log | grep -iE "error|fail|✘" | tail -20
```

Three reds that are not defects. A cancelled run is usually a supersession: check for a later run
in the same group. A commit can legitimately trigger nothing under a `paths:` filter, and "no run
for this commit" differs from "run failed" (a change that should have triggered a workflow and did
not means the filter is the bug). And with `cancel-in-progress: false` GitHub keeps one run queued
per group and drops the older pending one when a third arrives.

Fix the right layer, and name it. Check what changed underneath you: an upstream npm release, an
action version, an AWS limit, a model download.

## Push discipline

Never push to a branch while a run that deploys from it is in flight; here only `main` deploys
(`deploy.yml`), so a branch push is safe. Run the checks CI runs before pushing:
`npm run check:all`.

## Stop condition

All at once, each verified by reading:

1. Every open PR's newest `test.yml` run succeeded on its head.
2. `main`'s newest runs succeeded, including `deploy.yml` when it ran. Enumerate the workflows
   with `gh workflow list` rather than assuming a set.
3. No run queued or in progress on any branch in scope, established by counting rows.

If blocked on something only the operator can do, say so in one line, show the whole command with
the `!` prefix, and keep the monitor running.
