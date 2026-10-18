<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# NEXT

Open work only. A row leaves this file in the same commit that closes it; completed work lives in `git log`. The plan of record is `PLAN_CONCORDANCE.md`; the local runtime is `PLAN_LAPTOP_STACK.md`; the sandbox is `PLAN_AWS_SANDBOX.md`. Each row ends with **Size** (files touched, estimated) and **Model** (the lowest sub-agent tier that fits: Fable, Opus, Sonnet, Haiku; `operator` for a human row).

The board runs in five sections, in this order. The section is the classification: what it takes to carry the row to completion. `machine-ask` is work a session drives with a human present to authenticate or approve (an SSO login, an AWS write, a GitHub setting, a brew install). `human-driven` is work a person must do themselves (a decision between named alternatives, a purchase, a signature).

**Deployed:** `concordance-sandbox-data` (bucket `concordance-sandbox-data-corpusbucket36de2aaa-7jolgc2qi4a4`) and `concordance-sandbox-guardrails` (budget `concordance-sandbox-monthly`, $25; kill switch `/concordance/sandbox/agents/kill-switch` = `off`) in polycode-sandbox, from `deploy.yml` run 39127857512 of `1890926` (2026-10-18). `main` carries Phase 0 (the factory, `test.yml`, `deploy.yml`, the schema, the Ollama provider, the WebSocket server with cancel, the minimal page, the eval runner). **GitHub:** `github.com/polycode-public/concordance` (private); variable `CONCORDANCE_DEPLOY_ROLE_ARN`; environment `sandbox` deploys from `main` only.

## In flight

## Machine-only

- [ ] **F1. Postgres up and the schema proven (Phase 1).** `npm run db:up`, `npm run db:migrate`, then the opt-in Postgres test tier (`CONCORDANCE_DB_TESTS=1`): the `vector` extension present, one document with four chunk levels inserted with 1024-dim `halfvec` embeddings, a cosine top-k query and a `tsv` query each returning the right chunk, `prev_id`/`next_id` resolving, and a second `db:migrate` applying nothing. Record the pgvector version in `PLAN_LAPTOP_STACK.md`. **Size** ~3 files. **Model** Sonnet.

- [ ] **F2. The laptop models pulled and measured (Phase 0).** `npm run models:pull` (bge-m3 about 1.2 GB, qwen2.5:7b-instruct about 4.7 GB), then the opt-in Ollama tier (`CONCORDANCE_OLLAMA_TESTS=1`): embed 10 strings and check the dimension is 1024, stream one chat turn and cancel it mid-stream through the provider's `signal`. Measure on this machine: chunks a minute embedded over 200 passages, first token and tokens a second for a 300-token answer, and write the row into `PLAN_LAPTOP_STACK.md`'s measurements table. If the reranker is not served by Ollama, say so in the table and leave the Phase 2 choice open. **Size** ~3 files. **Model** Sonnet.

- [ ] **F3. The Grenfell fetcher, first slice (Phase 1).** `corpora/grenfell/fetch.mjs`: reads `corpora/grenfell/sources.toml` (an allowlist of witness-evidence pages under `https://www.grenfelltowerinquiry.org.uk/`), honours `robots.txt`, one request a second, writes each PDF untouched to `raw/<evidence-id>.pdf`, and appends to `manifest.jsonl` the url, fetch time, HTTP headers, SHA-256, bytes, licence (OGL v3) and evidence id (`IWS…`); idempotent by SHA-256. First slice: 20 resident witness statements from floors 16 to 20, chosen from the inquiry's witness index, with the choice recorded in `sources.toml`. Unit tests on the manifest writer and the id parser with inline fixtures; the fetch itself runs once by hand and is a background command. **Size** ~5 files. **Model** Sonnet.

- [ ] **F4. Ingest v1 into Postgres (Phase 1).** `packages/core/ingest/run.mjs --corpus grenfell`: for each manifest row, `pdfToPages`, the document header from the statement's first page (witness id, date, role from `sources.toml` until the register exists), `splitNumberedParagraphs` for sections, `slidingPassages` and `splitSentences` below them, the bracket header on every chunk, the context line written by `EXTRACT_MODEL`, embeddings from `EMBED_MODEL`, `prev_id`/`next_id`, locators `{ page, paragraph }`, provenance rows from the PDF's SHA-256 to each derived text, `pipeline_version` on every row; idempotent per document by SHA-256 and `pipeline_version`. Exit: the 20 statements from F3 ingested, row counts per level printed, a second run inserting nothing. A design note on the page-to-paragraph locator mapping goes at the top of the file's module doc, not in a plan. Blocked on F1 and F3 landing first in the same batch or earlier. **Size** ~6 files. **Model** Opus.

