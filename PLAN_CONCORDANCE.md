<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# PLAN_CONCORDANCE: the witness research tool, AWS first

The plan of record for this repository. The specification it delivers is
`docs/SPEC_WITNESS_RESEARCH_TOOL.md` (Antony, 2026-10-18), kept verbatim; this plan orders it into
phases, fixes the decisions taken, and names the exit test of each phase. Open rows live in
`NEXT.md`; a row names the phase it belongs to.

## Operator assertions (verbatim, binding)

- "Are you trying to build the local solution? If so stop, remove those task from the board and
  make a note that the local solution plan is only needed to ensure the AWS solution is feasible
  to be ported locally. You don't need to revert all related code but do ditch anything that will
  slow down iterations on the AWS version." (2026-10-18, evening). This supersedes the morning's
  "We will just be building 'Laptop port (MacBook Pro, 64 GB or more)' here": the AWS form is the
  build; the laptop form is the port check.
- "deploy to the polycode-sandbox account like we did for chat-with-diya-gl" (2026-10-18).
- "Please have a Fable-sub-agent reviewing the web ui and not only improving what's there but finding
  ideal ways to present what we have and what we plan to add. Do a survey of what's in docs or
  implemented for the current ui and pull that all into the review with the outcome being changed
  existing code and docs and new tasks on the board and we should but skills to work from
  /frontend-design:frontend-design and /ui-ux-pro-max and also swith over to use the chat from
  ../../polycode-unpublished/chat-with-diya-gl (if we are not already) and add tasks to bring over a
  view buts from that that could be useful such as building a database of conversations and the
  bedrock spend banner and the ability to create docs." (2026-10-19). The chat there is React with
  Vite under a proprietary licence; this repository's raw-ESM and AGPL decisions yield to the
  operator's direction where the review (U1) shows the adoption pays, with the licence change named.
- "Add a feature to the board to be able to request a report is created from the current session,
  on a topical subset and referencing documents - similar to a chat completion, this a longer form
  one shot with an internal: draft, write, and review cycle to generate a report similar to how we
  have "Referenced documents / No document cited yet. / Evidence this turn / Ask a question to
  retrieve evidence." but a new one "Generated reports" and these can be deleted from the UI with a
  confirmation and edited by asking in the chat (which is the same review cycle but with a prompt of
  the change) and a matching filename to an existing report so a new version is created (also
  reports are versioned)." (2026-10-19, evening; Phase R, row R1.)
- "Please add a task to lean towards this in terms of look and accessibility standards
  https://www.icc-cpi.int/ (possibly spawning additional tasks)" (2026-10-19, evening; row U10).
- From the specification's scope line: "single-tenant demo, Grenfell only, about 15,000 pages plus
  media transcribed on the laptop, cloud ingest spend capped at $25 with a billing alarm, no real
  ICC evidence touches the system."
- From the specification's critique: "Lead with contradictions, not chat." "Air-gap is a feature,
  not a port. Build the local path first with a 7B model, then swap in Bedrock for the demo; the
  reverse order leaves prompts tuned for a model the court cannot run. Keep an `evals/` run that
  passes on both providers." The operator's direction above sets the order the other way; the
  `evals/` run on both providers is what keeps the port honest (Phase L).
- The three lines for the slide: "evidence is never altered, every claim links to a locator, and
  every automated judgment is reversible by a person."

## What is built

One Postgres (pgvector, tsvector, an assertions table) behind a provider-neutral core:

| Lane   | Components                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ingest | fetch with hash and licence, format classify, extract to canonical text with position maps, witness register, section split, header, four chunk levels, embed, extract assertions                                                          |
| Store  | `documents`, `witnesses`, `chunks` (document, section, passage, sentence), `entities`, `events`, `assertions`, `accepted_facts`, `assertion_comparisons`, `provenance`, `sessions`, `session_turns`                                        |
| Serve  | rewrite, lexical + vector, RRF, rerank, neighbour expansion, evidence blocks, answer, resolve citations, checks (citation per sentence, entailment, quotes, numbers, abstention), WebSocket protocol with cancel and threads, raw ESM page |

Every box has an AWS form and a laptop form selected by configuration. The AWS form is built and
deployed (`PLAN_AWS_SANDBOX.md`); the laptop form exists to show the AWS form ports to a machine
the court can run (`PLAN_LAPTOP_STACK.md`). Three seams carry the port: models through
`packages/core/providers/modelProvider.mjs`, the store through the `{ query, close }` shape of
`packages/core/db.mjs`, text extraction through `textTool`.

## Decisions (2026-10-18)

