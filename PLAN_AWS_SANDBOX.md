<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# PLAN_AWS_SANDBOX: the AWS form

The repository deploys to polycode-sandbox from `main` by GitHub OIDC, the way chat-with-diya-gl
deploys from GitLab. The AWS form is the build (`PLAN_CONCORDANCE.md`, Phase 1); every component
costs nothing at idle. Account facts: `AWS_ACCOUNT.md`.

## Deployed

| Stack                            | Region    | Contents                                                                          |
| -------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `concordance-sandbox-data`       | eu-west-2 | one private, versioned S3 bucket for the originals (`raw/ text/ chunks/ media/`)  |
| `concordance-sandbox-guardrails` | eu-west-2 | AWS Budgets, $25 a month on the `project=concordance` tag, alerts at 80% and 100% |

Deploy path: `deploy.yml` on a push to `main` that touches code, assuming
`CONCORDANCE_DEPLOY_ROLE_ARN` by OIDC, then `cdk deploy --all`. Infrastructure changes travel as
CDK code in a pull request; no AWS write happens outside that path without the operator's yes.

### Provisioned (2026-10-18)

The `token.actions.githubusercontent.com` provider, the role `concordance-github-deploy`, the
`sandbox` environment limited to `main`, the repository variable and the `project` cost allocation
tag exist; `deploy.yml` run 39127857512 created both stacks. `bash scripts/bootstrap-sandbox.sh`
still prints the sequence for a second account. The trust lists GitHub's immutable subject form
(`repo:polycode-public@293237199/concordance@1424328841:…`) beside the plain one, because the
repository has immutable subject claims on.

## Phase 1: the AWS form of each component

| Component  | AWS form                                                                                                                                                      | Row | Laptop form (the port check)       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------- |
| Models     | Bedrock: Titan Text Embeddings v2 (1024-dim); the `eu.` Haiku 4.5 profile for extraction, context lines and checks; the `eu.` Sonnet 4.5 profile for the turn | C1  | Ollama                             |
| Store      | Aurora Serverless v2 Postgres 16, pgvector, 0 ACU minimum (auto-pause), the RDS Data API, the same migrations run by a deploy trigger                         | C2  | Postgres in Docker                 |
| Serve      | Lambda (Node 24, arm64) around the same core modules; API Gateway WebSocket for the turn, HTTP API for the document route; cancel through a DynamoDB flag     | C3  | `node packages/local/server.mjs`   |
| Page       | CloudFront and S3; Cognito for one demo user; presigned URLs for documents and media                                                                          | C3  | static files from the local server |
| Ingest     | Step Functions Standard map over the manifest, one Lambda per document, concurrency 4, the budget read before each batch                                      | C4  | in-process ingest loop             |
| Originals  | the originals bucket, object versioning, SHA-256 in metadata                                                                                                  | F3  | `corpora/*/raw` on disk            |
| PDF text   | `pdfjs-dist` in Node (`pdfToPagesFromBuffer`) in the ingest Lambda bundle; a poppler layer and Textract ($1.50 per 1,000 pages) cost more                     | C4  | `pdftotext`                        |
| Media, OCR | Transcribe and Textract behind the same text-tool seam, switched off for Grenfell's born-digital PDFs                                                         | F12 | whisper.cpp, Tesseract             |

### The store: the cheapest-option table

| Option                                                            | Idle cost                      | Visibility               | Verdict                                                                |
| ----------------------------------------------------------------- | ------------------------------ | ------------------------ | ---------------------------------------------------------------------- |
| Aurora Serverless v2, 0 ACU minimum, Data API, Lambda outside VPC | storage only                   | one stack, no networking | chosen: the same SQL and migrations as the laptop; resume about 15 s   |
| Aurora Serverless v2 with Lambda in the VPC over the `pg` driver  | storage, plus NAT or endpoints | subnets, security groups | more parts for the same SQL                                            |
| RDS Postgres on a small instance                                  | about $12 a month              | one instance             | costs at idle                                                          |
| S3 Vectors with DynamoDB                                          | none                           | two stores               | loses `tsvector` and SQL over assertions; a rewrite of the store layer |

Budget from the specification: $11 to $19 for the Grenfell slice against the $25 cap, a billing
alarm at $20, the ingest state machine reading the budget before each batch. Run rate after ingest
under $2 a month at idle.

Bedrock in this account today (`AWS_ACCOUNT.md`): Haiku 4.5, Sonnet 4.5 and 4.6, Opus 4.5 and 4.6
answer; the 5.x tier is denied. The provider names `eu.anthropic.*` inference profiles.

## Decisions

- CDK in plain JS with the-mechanical-code-talker's structure (context `env`/`account`/`region`,
  one provisioning script per step, trust policies as JSON files, an account record). The house
  default is Java/Maven; this repository has no Java and one language keeps the factory's briefs
  short. Revisit if a second developer prefers TypeScript.
- One role, trusted from `main` and the `sandbox` environment, that assumes the CDK bootstrap roles
  for the deploy and holds a small read-only operations set (stack describes, the kill-switch
  parameter, Bedrock invoke on Haiku 4.5 and Sonnet 4.5 for the agent workflows). Branch deploys
  are not needed: `main`'s deploy is the integration environment.
- The WebSocket route handler returns at once and invokes the turn function asynchronously, because
  the API Gateway WebSocket integration times out at 29 s and a turn streams for longer.
- Cancel is a flag in DynamoDB read by the token loop, because a running Lambda cannot be aborted
  from outside; the laptop server aborts in-process through `AbortSignal`, and both sit behind the
  same `signal` argument of `runQuery`.
- The SDK clients load behind dynamic imports inside the AWS factories, so `packages/core/` stays
  loadable offline and on the laptop without the AWS SDK.
