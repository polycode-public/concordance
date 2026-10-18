---
paths:
  - test/**
  - packages/**/*.test.mjs
  - evals/**
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# Testing Rules

## Test File Naming

- Pattern: `*.test.mjs` beside the source in `packages/**`, `*.test.mjs` under `test/`.
- `vitest.config.js` includes `test/**`, `packages/**` and `evals/**`, and excludes
  `.claude/worktrees/**`.

## Frameworks

| Type          | Framework  | Config                                              |
| ------------- | ---------- | --------------------------------------------------- |
| Unit / system | Vitest     | `vitest.config.js`                                  |
| Browser (UI)  | Playwright | added with `packages/ui` when the plan calls for it |

## Offline by default

- `npm run test:unit` and `npm run check:all` run with no network, no Docker and no Ollama. CI runs
  exactly this.
- A test that needs a service is a tier, and the tier is opt-in by environment variable:
  - **Docker tier:** a real Postgres with pgvector (`npm run db:up`), turned on by
    `CONCORDANCE_DB_TESTS=1`. It covers migrations, SQL, indexes and hybrid retrieval.
  - **Ollama tier:** a real local embedding or generation model (`npm run models:pull`), turned on
    by `CONCORDANCE_OLLAMA_TESTS=1`. It covers embedding shape, citations and the contradiction
    engine's judgement.
- Without its variable, a tier test skips with a message that names the variable. It never fails
  and never passes silently.
- A tier test cleans up what it creates (a schema per run, a temporary table) and does not touch
  the developer's data.

## Unit tests

- Fast, isolated, no external dependencies.
- Replace a provider (embedding, generation) with a small fake from `packages/core/providers` so
  the test is deterministic.
- Use committed fixtures under `test/fixtures` for documents and chunks. Never read
  `corpora/*/raw` or `text` in a unit test: those folders are gitignored.
- A citation test asserts the cited span is a substring of the source text, sentence by sentence.

## Evals

- `evals/` holds measured quality checks (retrieval recall, citation accuracy, contradiction
  precision). They run through `npm run eval` and are not part of `check:all`.
- Set a threshold from a measured run on the same corpus and model, and record the run beside it.

## Blast radius first

- Run the tests the change reaches: `npx vitest run <file>` while you work.
- Run `npm run check:all` once, before the push. Only the coordinator runs it for a batch.
- Do not run a tier "to be sure" in a worktree unless the brief names it.

## Writing New Tests

- Business logic (chunking, fusion, fact extraction, contradiction rules): unit tests expected.
- SQL and migrations: Docker tier test.
- Model behaviour: Ollama tier test or an eval, never a unit test with a hand-written "model".
- A new file carries the licence header; `test/repo/licenceHeaders.test.mjs` fails the suite without
  it.
