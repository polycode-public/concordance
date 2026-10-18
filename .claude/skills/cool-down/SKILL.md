---
name: cool-down
description: Slow the flow of new work and settle what is already in flight, then bring it back up again. Agents commit and stop, PRs and workflow runs are driven green one branch at a time, and the tracking documents catch up. Holds the revival notes too, so /wake reads from here. Invoke when the operator says "cool down", or when a batch is stacking problems faster than it lands them.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# cool-down: stop adding, start settling

Cool-down is a **mode**, not a one-shot pass. It stays on until the operator lifts it in their
own words. Turning it on does not stop work; it changes what work is allowed to be.

The failure it exists for: a batch that adds rows faster than it lands them, several agents in
flight at once, workflow runs failing while more commits arrive, and a board that no longer says
what is true. Cool-down is how that settles without losing anything.

This file holds both directions. Each rule below carries a **Waking** note saying how that
facet comes back. `/wake` is deliberately thin and reads those notes from here, so the way down
and the way up cannot drift apart.

## Turning it on

Write the marker as the first paragraph of `NEXT.md`'s `## In flight` section, so it survives a
compaction and any other session reads it (`test/repo/nextShape.test.mjs` allows a paragraph
there; only rows are checked):

```
**COOL-DOWN is on since <ISO-8601 UTC>.** No new board rows except a degradation. Agents commit
and stop. One branch is driven green at a time. Lifted only by the operator in their own words.
```

Commit that on its own, push it to `main` (docs exception), and say in the reply that it is on
and what it forbids.

**Stop the loop and the watch in the same turn.** If `/iterate` is running, end it with
`ScheduleWakeup` `stop: true`; if a `/watch` Monitor or a background run poll is running,
`TaskStop` it. Neither is compatible with the mode: the loop dispatches on the next board and the
watch exists to feed `/auto-merge`, and both would resume work the marker forbids the moment a
wake signal arrived. If neither is running, say so in one clause.

Then, if a sibling session is waiting on a change from this repository, tell it through its inbox
(`~/.claude/inboxes/<handle>.md`, protocol in `~/.claude/inboxes/README.md`) that this repository
is cooling down, so it holds new asks. Send nothing when no session is waiting.

## The five rules while it is on

### 1. No new board rows, with one exception

A new row is allowed only when it unblocks a row already on the board, **or when it records a
degradation**. A degradation is anything that used to work and now does not, or that has never
worked and was believed to: a failing workflow run on `main`, a broken deploy, a retrieval or
citation defect, a contradiction the engine misses that its evals should catch, a check that
turns out to check nothing.

Everything else goes to `PARKED.md` at the repository root, one line each with enough detail to
pick up later, for the operator to triage when cool-down lifts. Create the file if it is missing
(with the SPDX header). Never let a discovery evaporate into the transcript, and never argue it
onto the board because it feels important. The board is closed; the parking list is open.

**Waking:** hand `PARKED.md` back as a list for the operator to triage. Promote nothing on your
own judgement, however obvious it looks after a night of settling. Each line the operator picks
becomes a board row placed in board order; each line they drop is deleted. When the file is
empty, remove it.

### 2. A live degradation on `main` gets its own branch

When the degradation is on `main` or in the deployed sandbox, it does not join the batch. Branch
from `main`, carry **only that fix**, open its own PR, and tell the operator plainly to merge that
PR first, before the batch. A one-fix branch off `main` can deploy without waiting for anything
else to be right.

Print the reasoning as well as the branch name. The operator is choosing a merge order.

**Waking:** every hotfix branch is accounted for before anything else starts. Merged means its
board row is deleted and its branch and worktree are on the operator's removal list (the `!`
block). Still open means it keeps its place at the front of the merge order, and the reply says so
again. A hotfix branch that is neither merged nor open is the first thing to explain.

### 3. Agents finish the item they are on, commit it, and stop

Message every running agent (`SendMessage`, by its task label): land the piece you are on, commit
it to your branch, and start nothing new. Do not interrupt mid-edit. A half-committed branch does
not build and becomes the next session's puzzle; work left uncommitted in a worktree vanishes when
the worktree is removed and the coordinator gets exactly one look.

Dispatch no new agents. When each reports, land its verified commit on the batch as usual
(squash, one commit per row, content proof), then check `git status --short` **inside its
worktree**, not just its last commit.

**A green PR stays open.** Cool-down settles what is in flight; a merge starts `main`'s deploy,
which is more in flight, and the operator may be cooling down exactly to keep `main` still. Push
the batch, drive it green under rule 4, and leave it there: merging it is `/wake`'s first step,
run by the operator's own word. A live fix under rule 2 is the one exception, and the reply says
so when it asks for that merge order.

**Waking:** before dispatching anything, walk every worktree still on disk (`git worktree list`)
and check `git status --short` in each. Uncommitted work found there is recovered first, because
the next dispatch may remove the worktree that holds it. An agent whose worktree is gone is never
resumed; dispatch a fresh one with a brief built from the board, not from memory of what the old
one was doing. Only then does new dispatch resume, and it resumes at the batch's normal width, not
wider to make up lost time.

