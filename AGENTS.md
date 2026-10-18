<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# AGENTS.md: concordance

Instructions for any coding agent working in this repository. `CLAUDE.md` holds the full
conventions for Claude Code sessions and is the source of truth; this file is the short form.

## What this is

A witness research tool over public inquiry witness statements (demo corpus: the Grenfell Tower
Inquiry): hybrid retrieval, a citation on every sentence, a checking layer, and a fact store that
finds agreement and contradiction between witnesses. Specification:
`docs/SPEC_WITNESS_RESEARCH_TOOL.md`. Plan: `PLAN_CONCORDANCE.md`. Open work: `NEXT.md`.

## Stack

Node 24, ES modules, plain JS, no TypeScript, no framework. Postgres 16 + pgvector (Docker),
Ollama for models, a small HTTP + WebSocket server, a raw ESM page. CDK in JS under `infra/` for
the thin AWS sandbox stack. Vitest for tests. AGPL-3.0-only.

## Commands

```bash
npm ci
npm test                 # offline tier; must pass with no Docker and no Ollama
npm run check:all        # tests, prettier, eslint, cdk synth
npm run db:up && npm run db:migrate
npm run models:pull
npm run dev              # http://localhost:8787
```

## Rules

- Every file starts with the SPDX header `AGPL-3.0-only` and `Copyright 2026 Polycode Limited`.
- Evidence is never altered; every claim resolves to a stored locator; every automated judgment
  is reversible by a person; the answer is closed-world over the evidence blocks.
- No real identity for a cipher-only witness anywhere in the system.
- The laptop provider (`MODEL_PROVIDER=laptop`) is the one features are built and evaluated on.
  Nothing under `packages/core/` imports an AWS SDK.
- Code reaches `main` through a `claude/*` branch and a pull request with a green `test.yml` run.
  Docs-only commits may go straight to `main`.
- Never write to AWS outside `deploy.yml` without the operator's explicit approval.
- Never commit corpus files (`corpora/*/raw|text|chunks|media`), model weights or secrets.
- Comments explain a non-obvious why only; test names describe behaviour; neither references a
  plan, a row, a commit or a date.
