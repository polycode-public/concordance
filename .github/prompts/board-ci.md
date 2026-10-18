<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory prompts -->

# board, inside a GitHub Actions step

Run the repository's `/board` skill and follow it. It is the specification; this file only says how
an unattended run differs from a terminal one.

Run id: `${RUN_ID}`. Run url: `${RUN_URL}`.

## What is different here

**There are no local branches and no worktrees.** Part 5's branch audit covers `origin` only. Say
so in that part rather than reporting an empty local list as though you had swept one; a reader who
sees "no local branches" from a runner learns nothing, and a reader who sees "origin only, this run
has no local checkout to sweep" knows exactly what was and was not examined.

**Nothing local can be pruned**, so the skill's `git worktree remove` and `git branch -D` block
does not apply. An origin branch is the operator's to delete, exactly as in the terminal.

**The monitor line in the mode header is always "none".** A background poller cannot outlive this
runner. Do not report one and do not start one.

**Do not run `/compact-ready`.** This runner has no session to compact.

**Everything else you may read freely**: `NEXT.md`, the `PLAN_*.md` documents, the open issues,
the runs on `main` and on every open PR's head, and `origin`'s branches. If a read fails, render
that part as unverified and name the failure, never as absent.

**Part 3's AWS read runs with no `--profile` flag.** This job already holds the sandbox role's
credentials and its region. Run `aws cloudformation list-stacks ...` exactly as the skill shows it,
minus `--profile polycode-sandbox`: the runner has no profile, and a `--profile` prefix takes the
command outside the allowed patterns, so it is refused.

## Settle every in-flight row against origin before judging the file

A row's prose is a claim, not evidence. For each row under `## In flight` that names a branch or a
pull request, check it this run:

1. `git ls-remote --heads origin <branch>`. No output means the branch is gone from origin.
2. `gh pr list --repo ${GITHUB_REPOSITORY} --state all --head <branch> --json number,state,mergedAt`
   (and `gh pr view <n> --repo ${GITHUB_REPOSITORY} --json state,mergedAt` for a named PR).
   `MERGED` means the row's change is on `main`.

A branch that is gone from origin, or whose pull request is `MERGED`, means the row's batch landed:
the row leaves `## In flight` (its remainder, if any, moves to the section its class dictates;
otherwise the row is deleted). Do not report a row as in flight with a branch that `git ls-remote`
does not list. A row whose branch and open pull request still exist stays.

## The render is the product

Write all five parts into your output in full. That output becomes the job summary, and for a run
nobody watched it is the only account of what the board looked like. Do not abbreviate on the
grounds that nobody is reading; the point is that somebody reads it later.

## Writing back: only when it is worth a commit

You may change **`NEXT.md` and nothing else**. Any other file changed will fail this job. You
commit; the workflow pushes, after its guard has checked the change.

**The order of the run is fixed, and the report is the last output.** Print no part of the report,
and no summary text, until step 3 is done.

1. Gather: the settle checks above, the stack read, the issue and run reads.
2. Decide: list every row whose status no longer matches what you found. Merged-PR rows found in
   step 1 are on this list.
3. Edit `NEXT.md` now, with the Edit tool, for every row on the list, run the skill's prettier and
   `npx vitest run test/repo/nextShape.test.mjs` checks, then `git add NEXT.md` and `git commit`.
   Writing "Proceeding with the update" in text is not the edit; the Edit tool call is. Do this
   before rendering anything. On a render-only run (the section at the end of this prompt says
   so), step 3 makes no edit and no commit: its list of edits is what step 4 prints instead.
4. Render the five parts. Part 1 states what step 3 changed, row by row. If step 3 changed nothing,
   print exactly: `NEXT.md already true: no edit made.`

An unattended run adds a caution the terminal does not need: **do not commit for the sake of
committing.** A no-op commit on `main` every few hours is noise that trains everyone to ignore the
file's history.

Commit only when at least one of these is true:

- a row's status is now wrong in a way that would mislead the next reader or agent;
- a row is finished and should be deleted, because this file holds open work only;
- a row's section, owner or tier no longer matches its state, so the board order lies;
- the sandbox deployment line no longer matches what is live.

If none holds, step 3 is empty and step 4 prints the line above. That is a good outcome and the
most common one.

## GitHub issues that deserve a row

An open issue with no board row and no plan behind it is invisible to everyone working from
`NEXT.md`. When you find one that warrants tracking (not every issue does), do both halves,
because either alone leaves the two records disagreeing:

1. **Add the row to `NEXT.md`**, in the right section, with the source, the owner, the **Size**
   and the **Model**, exactly as the skill and `test/repo/nextShape.test.mjs` require of any row.
2. **Comment on the issue** saying it is now tracked, naming the row label and linking this run:

   > Tracked on the board as **&lt;label&gt;** in `NEXT.md`. Added by an unattended board run:
   > ${RUN_URL}

Do not close, relabel or edit the issue body. The skill forbids changing GitHub state during a
render, and this is the one narrow exception it allows, because a tracking comment records a
decision rather than altering the thing being reported.

If an issue does not warrant a row (a duplicate, something already covered by a plan document),
say so in one line in your output and leave the issue alone.

## Attribution

Commit with the unattended-agent form, because this is a machine run:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Model: <your model id>
Claude-Run: ${RUN_URL}
```

`NEXT.md` is a documentation file, so the docs exception applies and the commit goes straight to
`main`. That exception is also the reason the workflow's guard refuses any other path: a change to
code or workflows must never reach `main` this way.
