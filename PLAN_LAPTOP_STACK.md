<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# PLAN_LAPTOP_STACK: the laptop port check

This plan exists to show that the AWS form (`PLAN_AWS_SANDBOX.md`, the build) ports to a machine
the court can run. Nothing here is built ahead of its AWS form; the laptop form of a component is
exercised when the port is checked (`PLAN_CONCORDANCE.md`, Phase L: `npm run eval --
--provider=laptop` within the gold set's tolerance of the Bedrock scores). The components, models,
ports and measurements below are the facts that check needs.

## Operator assertions (verbatim, binding)

- "To inform the eventual swap to running on a single machine with locl models, would it be
  feasible to build the current solution as a Docker images and use that same image for Lambdas
  running code on the image which crafts and http call to hit a local express, and then we can try
  variations such as: serverless re-using the image, Fargate ingesting from s3 and running a local
  db, EC2 mounting a volume (the last being a near drop in for a docker compose mounting a local
  directory (of evidence) as a volume and exposing a local http server to the host." (2026-10-19,
  evening)
- "We'll also transition from lambda+bedrock to a local model on fargate and ec2 tollerating a
  longer start time to pull in the parameters as we move lambda->fargate->ec2." (2026-10-19,
  evening)

## The path from Lambda to the laptop

One image carries the single-machine form: the entrypoint is `packages/local/server.mjs`, the
corpus directory and the database are volumes, and `MODEL_PROVIDER`, `DATABASE_URL` and
`OLLAMA_URL` select the forms. Each step below moves one thing: first the packaging, then the
model, then the hardware. A longer start, while the model parameters are pulled into the rig, is
accepted from P2 on. Every rig is a destroyable stack that is created for a run and removed after
it, with the evidence synced from the originals bucket, so nothing costs money at idle.

| Step | Compute                                              | Models                                                                                                   | Store                                   | Evidence                                  | Start                                            | Proves                                                                                         |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| P0   | Lambda zip bundles (today, `PLAN_AWS_SANDBOX.md`)    | Bedrock                                                                                                  | Aurora Serverless v2 over the Data API  | the originals bucket                      | cold start under a second                        | the AWS form; the build                                                                        |
| P1   | the image on this machine with compose               | Ollama on the host                                                                                       | Postgres with pgvector in a container   | a local directory mounted as a volume     | seconds                                          | the image boots the whole form from one `docker compose up`                                    |
| P2   | Fargate, one task: the server and a Postgres sidecar | Ollama in the task on CPU, the parameters pulled at start; Bedrock as the fallback form for a quick demo | the sidecar on ephemeral or EFS storage | synced from the originals bucket at start | minutes: the image, then the model parameters    | the image runs off the laptop with a local model, however slowly                               |
| P3   | EC2 with a GPU (g5 or g6), compose from user data    | Ollama on the GPU                                                                                        | the Postgres container on an EBS volume | the bucket synced into the volume         | minutes: the instance, the image, the parameters | the near drop-in for compose: a volume of evidence and a local HTTP server exposed to the host |
| L1   | the demo laptop                                      | Ollama with Metal                                                                                        | the Postgres container                  | the directory                             | seconds                                          | `npm run eval -- --provider=laptop` within tolerance (Phase L)                                 |

Facts that bound the steps:

- Lambda runs no local model: no GPU, 10 GB of memory, and a multi-gigabyte image on every cold
  start. The image is not used for Lambda; P0 keeps its zip bundles.
- Fargate has no GPU. P2's local model runs at CPU speed: this machine's measurements below (6
  tokens a second, 146 chunks a minute) are the expectation, and the parameters (4.7 GB for
  `qwen2.5:7b-instruct` Q4, 1.2 GB for `bge-m3`) are pulled at every start unless they sit on
  EFS.
- The GPU appears at P3. A g5.xlarge (one A10G, 24 GB) serves a 14B Q4 model at demo speed.
- The protocol does not change: the local server speaks the same frames as the AWS handlers
  (`packages/core/protocol.mjs`), so the page is the same file in every step.

Tasks, each its own board row when pulled:

- **P1. The image and compose.** A `Dockerfile` for the server (Node 24, the page assets staged),
  `docker-compose.yml` extended with the server and Ollama beside Postgres, the corpus directory
  as a volume. Exit: `docker compose up` answers a question from the page on this machine with
  `MODEL_PROVIDER=laptop`. [ready, after D2 and U8 so the image carries a working page]
- **P2. The Fargate rig.** A destroyable stack: one task with the server, a Postgres sidecar and
  Ollama, the evidence synced from the originals bucket at start, an HTTP endpoint for the page.
  Exit: the eval runs in the task with `--provider=laptop` and the wall time and start time are
  recorded below. [blocked, P1]
- **P3. The EC2 GPU rig.** A destroyable stack: a g5 instance, the EBS volume with the evidence,
  compose from user data. Exit: the same eval within tolerance of the Bedrock scores, first token
  and tokens a second recorded below. [blocked, P2]
- **L1. The laptop port check.** Pulled off the board on the operator's word (2026-10-19); it
  returns when P3 is done and a machine is named. `npm run eval -- --provider=laptop` within the
  gold set's tolerance of the Bedrock scores (Phase L). [blocked, P3 and the operator's word]

## Components

