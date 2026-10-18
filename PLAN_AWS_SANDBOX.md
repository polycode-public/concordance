<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# PLAN_AWS_SANDBOX: the thin stack now, the port later

The repository deploys to polycode-sandbox from `main` by GitHub OIDC, the way chat-with-diya-gl
deploys from GitLab. What deploys now is thin and costs nothing at idle. The AWS form of the
product is Phase 7 of `PLAN_CONCORDANCE.md`. Account facts: `AWS_ACCOUNT.md`.

## Now

| Stack                            | Region    | Contents                                                                            |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `concordance-sandbox-data`       | eu-west-2 | one private, versioned S3 bucket for off-site copies of `raw/ text/ chunks/ media/` |
| `concordance-sandbox-guardrails` | eu-west-2 | AWS Budgets, $25 a month on the `project=concordance` tag, alerts at 80% and 100%   |

Deploy path: `deploy.yml` on a push to `main` that touches code, assuming
`CONCORDANCE_DEPLOY_ROLE_ARN` by OIDC, then `cdk deploy --all`. The job skips until the variable
exists.

### Operator steps before the first deploy (rows A1 and A3 in `NEXT.md`)

1. `aws sso login --profile polycode-sandbox`
2. `bash infra/provision-github-oidc.sh` (creates the `token.actions.githubusercontent.com`
   provider and the `concordance-github-deploy` role; idempotent)
3. Create the `sandbox` environment on the repository, deployable from `main` only (the job's OIDC
   subject is `repo:…:environment:sandbox`, which the role trusts).
4. `gh variable set CONCORDANCE_DEPLOY_ROLE_ARN --repo polycode-public/concordance --body <arn>`
5. In polycode-management, activate the `project` cost allocation tag so the budget filter sees it.
6. `gh workflow run deploy.yml --repo polycode-public/concordance`

`bash scripts/bootstrap-sandbox.sh` prints the sequence.

## Later: the AWS form of each component (Phase 7)

| Laptop form                        | AWS form                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Postgres in Docker                 | Aurora Serverless v2 Postgres 16, pgvector, min 0.5 ACU, the same migrations                                              |
| Ollama                             | Bedrock: Cohere Embed v3 or Titan Text v2 (1024-dim); Haiku for extraction, context lines and checks; Sonnet for the turn |
| `node packages/local/server.mjs`   | Lambda (Node, arm64) wrappers around the same core modules; API Gateway WebSocket + HTTP API                              |
| in-process ingest loop             | Step Functions Standard map over documents; SQS between fetch and extract                                                 |
| `corpora/*/raw` on disk            | the originals bucket (`raw/ text/ chunks/ media/`), object versioning, SHA-256 in metadata                                |
| static files from the local server | CloudFront + S3; Cognito for one demo user; signed URLs for media                                                         |
| whisper.cpp, Tesseract             | Transcribe and Textract behind the same interface, switched off for Grenfell                                              |

Budget from the specification: $11 to $19 for the Grenfell slice against the $25 cap, a billing
alarm at $20, the ingest job reading the alarm state before each batch. Run rate after ingest
under $2 a month at idle.

Bedrock in this account today (`AWS_ACCOUNT.md`): Haiku 4.5, Sonnet 4.5 and 4.6, Opus 4.5 and 4.6
answer; the 5.x tier is denied. The Phase 7 provider names `eu.anthropic.*` inference profiles.

## Decisions

- CDK in plain JS with the-mechanical-code-talker's structure (context `env`/`account`/`region`,
  one provisioning script per step, trust policies as JSON files, an account record). The house
  default is Java/Maven; this repository has no Java and one language keeps the factory's briefs
  short. Revisit if a second developer prefers TypeScript.
- One role, trusted from `main` and the `sandbox` environment, that assumes the CDK bootstrap roles for
  the deploy and holds a small read-only operations set (stack describes, the kill-switch parameter,
  Bedrock invoke on Haiku 4.5 and Sonnet 4.5 for the agent workflows). Branch deploys are
  not needed: the laptop is the integration environment.
