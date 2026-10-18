<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# AWS account

One account, no ci/prod split: polycode-sandbox. The account's own record is
`../../polycode-unpublished/polycode-sandbox/AWS_ACCOUNT.md`; the facts this repository relies on are below
(verified 2026-10-18).

| Fact            | Value                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account         | polycode-sandbox, `687443513271`, Workloads OU of the polycode organisation `o-d4gyqlg7o0` (management account `541134664601`)                                                       |
| Workload region | eu-west-2; us-east-1 only for a CloudFront certificate (none yet)                                                                                                                    |
| SSO profile     | `polycode-sandbox` (`aws sso login --profile polycode-sandbox`), AdministratorAccess                                                                                                 |
| Contact email   | `polycodelimited+aws-polycode-sandbox@gmail.com`; the project budget alerts go here too                                                                                              |
| DNS             | `aws-sandbox.polycode.co.uk` hosted zone (`Z03251741HJWW3M3SBQ95`); this project uses none yet                                                                                       |
| Cost guardrails | Budgets in the management account: `polycode-sandbox-daily` $10 alert, `polycode-sandbox-monthly-cap` $300 with the freeze SCP `p-8q03vynu`. This project's own budget: $25 a month  |
| Bedrock         | Inference profile ids `eu.anthropic.*` in eu-west-2. Answering: Haiku 4.5, Sonnet 4.5 and 4.6, Opus 4.5 and 4.6. Denied: Opus 4.7 and later, Sonnet 5, Fable 5, Opus 5.x, Sonnet 5.5 |
| Other tenants   | `chat-with-diya-gl-gitlab-deploy` and three `word-team-*-gitlab-deploy` roles, all through the `gitlab.com` OIDC provider                                                            |

## Deploying from GitHub

`github.com/polycode-public/concordance`'s `deploy.yml` federates through the account's
`token.actions.githubusercontent.com` OIDC provider into one role. The agent workflows use the
same role for their AWS reads, the kill switch and Bedrock.

| Piece         | Value                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Role          | `concordance-github-deploy`                                                                                                                                                                                                                                                                            |
| Trust         | `infra/iam-trust-policies/github-oidc-deploy-role.json`: `aud` `sts.amazonaws.com`; `sub` for `main` and for the `sandbox` environment, each in GitHub's immutable form (`repo:polycode-public@293237199/concordance@1424328841:…`, the repository has immutable subject claims on) and the plain form |
| Environment   | `sandbox`, deployment branches limited to `main`. A job with `environment: sandbox` presents the environment subject, so this rule keeps the trust main-only                                                                                                                                           |
| Permissions   | `infra/iam-trust-policies/github-deploy-assume-cdk-roles.json`: `sts:AssumeRole` on `cdk-hnb659fds-*` only; the CDK bootstrap roles do the deploy                                                                                                                                                      |
| Permissions   | `infra/iam-trust-policies/github-deploy-operations.json`: `cloudformation:ListStacks`, `DescribeStacks` on `concordance-*`, read and write of `/concordance/*/agents/kill-switch`, Bedrock invoke on the Sonnet 4.5 and Haiku 4.5 `eu.` profiles                                                       |
| Repo variable | `CONCORDANCE_DEPLOY_ROLE_ARN` = `arn:aws:iam::687443513271:role/concordance-github-deploy`; `deploy.yml` and the agent workflows skip or stop when it is absent                                                                                                                                        |
| CDK bootstrap | `aws://687443513271/eu-west-2` and `aws://687443513271/us-east-1` (CDKToolkit present), qualifier `hnb659fds`                                                                                                                                                                                          |

`infra/provision-github-oidc.sh` creates the provider, the role and both policies, idempotently;
`bash scripts/bootstrap-sandbox.sh` prints the whole one-time sequence. Provisioned on 2026-10-18,
with the `project` cost allocation tag activated in the management account the same day.

## Stacks

The CDK app is `infra/bin/app.mjs`. Context `env` (default `sandbox`), `account` (default the
credentials' account) and `region` (default `eu-west-2`); every stack is `concordance-<env>-<name>`
and carries the tags `project=concordance` and `env=<env>`.

| Stack                            | What                                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concordance-sandbox-data`       | eu-west-2: private corpus bucket `concordance-sandbox-data-corpusbucket36de2aaa-7jolgc2qi4a4` (`raw/`, `text/`, `chunks/`, `media/`): versioned, SSE-S3, public access blocked, SSL enforced, noncurrent versions expire after 30 days, destroyed with the stack |
| `concordance-sandbox-guardrails` | eu-west-2: the budget `concordance-sandbox-monthly` ($25 a month on tag `project=concordance`, email at 80% and 100% actual) and the parameter `/concordance/sandbox/agents/kill-switch` (created `off`)                                                         |

The data and guardrails stacks were created by `deploy.yml` run 39127857512; the store stack (Aurora Serverless v2 Postgres 16.13, cluster `concordance-sandbox-store-clustereb0386a7-x6v5mikorswb`, 0 to 2 ACU, Data API) and the app stack (site `https://d1j45li8u6vyol.cloudfront.net`, WebSocket `wss://j9rbwwkazk.execute-api.eu-west-2.amazonaws.com/prod`, HTTP API `https://fjofcv9su9.execute-api.eu-west-2.amazonaws.com`, user pool `eu-west-2_XvxzifuNb`, client `7ja88r4l0k3021bo78jps3viv3`, user `demo`) by run 39168340123 of `fe3e72a8`; the ingest stack (state machine `IngestStateMachineB1E20B88-cprHyhUIUuRC`, three functions) by run 39171346285 of `025c763d`; all five are green (2026-10-18).