| Component | Laptop form                                                                                                                                                                                                          | Where                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Store     | Postgres 16 + pgvector 0.8.7 in Docker (`pgvector/pgvector:pg16`), port 5432                                                                                                                                         | `docker-compose.yml`, `db/migrations/`              |
| Models    | Ollama at `http://localhost:11434` (`/api/embed`, `/api/chat` streaming, JSON mode)                                                                                                                                  | `packages/core/providers/ollamaProvider.mjs`        |
| Reranker  | `bge-reranker-v2-m3` through Ollama when it serves it; a Node cross-encoder call otherwise. Ollama does not serve it (`ollama pull` fails), so the choice stays open and retrieval uses RRF until Phase 2 picks one. | Phase 2                                             |
| NLI       | DeBERTa-v3 MNLI on CPU (about 100 pairs/s); the chat model gives the reason line                                                                                                                                     | Phase 4                                             |
| PDF text  | `pdftotext -layout` (poppler, installed)                                                                                                                                                                             | `packages/core/ingest/pdfText.mjs`                  |
| OCR       | Tesseract 5 (not installed; not needed for Grenfell's born-digital PDFs)                                                                                                                                             | behind the provider interface                       |
| ASR       | whisper.cpp `large-v3-turbo` (not installed), `ffmpeg` (not installed); the laptop twin of Transcribe                                                                                                                | `brew install whisper-cpp ffmpeg` at the port check |
| Server    | Node 24, `node:http` + `ws`, port 8787                                                                                                                                                                               | `packages/local/server.mjs`                         |
| Page      | raw ESM, served by the local server                                                                                                                                                                                  | `packages/ui/`                                      |
| Evals     | `node evals/run.mjs --provider=laptop`                                                                                                                                                                               | `evals/`                                            |

## Environment

`.env.example` is the list. `MODEL_PROVIDER=laptop`, `DATABASE_URL`, `OLLAMA_URL`, `EMBED_MODEL`,
`EMBED_DIM`, `CHAT_MODEL`, `EXTRACT_MODEL`. Every chunk row stores `embedding_model` and
`embedding_dim`, so a model change triggers a re-embed and never a silent mismatch.

## Models

| Role       | Dev machine (64 GB Intel i9, CPU) | A demo laptop, if one is named (M-series) | Why                                                                                             |
| ---------- | --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Embeddings | `bge-m3`, 1024-dim                | `bge-m3`                                  | matches Cohere Embed v3's languages for later corpora                                           |
| Chat       | `qwen2.5:7b-instruct` Q4          | `qwen2.5:14b-instruct` Q4_K_M             | 14B is the floor for reliable citation tagging; 7B needs the checker, which exists from Phase 3 |
| Extraction | `qwen2.5:7b-instruct`, JSON mode  | same                                      | constrained JSON output                                                                         |
| Reranker   | `bge-reranker-v2-m3`              | same                                      | about 10 to 20 points of citation precision                                                     |

The specification's throughput figures (300 to 600 pages/hour for extraction, thousands of
chunks/minute for embeddings, 20 to 40 tokens/s chat) are for an M-series Max. This dev machine
has no Metal path for Ollama; the figures below are measured (`scripts/measure-models.mjs`).

### Measurements (one row per machine)

| Machine         | Embed (chunks/min, bge-m3) | Chat first token (s) | Chat tokens/s | Extraction (pages/h) | Date       |
| --------------- | -------------------------- | -------------------- | ------------- | -------------------- | ---------- |
| Intel i9, 64 GB | 146                        | 6.6                  | 6             | not measured         | 2026-10-18 |

## Postgres

- `chunks.embedding halfvec(1024)`, HNSW `halfvec_cosine_ops` (`m = 16`, `ef_construction = 64`);
  `tsv` generated from header and text with the `english` configuration; GIN on `tsv`.
- Migrations are plain SQL files applied in order by `scripts/db-migrate.mjs`, recorded in
  `schema_migrations`. The same files run on Aurora over the Data API (C2).
- Locators are `jsonb` written at ingest: `{ page, paragraph }`, `{ page, line }`, `{ start_ms,
end_ms }`, `{ page, bbox }`.

## Protocol

JSON frames over one WebSocket per tab (`packages/core/protocol.mjs`): client `turn`, `cancel`,
`open`; server `status` (rewriting, retrieving, answering, checking), `token`, `evidence`, `done`
with `checks`, `cancelled`, `error`. A new `turn` on a thread cancels the turn in flight; the
partial answer stays on the page marked interrupted. The same frames run over API Gateway (C3).

## Latency budget (laptop, 14B on M-series; the Intel figures are in the measurements table)

First token 1 to 2 s, 20 to 40 tokens/s, checks 5 to 10 s after `done`. Status frames make the
wait legible; the page shows the stage.

## Test tiers

| Tier    | Runs                                                | Needs              | Switch                        |
| ------- | --------------------------------------------------- | ------------------ | ----------------------------- |
| offline | `npm test`                                          | nothing            | always                        |
| db      | schema, inserts, cosine and tsv queries             | Docker Postgres    | `CONCORDANCE_DB_TESTS=1`      |
| ollama  | embed dim, streamed chat, cancel                    | Ollama with models | `CONCORDANCE_OLLAMA_TESTS=1`  |
| browser | the page in headless Chrome: layout, keys, contrast | Chrome or Chromium | `CONCORDANCE_BROWSER_TESTS=1` |
| eval    | the gold set                                        | both               | `npm run eval`                |

## Install list

| Tool        | State on the dev machine | Install                                      |
| ----------- | ------------------------ | -------------------------------------------- |
| Docker      | present                  |                                              |
| Ollama      | present (llama3.2, phi3) | `npm run models:pull`                        |
| poppler     | present (`pdftotext`)    |                                              |
| whisper.cpp | absent                   | `brew install whisper-cpp` at the port check |
| ffmpeg      | absent                   | `brew install ffmpeg` at the port check      |
| psql        | absent                   | `docker compose exec db psql -U concordance` |
