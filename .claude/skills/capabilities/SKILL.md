---
name: capabilities
description: Find the tooling this repository already has before building any, and keep REPORT_CAPABILITIES.md current. Invoke before you add a script, workflow, stack, check, test harness, ingest step, eval, page or skill; when a task says add, build, create, automate, check, ingest, measure, deploy or clean up; and when you need the command that does something here.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# capabilities

`REPORT_CAPABILITIES.md` at the repository root lists every capability with the command that runs
it. Look there first. Use or extend what you find; add a new mechanism only when no entry fits.

**If the file does not exist,** this skill creates it on first run. Read `package.json` scripts,
`scripts/`, `.github/workflows/`, `packages/**`, `evals/` and `.claude/skills/`, then write the
Index, the area headings and one entry per capability, in the shape below. Give the file the
licence header.

## Find a capability

1. Read the Index at the top: id, name, "use when". Match the task against the "use when" phrases.
2. If nothing matches: `grep -n -i '<word>' REPORT_CAPABILITIES.md | tee /tmp/cap-hits.txt | head -40`,
   with the task's words and their synonyms.
3. Open the entry (`#### <ID> <name>`): **Use when**, **Does**, **Run**, **Entry** (`path:symbol`),
   **Files**, **Keywords**, **Related**.
4. Read the Entry code before relying on the entry. The code is the truth; the entry is a map.

## Decide

- An entry does the job: run it as **Run** says.
- An entry does most of it: extend its Entry code; do not write a second tool beside it.
- Two entries overlap with your task: extend the one whose **Does** is closest, and say which in
  the commit.
- No entry fits: build the capability and add its entry in the same commit.

Say which entry you used, or that none fitted, in your report or PR body.

## Add or change an entry

Entries sit under an area heading (`## <Area> (<PREFIX>)`): `CORE` for `packages/core` (ingest,
chunking, retrieval, providers, checks, the contradiction engine), `LOCAL` for `packages/local`,
`UI` for `packages/ui`, `DB` for `db/` and its migrations, `EVAL` for `evals/`, `INFRA` for
`infra/` and the workflows, `DEV` for scripts, tests and skills.

```markdown
#### CORE-3 Fuse ranked lists

- **Use when:** a query needs one ranking from the vector and the keyword results
- **Does:** Merges the two ranked lists with reciprocal rank fusion and returns the top chunks.
- **Run:** `npx vitest run packages/core/retrieval/fuse.test.mjs`
- **Entry:** `packages/core/retrieval/fuse.mjs:fuseRanks`
- **Files:** packages/core/retrieval/fuse.mjs, packages/core/retrieval/fuse.test.mjs
- **Keywords:** hybrid, rank fusion, rrf, retrieval, search
- **Related:** CORE-2
```

One fact per sentence, at most 20 words, active voice, present tense, the names the code uses.
Check every **Run** command against the code with grep. Take the next free number in the area and
add the entry's line to the Index by hand (this repository has no index generator yet). Keep a
Keywords section at the end that maps words to ids.
