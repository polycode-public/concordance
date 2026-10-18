# concordance

A witness research tool over public inquiry witness statements: hybrid retrieval over Postgres
(pgvector + tsvector), a citation on every sentence that the server resolves to a page, paragraph
or timecode, a checking layer that colours what the evidence supports, and a fact store that finds
where witnesses agree and contradict. The demo corpus is the Grenfell Tower Inquiry (Open
Government Licence v3).

Three rules hold everywhere: evidence is never altered, every claim links to a locator, and every
automated judgment is reversible by a person.

## Status

Phase 0, the foundations, and Phase 1 under way: the AWS form is the build (Bedrock, Aurora
Serverless v2 with pgvector, Lambda, CloudFront), deployed from `main` to polycode-sandbox. The
laptop form below is the port check. The plan is `PLAN_CONCORDANCE.md`; open work is `NEXT.md`;
the specification is `docs/SPEC_WITNESS_RESEARCH_TOOL.md`.

## The laptop port (macOS)

```bash
npm ci
npm run db:up && npm run db:migrate     # Postgres 16 + pgvector on :5432 (Docker)
npm run models:pull                     # ollama pull bge-m3 and qwen2.5:7b-instruct
cp .env.example .env
npm run dev                             # http://localhost:8787
```

`npm test` runs offline. `CONCORDANCE_DB_TESTS=1` and `CONCORDANCE_OLLAMA_TESTS=1` add the
Postgres and Ollama tiers. `npm run eval -- --provider=bedrock` scores the gold set on the deployed
form; `--provider=laptop` is the port check.

## Layout

| Path              | Contents                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| `packages/core/`  | providers, ingest, chunking, retrieval, checks, protocol; no AWS imports       |
| `packages/local/` | the HTTP + WebSocket server                                                    |
| `packages/ui/`    | the page                                                                       |
| `db/migrations/`  | the schema, plain SQL                                                          |
| `evals/`          | gold sets and the runner                                                       |
| `corpora/`        | fetch code and manifests; the files themselves are not committed               |
| `infra/`          | CDK (JS) for the thin sandbox stack; `AWS_ACCOUNT.md` is the record            |
| `.claude/skills/` | the delivery cycle (`/board`, `/do-next`, `/watch`, `/auto-merge`, `/iterate`) |

## Licence

AGPL-3.0-only. Copyright 2026 Polycode Limited. Factory scripts and skills adapted from DIY
Accounting Limited's repositories carry their provenance in their headers.
