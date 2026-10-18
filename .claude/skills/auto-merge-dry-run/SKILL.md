---
name: auto-merge-dry-run
description: Everything /auto-merge reports, with nothing it changes — the same catalogue, tables and verdicts, and no merge, commit, push or file write. Invoke when the operator wants to see what would merge before anything does.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# auto-merge-dry-run

**Read `.claude/skills/auto-merge/SKILL.md` and follow it in dry-run mode.** That is this skill's
whole content; the rules live beside the actions they suppress so the two cannot drift apart.

Dry-run mode is defined in that skill's "Dry-run" section. In short: gather everything, render
every table, reach every verdict, and take no action. No merge, no commit, no push, no rebase, no
branch or worktree deletion, no write to a tracked file, no PR comment or label, and no `/watch`.

Three things this skill adds, and nothing else.

**Say it is a dry run in the first line.** The tables are identical to the live run's, so without
that line a reader cannot tell whether a PR merged or merely would have.

**Print what the live run would have done**, as a full command in a fenced block prefixed with `!`,
so the operator can run any of it by hand. A row that would have merged reads **would merge**, never
**merged**.

**A dry run that finds nothing ready is a useful result.** Report the blocking gate for every PR
and stop. The point is to see the state before changing it.

If the operator then wants the merges, they invoke `/auto-merge`.