### 4. One branch at a time, and prove the fix locally before pushing

Per branch:

1. **Wait for every workflow run on its head to conclude.** Not the first failure, all of them. A
   head with three failed jobs and one still running is not ready to be fixed.
2. **Gather every observed issue together.** One triage across all of them. Several failures
   usually share one cause, and finding that is cheaper than fixing three symptoms.
3. **Reproduce each failure locally and get a passing result** before pushing anything
   (`npm run check:all`, the failing test file, `npx cdk synth --quiet` for `infra/`). A push
   whose fix has not been proven locally is a guess that costs a whole CI cycle, and guesses are
   what turned a batch into a loop in the first place.
4. **Push once, carrying every fix.** Then back to step 1.

Repeat until the branch is green. There is no cap on pushes, because the local-proof rule is
what stops the loop.

**Fix only what our own commits broke.** A run that was already failing before this batch (an
upstream npm release, a runner image, an AWS limit) is not cool-down's work: record it in
`PARKED.md` or, if it is a degradation, as a board row under rule 1, and leave it. Check the
workflow's history on `main` (`gh run list --workflow <name> --branch main`) before deciding
which it is.

**A branch is settled only when nothing is committed after its last push.** Run
`git log --oneline origin/<branch>..<branch>` and expect nothing. The push and the merge are two
separate moments, and anything committed between them does not ship: the PR merges what was
pushed, not what exists locally, and `/auto-merge` refuses a branch ahead of origin. Check every
branch for unpushed commits before calling it settled, and again before telling the operator a PR
is ready.

**Waking:** the local-proof rule does not lift with the mode. It is the habit cool-down exists to
install. What does lift is the one-branch-at-a-time serialisation, and only once every branch that
was open during cool-down is green or closed. A red branch left behind keeps the whole board
serialised until it is settled.

### 5. The tracking documents catch up

This is the part that is always skipped and always missed later.

- `NEXT.md`: every in-flight and every just-landed row names **its worktree, its branch and its
  PR**. A row that says work is happening without saying where is not a status.
- `NEXT.md`: every open row's status is made true as of now. Closed rows are deleted; this file
  holds open work only. The "Deployed" line names the commit on the stacks.
- `PLAN_*.md`: any plan whose decisions moved during the batch records them, so the plan and the
  board do not disagree.
- Commit the documents on their own, separately from any code fix, so the history reads.

**Waking:** the documents are current, so they are the source for what to dispatch. Read them;
do not work from memory of what the batch was doing. Where a row and your recollection disagree,
the row wins, or the row is wrong and fixing it is the first action.

## Resequencing and the board

Both directions keep the board honest as they go.

**Resequence as statuses change.** Whenever a row's state or class moves, move the row in
`NEXT.md` at the same time: a row whose blocker cleared rises to its class's section, one that
gained a blocker drops to `## Blocked`, a new degradation goes to the top of `## Machine-only`.
The order is the one `/board` defines.

**Run `/board` as the last action.** Cooling down ends with a board render, and so does waking
up. That render is what tells the operator the state settled, or came back, and it writes its own
statuses back as it always does.

**Every 60 minutes, if neither end has been reached**, stop and render anyway: the four-line
report below, then `/board` in full. Then carry on.

## The report

End every cool-down or wake turn with the same four lines:

- **Agents**: how many were running, how many have committed and stopped, how many remain.
- **Branches**: each one, its run state, its count of commits ahead of origin, and what it is
  waiting for. A branch ahead of origin is not settled, however green it looks.
- **Board**: rows added and why each was allowed, rows closed, entries parked.
- **Next**: the single thing that would most reduce what is outstanding.

## Waking up

Only the operator lifts cool-down, in their own words. "Carry on" or "resume" is enough; the
absence of new instructions is not. Silence is not consent to resume.

**`/do-next` and `/iterate` are such instructions.** Asking for the board to be worked and staying
cool cannot both be true, so those skills run the eight steps below before their first dispatch.
A step that cannot be completed keeps the session cool, and the skill says which step and stops
there.

The order matters, because each step depends on the one before:

1. **Run `/auto-merge` first**, before the marker comes off. A cool-down usually ends with work
   sitting in a green PR nobody merged, and waking into a dispatch on top of an unmerged batch
   stacks a second branch on the first.
2. Delete the cool-down marker from `NEXT.md`.
3. Account for every hotfix branch (rule 2's Waking note).
4. Walk every worktree still on disk for uncommitted work (rule 3's Waking note).
5. Confirm every branch that was open during cool-down is green or closed and carries no
   unpushed commits, which is what lifts the one-branch serialisation (rule 4's Waking note).
6. Read the tracking documents and work from them (rule 5's Waking note).
7. Hand `PARKED.md` back for triage (rule 1's Waking note).
8. Resequence the board, then run `/board`.

Only after all eight does new dispatch resume. If any step cannot be completed, say which and
why, and stay cool until it is.