- [ ] **F5. Query v1 with resolved citations (Phase 2).** `packages/core/query.mjs` replaces the stub: `tsvector` query and HNSW top 40 passages and top 20 sections, `reciprocalRankFusion`, neighbour expansion with the 6,000-token cap, evidence blocks `[E1]…[E12]` with header and locator, the closed-world prompt, `markUnsupported`, and the server-side map from `[En]` to `{ documentId, locator }`; the server's `turn` sends the populated `evidence` frame and the page renders citation chips that open the PDF at the page (PDF.js from a pinned cdnjs URL, highlight in Phase 2's next row). No reranker yet. Exit: three questions about the F3 slice answer with chips that resolve to a page and paragraph in `raw/`. Blocked on F4. **Size** ~8 files. **Model** Opus.

## Machine-ask

- [ ] **A2. The media tools (Phase 5, needed from Phase 1 for video exhibits).** On the operator's yes: `brew install whisper-cpp ffmpeg`, then `whisper-cli --help` and `ffmpeg -version` recorded in `PLAN_LAPTOP_STACK.md`'s install list, and the `large-v3-turbo` model file placed under `models/` (gitignored) with its SHA-256 in the plan. **Size** 1 file. **Model** Haiku.

- [ ] **A4. Tokens for the agent workflows (Phase 0, when the operator wants them).** `agent-board.yml`, `agent-code.yml` and `agent-pr.yml` are dispatch-only until two repository secrets exist: `AGENT_TOKEN` (a fine-grained PAT or GitHub App installation token on this repository with contents: write, pull requests: write, issues: write) and `AUTO_MERGE_TOKEN` (a merge-capable token whose pushes trigger `on: push` workflows). On the operator's go: create them on github.com, `gh secret set AGENT_TOKEN --repo polycode-public/concordance` and `gh secret set AUTO_MERGE_TOKEN --repo polycode-public/concordance` from a file the operator names, then `gh workflow run agent-board.yml -f write-back=false` and read the job summary. The kill switch is the SSM parameter `/concordance/sandbox/agents/kill-switch` from the guardrails stack **Size** 0 files. **Model** Haiku.

## Human-driven

- [ ] **H1. Repository visibility.** The repository is private. The alternatives: keep it private through the demo; or make it public after a `gitleaks detect --source . --log-opts=--all` pass over history and a read of `docs/SPEC_WITNESS_RESEARCH_TOOL.md` for anything about the audience that should not be public. The polycode-public convention is public under AGPL-3.0-only. On "public": `gh repo edit polycode-public/concordance --visibility public --accept-visibility-change-consequences`. **Size** 0 files. **Model** operator.

- [ ] **H2. The demo machine.** The specification's open question: whether the ICC developer's machine has 64 GB or more, and whether it is M-series. This dev machine is a 64 GB Intel i9 with CPU-only inference. The answer sets the chat model (7B on Intel, 14B Q4 on M-series), the first-token budget and the size of the Wi-Fi-off slice; it goes into `PLAN_LAPTOP_STACK.md`'s models table. **Size** 1 file. **Model** operator.

- [ ] **H3. SPARQL and voice.** The specification's other two open questions: whether SPARQL must be served live (Oxigraph) or an RDF-star export is enough (Phase 4), and whether the audience works by voice (Phase 5). Default on silence: export only, no voice. **Size** 1 file. **Model** operator.

## Blocked

- [ ] **F6. The first gold set and a scored eval (Phase 2).** 20 rows in `evals/grenfell/gold.jsonl` built from the Phase 1 report's findings about the F3 witnesses, each with the report paragraph and the statement locator; `npm run eval -- --provider=laptop` prints the four metrics for them; the figures go into the row's closing commit message, not a plan. Blocked on F5. **Size** ~2 files. **Model** Sonnet.

## Discipline

- Rows carry only what is open. Close a row in the commit that finishes it.
- A bug found while working row A is A's remainder, not a new row, unless it is separate work; say so when it is.
- Read the inbox before every dispatch, merge, push and poll; any message saying stop, exit, cool down or asking a direct question ends the current step at once.
- When editing a row, use the Edit tool on its own paragraph, never by line-number spans; count rows before and after with `grep -c '^- \[ \] \*\*'`; run `npx prettier --write NEXT.md`, `npx prettier --check NEXT.md` and `npx vitest run test/repo/nextShape.test.mjs` before `git commit`, and refuse the commit if any check fails.
- A batch is pushed only after its check log shows `check:all exit 0`; a log without the line is a failed check.
- A row that touches the ingest or query path runs the Postgres tier before its push; a row that calls a model runs the Ollama tier and names the model and the number of calls in its brief.
- Every sub-agent brief carries: the worktree path and branch (`scripts/worktree-add.sh`), `cd <worktree>` in every Bash call and absolute paths in every file tool; the licence header on new files; no plan, row, date or operator reference in comments or test names; `npx eslint` and `npx prettier --check` on its files, `npx cdk synth --quiet` when `infra/` changed, `bash -n` and `shellcheck` on scripts; `git add` only its own files; commit before a long verification; a wait is a sleep loop inside one Bash call; push nothing, open nothing, never call the Agent tool, never edit `NEXT.md`; report back the branch, worktree, commits, files, proof lines and anything undone.