| Decision                      | Choice                                                                                                                                                                       | Alternative considered                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Name                          | `concordance`: an index of every word in a corpus, and agreement between witnesses                                                                                           | witness-loom, attestor                                                                  |
| Language                      | Plain JS ES modules everywhere, including CDK (`infra/*.mjs`) in the-mechanical-code-talker's structure                                                                      | CDK in TypeScript (tmct's own language); CDK in Java/Maven (the polycode house default) |
| Package layout                | One root `package.json`; `packages/core`, `packages/aws`, `packages/local`, `packages/ui` are plain directories                                                              | npm workspaces                                                                          |
| Vector store                  | Postgres 16, pgvector 0.8, `halfvec(1024)` with HNSW cosine; `tsvector` for lexical                                                                                          | LanceDB; OpenSearch; S3 Vectors with DynamoDB (loses SQL over assertions)               |
| Store on AWS                  | Aurora Serverless v2, 0 ACU minimum, the RDS Data API; Lambda outside the VPC (`PLAN_AWS_SANDBOX.md`)                                                                        | RDS instance (costs at idle); Lambda in the VPC with NAT                                |
| Compute on AWS                | Lambda Node 24 arm64 zip bundles, API Gateway WebSocket and HTTP API, Step Functions, CloudFront and S3, Cognito for one user                                                | containers on ECS or App Runner                                                         |
| Models on AWS                 | Bedrock: Titan Text Embeddings v2 (1024-dim), the `eu.` Haiku 4.5 profile for extraction and checks, the `eu.` Sonnet 4.5 profile for the turn                               | Cohere Embed v3 (marketplace subscription)                                              |
| Provider seam                 | `bedrock` built first (C1); `laptop` (Ollama, from Phase 0) is the port check                                                                                                | laptop first                                                                            |
| Laptop models                 | `bge-m3` (1024-dim), `qwen2.5:7b-instruct` on this 64 GB Intel i9; sized to a demo laptop if one is named                                                                    | `nomic-embed-text` (English only)                                                       |
| Acceptance test               | `npm run eval -- --provider=<p>`; gold rows from the inquiry report's own findings with locators                                                                             |                                                                                         |
| Licence                       | AGPL-3.0-only (the polycode-public house convention)                                                                                                                         | MIT                                                                                     |
| Chat Ledger code (2026-10-19) | Copied from `chat-with-diya-gl` without a licence clause: the operator is its sole author and it has not been shared; it enters under AGPL-3.0-only like any other file here | Port the patterns only; a provenance clause on each copied file                         |
| SPARQL and voice (2026-10-19) | SPARQL served live from a Lambda (Oxigraph WebAssembly over the RDF-star export) and voice input through Amazon Transcribe streaming (whisper.cpp on the laptop port)        | Export only; no voice                                                                   |
| Visibility (2026-10-19)       | Public after a secrets pass over history, now (H1 on the board)                                                                                                              | Private through the demo                                                                |
| Sandbox account (2026-10-19)  | Stay in polycode-sandbox and raise its monthly cap (O3 on the board)                                                                                                         | An account of its own in the Workloads OU                                               |
| Delivery                      | The factory from submit.diyaccounting.co.uk (`/iterate`, `/do-next`, `/board`, `/watch`, `/auto-merge`)                                                                      |                                                                                         |

## Phases

Each phase is shippable. The exit test of every phase from Phase 1 runs deployed with
`MODEL_PROVIDER=bedrock`; `main`'s `deploy.yml` run is the integration proof. The
specification's week numbers are the budget.

### Phase 0: foundations

On `main`: the repository, the factory skills, `test.yml`, `deploy.yml`, the schema `0001`, the
provider seam with the Ollama implementation, chunking and check primitives, the WebSocket server
with cancel, the page with a PDF viewer, the eval runner, the corpus rules, ingest v1 and query v1,
the two thin sandbox stacks.

### Phase 1: the AWS runtime (C1 to C5)

The Bedrock provider; Aurora Serverless v2 with pgvector behind the Data API and the migrations run
at deploy; the WebSocket turn, the document route, the page on CloudFront, one Cognito user; the
ingest state machine; the deployed smoke. Exit: a turn over the empty store answers from the
CloudFront page with the abstention phrase; `deploy.yml` and its smoke step green on `main`.

### Phase 2: corpus (F3, F4b)

The Grenfell importer over the files O2 delivers, the manifest, the upload to the originals
bucket, the first ingest execution. Exit: 20 statements in Aurora; a second execution changes no
row counts; then 300. Ten statements are in Aurora (2026-10-19) and serve Phases 3 to 5 until W1
widens the corpus; the second execution proved the idempotence.

### Phase 3: retrieval and citations (F5b, F6, F7)

Query rewrite, `tsvector` with register expansion and exact-phrase search, HNSW top 40 passages and
top 20 sections, RRF, reranker, neighbour expansion with a 6,000-token cap, evidence blocks
`[E1]…[E12]`, server-side resolution to locators, the PDF.js viewer at the locator with the span
highlighted, filters. Exit: 50 gold questions, citation precision above 0.85 with
`--provider=bedrock`.

### Phase 4: checking layer (F8)

Sentence split, the entailment call per cited sentence, quote verification, the number and date
guard, the abstention threshold tuned on the gold set, the session log and replay, the score line
on the page. Exit: unsupported-sentence rate reported per answer; `test.yml` fails when citation
precision on the gold set drops below the committed floor.

### Phase 5: facts and consistency (F9, F10, F11)

