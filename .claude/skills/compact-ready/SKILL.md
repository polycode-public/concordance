---
name: compact-ready
description: Before a compaction, land or commit every agent's and worktree's work, write NEXT.md and chat decisions to files, keep monitors, then answer yes / yes after / not yet and list what the summary must keep. Invoke as /compact-ready; /board and /auto-merge run it at their natural breaks.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# compact-ready

Answer "is now a good time for compaction?" and make it true. A compaction keeps a summary and
drops the rest, so everything a later turn needs must sit in a commit, `NEXT.md`, a plan file or
the summary text before `/compact` runs. `/auto-merge` runs this skill after every verified merge,
and `/board` at the end of every render.

## 1. Gather

Read, do not recall:

```bash
git status --short                                  # main checkout
git worktree list
for w in $(git worktree list --porcelain | awk '/^worktree /{print $2}'); do
  echo "== $w"; git -C "$w" status --short; git -C "$w" log --oneline -1
done
gh pr list --state open --json number,headRefName,mergeStateStatus
gh run list --limit 15 --json workflowName,status,headBranch,databaseId \
  --jq '.[]|select(.status!="completed")'
```

Also list this session's running sub-agents, Monitors and background commands, by their labels.

## 2. Settle each item

| Found                                                        | Action before compaction                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A sub-agent mid-edit                                         | Wait for its report, or `SendMessage` it to commit what it has and report; never compact over uncommitted agent work                                                       |
| A sub-agent that reported, work not landed                   | Land it: `git status --short` in its worktree, squash-merge onto the batch, one commit per row, content proof (`git diff <agent-branch> <batch> -- <files>` empty)         |
| Uncommitted changes in a batch worktree or the main checkout | Commit them (own files only) or name them in the summary as deliberately left                                                                                              |
| A `NEXT.md` row whose state changed this session             | Write it back: move it to its section, update its remainder, run `npx vitest run test/repo/nextShape.test.mjs`, commit, push to `main` as its own command (docs exception) |
| A decision or fact the operator gave in chat                 | Write it into its `NEXT.md` row, the plan or memory now                                                                                                                    |
| A merge in progress (`/auto-merge` between gate and verify)  | Finish it first                                                                                                                                                            |
| A push waiting on a run                                      | Leave it waiting; name the branch, the commit and the run in the summary                                                                                                   |
| A Monitor or background command                              | Keep it: notifications still arrive after a compaction. Name each in the summary with what to do on its events                                                             |

## 3. Answer

One line first: `yes`, `yes after <action>`, or `not yet: <what to wait for>`.

`not yet` has exactly two causes:

1. A sub-agent is mid-edit and its work is not committed.
2. A merge is between its gates and its verification.

Everything else is `yes`, with the item named in the summary: a PR in CI, a deploy running, a push
waiting, an operator's pending yes, a Monitor, a sub-agent that has committed but not reported.
Each goes on waiting unaided, and its notification arrives after the compaction. Before writing
`not yet`, name which of the two causes applies; if neither does, the answer is `yes`.

Then the list the summary must keep, because it lives only in this conversation:

1. What is running: each agent, Monitor and background command, and what to do when it reports.
2. The batch's next steps: branch, worktree, the commits on it, what verifies it, the PR.
3. Operator decisions from this session not yet in a file.
4. Operator commands handed over and not yet run, in full with the `!` prefix.

When the answer is `yes`, print one line, `/compact ` followed by the list, in a fenced block, so
the operator runs it as typed; the built-in `/compact` is the operator's to run.
