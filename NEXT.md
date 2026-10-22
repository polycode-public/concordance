<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# NEXT

Open work only. A row leaves this file in the same commit that closes it; completed work lives in `git log`. The plan of record is `PLAN_CONCORDANCE.md`; the AWS form is `docs/archive/PLAN_AWS_SANDBOX.md`; the laptop port check is `PLAN_LAPTOP_STACK.md`. Each row ends with **Size** (files touched, estimated) and **Model** (the lowest sub-agent tier that fits: Fable, Opus, Sonnet, Haiku; `operator` for a human row).

The board runs in five sections, in this order. The section is the classification: what it takes to carry the row to completion. `machine-ask` is work a session drives with a human present to authenticate or approve (an SSO login, an AWS write outside `deploy.yml`, a GitHub setting). `human-driven` is work a person must do themselves (a decision between named alternatives, a purchase, a signature).

**Deployed:** six stacks in polycode-sandbox, the newest from `deploy.yml` run 39784876418 of `3d66c8c7` (2026-10-22: PR #77, the first-token measure and `docs/DEMO.md`), after PR #76 (every resource tagged `concordance=sandbox`) and PR #74 (prompt `answer-closed-world-v5`). Budgets: $175 a month each (PR #69); the models budget filters on the `project` tag and reads $0 until tagged spend reaches Cost Explorer. Store: 38 Grenfell statements with 9,261 assertions and 10 UCPI statements with 3,383.

## In flight

## Machine-only

- [ ] **A9. Prove the tagged model calls in Cost Explorer.** On `main` since PR #71 and PR #73: the stack `concordance-sandbox-model-profiles` holds three application inference profiles tagged `project=concordance` (chat, extract, embed); the Lambdas call them through `BEDROCK_*_PROFILE_ARN` (deploy run of `29722fdc`, 2026-10-22, smoke green); the eval refuses a Bedrock run without them; the batch job runs through the extract profile with the tag; `concordance-sandbox-models` filters on the Bedrock services and the tag. Remainder: read Cost Explorer for the Bedrock services grouped by `TAG project` (`aws ce get-cost-and-usage --time-period Start=2026-10-22,End=2026-10-24 --granularity DAILY --metrics UnblendedCost --filter '{"Dimensions":{"Key":"SERVICE","Values":["Claude Sonnet 4.5 (Amazon Bedrock Edition)","Claude Haiku 4.5 (Amazon Bedrock Edition)","Amazon Bedrock"]}}' --group-by Type=TAG,Key=project`) and the models budget's actual spend; the tag line must carry the turns and evals after the deploy of `29722fdc`. `project` is an active cost allocation tag since 2026-10-18 (`ce list-cost-allocation-tags`). **Size** 0 files. **Model** Sonnet.

## Machine-ask

## Human-driven

## Blocked

- [ ] **A15. Activate `concordance` as a cost allocation tag.** The operator's word (2026-10-22): `concordance` is to be an active cost allocation tag. `aws --profile polycode-management ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=concordance,Status=Active` refused it ("Tag keys not found: concordance") because no resource carried the key; PR #76 tags every resource with `concordance=sandbox`. Remainder: after PR #76 deploys, check for the key with `aws --profile polycode-management ce list-cost-allocation-tags --tag-keys concordance` (the key appears within about a day of the first tagged usage), then run the activation command above and read the status back. Blocked on the key reaching the billing data. **Size** 0 files. **Model** Haiku.

## Discipline

- Rows carry only what is open. Close a row in the commit that finishes it.
- A bug found while working row A is A's remainder, not a new row, unless it is separate work; say so when it is.
- Read the inbox before every dispatch, merge, push and poll; any message saying stop, exit, cool down or asking a direct question ends the current step at once.
- When editing a row, use the Edit tool on its own paragraph, never by line-number spans; count rows before and after with `grep -c '^- \[ \] \*\*'`; run `npx prettier --write NEXT.md`, `npx prettier --check NEXT.md` and `npx vitest run test/repo/nextShape.test.mjs` before `git commit`, and refuse the commit if any check fails.
- A batch is pushed only after its check log shows `check:all exit 0`; a log without the line is a failed check.
- The integration proof is `main`'s `deploy.yml` run and its smoke step; a row that touches the ingest or query path runs the offline suite and the unit tests on the seam it changes. The Postgres and Ollama tiers run only for a laptop-port row. A row that invokes Bedrock names the profile and the number of calls in its brief and records the spend in its closing commit.
- Every sub-agent brief carries: the worktree path and branch (`scripts/worktree-add.sh`), `cd <worktree>` in every Bash call and absolute paths in every file tool; the licence header on new files; no plan, row, date or operator reference in comments or test names; `npx eslint` and `npx prettier --check` on its files, `npx cdk synth --quiet` when `infra/` changed, `bash -n` and `shellcheck` on scripts; `git add` only its own files; commit before a long verification; a wait is a sleep loop inside one Bash call; push nothing, open nothing, never call the Agent tool, never edit `NEXT.md`; report back the branch, worktree, commits, files, proof lines and anything undone.