Assertion extraction with a JSON schema that forbids values absent from the text, the entity and
event registers, alignment by claim similarity and entity overlap, NLI labelling, grouping, the
contradiction matrix, self-consistency ordered by statement date, accepted facts with promotion and
session hypotheses, the timeline view, RDF-star export and live SPARQL from a Lambda. Exit: the known Grenfell timing disputes
appear in the matrix without hand-tuning.

### Phase 6: conversation layer and media (F12)

Threads and forks with their own filters and session facts, interruption mid-stream, voice input
through Transcribe streaming, Transcribe
transcripts with word timestamps as derived objects, the media player with transcript sync and
seek, the image viewer with boxes, export of the transcript with its bibliography. Exit: the
10-step demo script runs end to end on the deployed page.

### Phase 7: demo and polish (F13)

The slice sized to the $25 cap, first token under 2 seconds on the deployed page, the eval
scoreboard, the slides, the screen recording as the fallback, the dry run. Exit: the demo script
recorded end to end.

### Phase R: generated reports (R1)

A report is a one-shot, longer-form answer over a topical subset of the corpus, built in one
request through an internal draft, write and review cycle, stored with versions, and shown in a
"Generated reports" panel beside "Referenced documents" and "Evidence this turn".

- Request: from the chat, a `report` frame with the topic (a question or brief), the document ids
  it may draw on (empty means the whole corpus), and a filename. The turn Lambda's async shape
  runs it; status frames name the stage (`drafting`, `writing`, `reviewing`, `done`).
- Cycle: **draft** retrieves over the topic (the Phase 3 retrieval, more hits and a larger context
  budget than a turn) and writes an outline whose every heading names its evidence blocks;
  **write** produces the report section by section from those blocks, every sentence cited with
  `[En]`, "the corpus does not say" for a section the blocks do not cover; **review** runs the
  Phase 4 checks over every sentence and sends the flagged sentences back for one rewrite, then
  stores the result with its check scores. The model never writes a citation string; the server
  resolves `[En]` to locators as it does for a turn.
- Store: a `reports` table (session, filename, version, title, topic, document ids, body as
  Markdown with `[En]`, the resolved citations as jsonb, the check scores, prompt version, model
  id, created at), unique on session, filename and version. A request whose filename matches an
  existing report in the session runs the same cycle with the change prompt and the latest version
  as input and stores version n+1. Delete removes every version of a filename.
- Page: the "Generated reports" panel lists filenames with their versions; opening one renders the
  Markdown with each citation as a locator link into the viewer; a Delete control asks for
  confirmation first; the request form takes topic, documents and filename. A chat message that
  names an existing filename is an edit request.
- Routes: HTTP `GET /reports`, `GET /reports/{filename}` (versions), `DELETE /reports/{filename}`;
  the WebSocket carries the request and the status frames. Export (F12's bibliography shape)
  includes reports.

Exit: on the deployed page, a report over two named statements is requested, written, reviewed
and listed; an edit by chat stores version 2; delete removes it after confirmation; every
sentence in the stored report carries a resolved citation or the abstention phrase.

### Phase L: the laptop port check (L1)

The laptop form is proven, never built ahead of its AWS form. The path there runs through the
image and the Fargate and EC2 rigs of `PLAN_LAPTOP_STACK.md` (P1 to P3). When the operator names a
machine:
Postgres in Docker, Ollama, the same migrations and the same core modules, `npm run eval --
--provider=laptop` within the gold set's tolerance of the Bedrock scores. A gap is a prompt or a
model-size finding, recorded in `PLAN_LAPTOP_STACK.md`.

## Evals and gates

- Gold rows: `evals/<corpus>/gold.jsonl`, `{ id, question, gold_locators, expected }`, built from
  the inquiry report's own findings. 150 rows per corpus is the target; 20 is the first set (F6).
- Metrics: citation precision, citation recall, unsupported-sentence rate, abstention correctness.
- Gates: the offline vitest tier on every push; `deploy.yml` with its smoke step on `main`; the
  eval scoreboard committed from Phase 4, failing `test.yml` when citation precision falls below
  the floor.

## Scope held back (decisions, with the phase that revisits them)

Video face blurring, multilingual embeddings, entity resolution across corpora, the second corpus (Bloody Sunday, then the Afghanistan inquiry for cipher mode): the
roadmap slide, revisited after Phase 7.

## Open questions

| Key | Question                                                                                                                                                                                                            | Decides                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| O1  | A fine-grained token for the agent workflows                                                                                                                                                                        | when the agent workflows leave dispatch-only |
| O2  | How the Grenfell PDF bytes arrive: the catalogue index comes from the Discovery API (series GTI 2); the files by browser from the record pages, or by fetcher if a record's download URL is stable and unchallenged | the Phase 2 import                           |

## Related documents

- `docs/SPEC_WITNESS_RESEARCH_TOOL.md`: the specification, verbatim.
- `PLAN_AWS_SANDBOX.md`: the AWS form of each component, the account facts, the deploy path.
- `PLAN_LAPTOP_STACK.md`: the laptop port check: runtime, models, measurements.
- `AWS_ACCOUNT.md`: the account record.
- `~/projects/polycode-public/repository0/PLAN_REPOSITORY_ZERO_REBOOT.md`: how this repository was
  initialised, for the template that will do it next time.
