---
name: auto-merge
description: Catalogue worktrees, branches, uncommitted work, PRs and review threads; render the state; merge every PR that is ready; then hand over to /watch. With the argument "dry-run" it changes nothing and prints what it would do. Invoke when the operator says "auto-merge", "merge what's ready", or asks for the merge state.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# auto-merge

Gather the whole picture, show it, merge only what is unambiguously ready, and hand the result to
`/watch`.

**This skill is the only path by which Claude merges a PR.** `CLAUDE.md` forbids a bare
`gh pr merge` anywhere else, because the gates below are the point: a merge is the one action a
later commit cannot undo. The skill never pushes to `main` directly, never deletes an origin
branch, and never rewrites history. A gate you cannot check is a stop: say so and leave it to the
operator.

## Dry-run

`/auto-merge dry-run` (also `/auto-merge-dry-run`) runs every gathering step and prints every
table, and changes nothing: no merge, commit, push, rebase, branch deletion, file write (`NEXT.md`
included), PR comment or label, and no `/watch`. Where the live run would act, print the exact
command in a fenced `!` block and mark the row **would merge**. Say "dry run" on the first line.

## Part 1: gather

Read, do not assume.

```bash
git fetch --prune origin
git worktree list
git branch -vv
gh pr list --state open --json number,title,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus
```

For each PR, the required checks, if the repository sets any, against the contexts that ran on its
head:

```bash
gh api repos/polycode-public/concordance/rules/branches/main \
  --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
gh api repos/polycode-public/concordance/commits/<headRefOid>/check-runs --jq '.check_runs[].name'
```

`test.yml` runs on every push and pull request regardless of what changed, so a Markdown-only head
needs no dispatch. A required context with no run on the head blocks.

For each worktree, `git status --short` inside it: uncommitted work vanishes when the worktree
goes. For each local branch, `git log --oneline origin/<b>..<b>`: a branch ahead of origin means
the PR would merge something older than what exists locally. Check local `main` for unpushed
commits too; a commit made on the main checkout by mistake is invisible to every PR.

For each open PR, its review state. Both halves matter:

```bash
gh pr view <n> --json reviews,reviewDecision
gh api graphql -f query='{repository(owner:"polycode-public",name:"concordance"){pullRequest(number:N){reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login} body path}}}}}}}'
```

A `CHANGES_REQUESTED` review blocks. An unresolved review thread blocks, an outdated one too: it
was about code that moved, and nobody has said it is handled.

## Part 2: the inventory table

| PR | Branch | Worktree | Uncommitted | Ahead of origin | Draft | Review state | Mergeable |

One row per open PR, then rows for branches and worktrees with none, so nothing is invisible.

## Part 3: eligibility

Eligible for the run check only when all hold:

1. Not a draft.
2. No `CHANGES_REQUESTED` review and no unresolved review thread.
3. No uncommitted changes in any worktree on its head branch.
4. Its head branch is not ahead of origin.
5. `mergeable` is not `CONFLICTING`.
6. The PR's head SHA equals the branch tip on origin. A merge takes the head it was last updated
   against; anything pushed after is left behind.
7. Every required context has a run on that head.

Name the gate that stopped each ineligible PR.

## Part 4: the run check

For each eligible PR, take the latest run of each distinct workflow on its head from push or
pull_request events:

```bash
gh run list --branch <headRef> --limit 60 --json headSha,workflowName,status,conclusion,databaseId,event \
  | jq 'map(select(.event == "push" or .event == "pull_request"))'
```

Filter to the head SHA, group by `workflowName`, keep the newest per group. Only push and
pull_request events gate the merge: a workflow dispatch or a scheduled run is not a check on the
PR. Merge only when every one of those latest runs has `conclusion == "success"`.

- `cancelled` is usually a supersession. A later run of the same workflow on the same SHA that
  succeeded makes it noise; with none, the workflow did not run and that blocks.
- `skipped` is not a pass; it produced no evidence. Treat it as no run and say so.
- A workflow with no run may be correct under a `paths:` filter. A change that should have
  triggered it and did not means the filter is the bug; name the workflow.
- Still running blocks. Report it as running, not as a failure.
- An empty result set is NO DATA, not green. Runs take a minute to register after a push.

Never read a PR's state from `gh pr checks` alone, and never from memory. Open the runs.

## Part 5: merge

One at a time. Wait for each merge to land, and for `main`'s `deploy.yml` run to finish, before the
next: two merges start two deploys of the same stacks.

```bash
gh run list --branch main --limit 6 --json status,workflowName --jq '.[] | select(.status != "completed")'
```

must be empty first. The batch merges as a merge commit, never squashed. Worktree-to-batch merges
are squashed, so `main` keeps one commit per row. Pin the head so a late push cannot slip
in, and run the command on its own (the classifier refuses it chained with anything):

```
! gh pr merge <n> --merge --match-head-commit <the eligible sha>
```

Then verify, because a reported merge has been wrong:

```bash
gh api repos/polycode-public/concordance/pulls/<n> --jq '"merged=\(.merged) head=\(.head.sha[0:8]) mergeCommit=\(.merge_commit_sha[0:8])"'
git fetch origin && git log --oneline origin/main..origin/<headRef>
```

The second command must be empty; anything it lists was left behind and goes into the next batch.
Update local `main`. List the branch's worktree, local branch and origin branch for the operator
as one fenced `!` command; their removal is the operator's.

**When the merge call is refused** by the permission classifier, print the command in a fenced `!`
block with the eligible sha, mark the row **handed over** in Part 6, retry once on the next
`/auto-merge`, and carry on with every other step instead of waiting.

**The other open PRs:** leave them as they stand unless they now conflict or overlap the merged
files (`git diff --name-only origin/main~1..origin/main` against each one's changed files).
Overlap or `CONFLICTING`: rebase locally in its worktree, run its blast radius, and push with
`--force-with-lease` only when no run on that branch is in flight. A stricter gate in
`.github/workflows/test.yml` or `package.json` reaches every file: if the merge changed either,
merge the candidate with new `main` in a scratch worktree and run `npm run check:all` there. A red
result is `gate <name> red on #<n>`; leave the PR open and hand the fix to a sub-agent. A conflict
aborts the rebase (`git rebase --abort`) and goes to a sub-agent; never resolve it here. Skip any
branch with uncommitted work or commits ahead of origin, and say so in Part 7.

## Part 6: the result table

| PR | Branch | Workflows (latest per workflow) | Worktree | Check result | Action |

`Check result` is exactly `ready` or `blocking: <gate>`. `Action` is the action taken, or
recommended when nothing was taken: `merged`, `would merge`, `handed over`, `left as is`,
`rebased onto <sha>`, `rebase pending: run in flight`. End with a summary row.

## Part 7: next actions

Two short lists. **Operator:** what needs a human, every command in full with `!`. **Agent:** what
this session does next (orphaned commits to fold into a batch, uncommitted worktree work to rescue,
a workflow that should have run and did not). Say plainly when a list is empty.

## Part 8: hand over

If anything merged, invoke `/watch` (the merge starts `main`'s deploy, where a batch's real
problems surface), then `/compact-ready`. If nothing merged, say so and do neither. Skipped in
dry-run.
