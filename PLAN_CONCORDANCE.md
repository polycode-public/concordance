<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# PLAN_CONCORDANCE: the witness research tool, laptop first

The plan of record for this repository. The specification it delivers is
`docs/SPEC_WITNESS_RESEARCH_TOOL.md` (Antony, 2026-10-18), kept verbatim; this plan orders it into
phases, fixes the decisions taken at initialisation, and names the exit test of each phase. Open
rows live in `NEXT.md`; a row names the phase it belongs to.

## Operator assertions (verbatim, binding)

- "We will just be building 'Laptop port (MacBook Pro, 64 GB or more)' here" (2026-10-18).
- "deploy to the polycode-sandbox account like we did for chat-with-diya-gl" (2026-10-18).
- From the specification's scope line: "single-tenant demo, Grenfell only, about 15,000 pages plus
  media transcribed on the laptop, cloud ingest spend capped at $25 with a billing alarm, no real
  ICC evidence touches the system."
- From the specification's critique: "Lead with contradictions, not chat." "Air-gap is a feature,
  not a port. Build the local path first with a 7B model, then swap in Bedrock for the demo; the
  reverse order leaves prompts tuned for a model the court cannot run. Keep an `evals/` run that
  passes on both providers."
- The three lines for the slide: "evidence is never altered, every claim links to a locator, and
  every automated judgment is reversible by a person."

## What is built

One Postgres (pgvector, tsvector, an assertions table) behind a provider-neutral core:

| Lane   | Components                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ingest | fetch with hash and licence, format classify, extract to canonical text with position maps, witness register, section split, header, four chunk levels, embed, extract assertions                                                          |
| Store  | `documents`, `witnesses`, `chunks` (document, section, passage, sentence), `entities`, `events`, `assertions`, `accepted_facts`, `assertion_comparisons`, `provenance`, `sessions`, `session_turns`                                        |
| Serve  | rewrite, lexical + vector, RRF, rerank, neighbour expansion, evidence blocks, answer, resolve citations, checks (citation per sentence, entailment, quotes, numbers, abstention), WebSocket protocol with cancel and threads, raw ESM page |

Every box has a laptop form and an AWS form selected by configuration (`PLAN_LAPTOP_STACK.md`,
`PLAN_AWS_SANDBOX.md`).

## Decisions taken at initialisation (2026-10-18)

| Decision            | Choice                                                                                                     | Alternative considered                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Name                | `concordance`: an index of every word in a corpus, and agreement between witnesses                         | witness-loom, attestor                                                                  |
| Language            | Plain JS ES modules everywhere, including CDK (`infra/*.mjs`) in the-mechanical-code-talker's structure    | CDK in TypeScript (tmct's own language); CDK in Java/Maven (the polycode house default) |
| Package layout      | One root `package.json`; `packages/core`, `packages/local`, `packages/ui` are plain directories            | npm workspaces                                                                          |
| Vector store        | Postgres 16, pgvector 0.8, `halfvec(1024)` with HNSW cosine; `tsvector` for lexical                        | LanceDB; OpenSearch                                                                     |
| Provider seam       | `packages/core/providers/modelProvider.mjs`; `laptop` (Ollama) built first; `bedrock` a stub until Phase 7 | Bedrock first                                                                           |
| Laptop models, dev  | `bge-m3` (1024-dim), `qwen2.5:7b-instruct` for chat and extraction, on a 64 GB Intel i9 (CPU)              | `nomic-embed-text` (English only), 14B chat (too slow on CPU)                           |
| Laptop models, demo | Sized to the demo machine once known (H2): 14B Q4 chat on M-series, `bge-reranker-v2-m3`                   |                                                                                         |
| Acceptance test     | `npm run eval -- --provider=<p>`; gold rows from the inquiry report's own findings with locators           |                                                                                         |
| AWS now             | Two thin stacks: an originals bucket (off-site copy) and a $25 monthly budget; deploy by GitHub OIDC       | No AWS until Phase 7                                                                    |
| Licence             | AGPL-3.0-only (the polycode-public house convention)                                                       | MIT                                                                                     |
| Visibility          | Private until the operator decides (H1): a secrets pass over history and a read of the spec doc first      | Public from the first push                                                              |
| Delivery            | The factory from submit.diyaccounting.co.uk (`/iterate`, `/do-next`, `/board`, `/watch`, `/auto-merge`)    |                                                                                         |

## Phases

Each phase is shippable. The laptop path is tested from Phase 0; the exit test of every phase runs
with `MODEL_PROVIDER=laptop`. The specification's week numbers are kept as the budget.

### Phase 0: foundations (this initialisation)

Repository, factory skills, `test.yml`, `deploy.yml`, Postgres compose and schema `0001`, the
provider interface with the Ollama implementation, chunking and check primitives with unit tests,
the WebSocket server with cancel, the minimal page, the eval runner, the corpus rules. Exit:
`npm run check:all` green on `main`; `npm run dev` answers a turn through Ollama with status, token
and done frames; the sandbox stacks deploy from `main` once the OIDC role exists (A1).

### Phase 1: corpus and schema (weeks 1 to 2)

