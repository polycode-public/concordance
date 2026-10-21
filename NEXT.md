<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# NEXT

Open work only. A row leaves this file in the same commit that closes it; completed work lives in `git log`. The plan of record is `PLAN_CONCORDANCE.md`; the AWS form is `docs/archive/PLAN_AWS_SANDBOX.md`; the laptop port check is `PLAN_LAPTOP_STACK.md`. Each row ends with **Size** (files touched, estimated) and **Model** (the lowest sub-agent tier that fits: Fable, Opus, Sonnet, Haiku; `operator` for a human row).

The board runs in five sections, in this order. The section is the classification: what it takes to carry the row to completion. `machine-ask` is work a session drives with a human present to authenticate or approve (an SSO login, an AWS write outside `deploy.yml`, a GitHub setting). `human-driven` is work a person must do themselves (a decision between named alternatives, a purchase, a signature).

**Deployed:** five stacks in polycode-sandbox, the newest from `deploy.yml` run 39607963217 of `627c11a6` (2026-10-21, the $100 cap on both budgets; the Playwright proof answers on the live page). Store: 38 Grenfell and 10 UCPI statements, HN43's extraction incomplete (370 assertions over 592 sections).

## In flight

## Machine-only

- [ ] **A5. The board run's job summary is the render only.** Run 39608306185 (A4's render-only run, green, 17 turns, $0.054) posted a usable board, but its result field opened with the agent's working prose ("Good. Now I have enough information to render", then a numbered analysis) before the render, so the job summary reads as a transcript. Add to `.github/prompts/board-ci.md` that the final message is the render alone, starting at the mode line, with the would-have-changed list as its last part. Proof: a render-only dispatch (the operator's command: `gh workflow run agent-board.yml --repo polycode-public/concordance -f write-back=false`) whose summary starts at the mode line. **Size** 1 file. **Model** Haiku.

- [ ] **F7. Phase 3 remainder: the precision gap.** Exit: citation precision above 0.85 on `npm run eval -- --provider=bedrock`, figures in the closing commit. Measured 2026-10-21 on the 50-row gold set over 38 statements (`evals/README.md`): `RERANK=off` precision 0.372, recall 0.516, unsupported 0.187, abstention 0.860; `RERANK=model` precision 0.302 at the same recall, so the deploy keeps `RERANK` off. Next: `evals/run.mjs` writes a per-row miss report beside the summary (each cited locator against the row's gold locators: same document and page but another paragraph, another document, or a locator the gold row does not name), run once on Bedrock (about $0.70, a background command, spend in the closing commit), and the fix the report names rides the same branch (a wrong paragraph on the right page points at neighbour expansion in `packages/core/retrieval/`; a wrong document points at the rewrite or the fusion). Horizons: sandbox witnesses ingested before PR #56 carry no aliases until a re-ingest or a backfill; `search_chunks` and the reports ignore the filters and the reranker. **Size** ~4 files. **Model** Opus.

## Machine-ask

- [ ] **O3. The UCPI resume for HN43.** HN43's extraction stopped at 370 assertions over 592 sections after a Bedrock `ServiceUnavailableException`; the resume execution `f06d984e` failed on the $75 models budget, now $100 (deploy run 39607963217). The ask: `aws --profile polycode-sandbox --region eu-west-2 stepfunctions start-execution --state-machine-arn arn:aws:states:eu-west-2:687443513271:stateMachine:IngestStateMachineB1E20B88-cprHyhUIUuRC --input '{"corpus":"ucpi"}'` is an AWS write (the operator's yes); then the session reads HN43's assertion count through the Data API and the deployed line here. **Size** 0 files. **Model** Haiku.

## Human-driven

## Blocked

- [ ] **F8. The checking layer (Phase 4).** Per cited sentence (`splitAnswerSentences` in `packages/core/checks/citations.mjs`): an entailment call through `provider.extractJson` with a `{ verdict: supported | partly | not_supported, span: string }` schema in `packages/core/checks/entailment.mjs`, `verifyQuote` (`packages/core/checks/quotes.mjs`) on quoted text, a number and date guard, the abstention threshold tuned on the F6 gold set; `sessions` and `session_turns` rows (`query_rewrites`, `retrieved_ids`, `reranker_scores`, `prompt_version`, `model_id`, `raw_output`, `checks`) with replay; the `done` frame's `checks.marks` gain verdict and span, and `renderChecked` in `packages/ui/app.js` colours red and shows the span on hover beside the score line. The CI gate: `test.yml` has no Bedrock credentials and no corpus, so `evals/run.mjs` writes `evals/grenfell/scoreboard.json` on the laptop, the row commits it, and an offline test fails when its `citationPrecision` is below `evals/grenfell/floor.json`; a pipeline change re-runs the eval before its push. Exit: the unsupported-sentence rate printed per answer; the gate red when the floor is raised above the scoreboard in a test. Blocked on F7. **Size** ~9 files. **Model** Opus.

- [ ] **F13. The demo and polish (Phase 7).** The slice sized to the $25 cap (its files arrive the O2 way); first token under 2 seconds on the deployed page measured from `status` to the first `token` frame, the paused-cluster resume excluded by a warm-up turn; the eval scoreboard page; the slides with the three lines; a screen recording as the fallback; the dry run. Exit: the demo script recorded end to end on the deployed page. Blocked on F8. **Size** ~6 files. **Model** Sonnet.

## Discipline

- Rows carry only what is open. Close a row in the commit that finishes it.
- A bug found while working row A is A's remainder, not a new row, unless it is separate work; say so when it is.
- Read the inbox before every dispatch, merge, push and poll; any message saying stop, exit, cool down or asking a direct question ends the current step at once.
- When editing a row, use the Edit tool on its own paragraph, never by line-number spans; count rows before and after with `grep -c '^- \[ \] \*\*'`; run `npx prettier --write NEXT.md`, `npx prettier --check NEXT.md` and `npx vitest run test/repo/nextShape.test.mjs` before `git commit`, and refuse the commit if any check fails.
- A batch is pushed only after its check log shows `check:all exit 0`; a log without the line is a failed check.
- The integration proof is `main`'s `deploy.yml` run and its smoke step; a row that touches the ingest or query path runs the offline suite and the unit tests on the seam it changes. The Postgres and Ollama tiers run only for a laptop-port row. A row that invokes Bedrock names the profile and the number of calls in its brief and records the spend in its closing commit.
- Every sub-agent brief carries: the worktree path and branch (`scripts/worktree-add.sh`), `cd <worktree>` in every Bash call and absolute paths in every file tool; the licence header on new files; no plan, row, date or operator reference in comments or test names; `npx eslint` and `npx prettier --check` on its files, `npx cdk synth --quiet` when `infra/` changed, `bash -n` and `shellcheck` on scripts; `git add` only its own files; commit before a long verification; a wait is a sleep loop inside one Bash call; push nothing, open nothing, never call the Agent tool, never edit `NEXT.md`; report back the branch, worktree, commits, files, proof lines and anything undone.