The Grenfell fetcher (witness statements first, then video exhibits) with hashing and licence
capture into `corpora/grenfell/manifest.jsonl`; `pdftotext` extraction with page maps; the witness
register with cipher-only mode; numbered-paragraph sections; the four chunk levels with the bracket
header and the model-written context line; embeddings; `pipeline_version` on every row;
provenance rows. Exit: 300 statements ingested locally; a second run changes no row counts; the
Postgres test tier passes.

### Phase 2: retrieval and citations (weeks 3 to 4)

Query rewrite from the last three turns, `tsvector` with register expansion and exact-phrase
search, HNSW top 40 passages and top 20 sections, RRF, reranker, neighbour expansion with a
6,000-token cap, evidence blocks `[E1]…[E12]`, server-side resolution to locators and the
referenced-documents panel, PDF.js viewer opening at the locator with the span highlighted,
filters. Exit: 50 gold questions, citation precision above 0.85 on the laptop provider.

### Phase 3: checking layer (week 5)

Sentence split, the entailment call per cited sentence, quote verification, the number and date
guard, the abstention threshold tuned on the gold set, the session log and replay, the score line
on the page. Exit: unsupported-sentence rate reported per answer; `test.yml` fails when citation
precision on the gold set drops.

### Phase 4: facts and consistency (weeks 6 to 8)

Assertion extraction with a JSON schema that forbids values absent from the text, the entity and
event registers, alignment by claim similarity and entity overlap, NLI labelling (DeBERTa-v3 MNLI
locally), grouping, the contradiction matrix, self-consistency ordered by statement date, accepted
facts with promotion and session hypotheses, the timeline view, RDF-star export. Exit: the known
Grenfell timing disputes appear in the matrix without hand-tuning.

### Phase 5: conversation layer and media (weeks 9 to 10)

Threads and forks with their own filters and session facts, interruption mid-stream, media
transcripts with word timestamps from whisper.cpp uploaded as derived files, the media player with
transcript sync and seek, the image viewer with boxes, export of the transcript with its
bibliography. Exit: the 10-step demo script runs end to end on the laptop.

### Phase 6: laptop demo and polish (weeks 11 to 12)

The 2,000-page slice for the Wi-Fi-off demo, first token under 2 seconds on the demo machine, the
eval scoreboard, the slides, the screen recording as the fallback, the dry run. Exit: the demo
script recorded end to end offline.

### Phase 7: the AWS form (after the laptop demo, or alongside it on the operator's word)

Bedrock provider (Cohere Embed v3 or Titan v2, Haiku for extraction and checks, Sonnet for the
turn), Aurora Serverless v2 with the same migrations, Lambda wrappers around the core modules,
Step Functions for the ingest map, SQS between fetch and extract, API Gateway WebSocket with the
per-thread FIFO queue for cancel, CloudFront and S3 for the page, Cognito for one user, signed URLs
for media, the $25 ingest cap read before each batch. Exit: `npm run eval -- --provider=bedrock`
matches the laptop scores within the tolerance the gold set defines. Detail: `PLAN_AWS_SANDBOX.md`.

## Evals and gates

- Gold rows: `evals/<corpus>/gold.jsonl`, `{ id, question, gold_locators, expected }`, built from
  the inquiry report's own findings. 150 rows per corpus is the target; 20 is the first set (F6).
- Metrics: citation precision, citation recall, unsupported-sentence rate, abstention correctness.
- Gates: the offline vitest tier on every push; the Postgres and Ollama tiers on the operator's
  machine before a push that changes the ingest or query path; the eval scoreboard in `test.yml`
  from Phase 3, failing the build when citation precision falls.

## Scope held back (decisions, with the phase that revisits them)

Voice, video face blurring, multilingual embeddings, entity resolution across corpora, SPARQL
served live, the second corpus (Bloody Sunday, then the Afghanistan inquiry for cipher mode): the
roadmap slide, revisited after Phase 6.

## Open questions

| Key | Question                                                                                                                                                                          | Decides                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| H1  | Repository visibility: private, or public after a secrets pass                                                                                                                    | when the repo flips to public                |
| H2  | The demo machine: this Intel i9, or an M-series laptop                                                                                                                            | chat model size, first-token budget, Phase 6 |
| H3  | SPARQL live or export only; voice in the demo or not                                                                                                                              | Phase 4 export, Phase 5 scope                |
| O1  | A fine-grained token for the agent workflows                                                                                                                                      | when the agent workflows leave dispatch-only |
| O2  | How the Grenfell files arrive: the inquiry site is archived at The National Archives (robots disallow, WAF challenge); browser download, session-driven Chrome, or a bulk request | the Phase 1 fetch                            |

## Related documents

- `docs/SPEC_WITNESS_RESEARCH_TOOL.md`: the specification, verbatim.
- `PLAN_LAPTOP_STACK.md`: the local runtime, models, ports, measurements.
- `PLAN_AWS_SANDBOX.md`: the thin sandbox stack now, the port later, the account facts.
- `AWS_ACCOUNT.md`: the account record.
- `~/projects/polycode-public/repository0/PLAN_REPOSITORY_ZERO_REBOOT.md`: how this repository was
  initialised, for the template that will do it next time.
