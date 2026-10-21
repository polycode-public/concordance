<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# AWS account

One account, no ci/prod split: polycode-sandbox. The account's own record is
`../../polycode-unpublished/polycode-sandbox/AWS_ACCOUNT.md`; the facts this repository relies on are below
(verified 2026-10-18).

| Fact            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account         | polycode-sandbox, `687443513271`, Workloads OU of the polycode organisation `o-d4gyqlg7o0` (management account `541134664601`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Workload region | eu-west-2; us-east-1 only for the CloudFront certificate of `concordance.polycode.co.uk` (see "The domain")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SSO profile     | `polycode-sandbox` (`aws sso login --profile polycode-sandbox`), AdministratorAccess                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Contact email   | `polycodelimited+aws-polycode-sandbox@gmail.com`; the project budget alerts go here too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DNS             | `aws-sandbox.polycode.co.uk` hosted zone (`Z03251741HJWW3M3SBQ95`), unused here. The site's name `concordance.polycode.co.uk` is a record in the zone `polycode.co.uk` (`Z2981ZT3I1K2HT`) of the management account `541134664601`, profile `polycode-management`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cost guardrails | Budgets in the management account: `polycode-sandbox-daily` $10 alert, `polycode-sandbox-monthly-cap` $500 (raised from $300 by the operator on 2026-10-19 at about 17:35 UTC) with the freeze SCP `p-8q03vynu`, which the budget action attached to the account at 04:44 UTC on 2026-10-19 at $315 month-to-date (other tenants' Macie, DynamoDB and Bedrock spend) and the operator detached at about 07:52 UTC the same day; while attached every role in the account is denied. Amazon Macie was removed from the account on 2026-10-19 (`word-team-datapipeline` !32). This project's own budgets: $100 a month each, on the project tag and on the Bedrock services (raised from $25 to $50 and then $75 by the operator on 2026-10-21) |
| Bedrock         | Inference profile ids `eu.anthropic.*` in eu-west-2. Answering: Haiku 4.5, Sonnet 4.5 and 4.6, Opus 4.5 and 4.6. Denied: Opus 4.7 and later, Sonnet 5, Fable 5, Opus 5.x, Sonnet 5.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Other tenants   | `chat-with-diya-gl-gitlab-deploy` and three `word-team-*-gitlab-deploy` roles, all through the `gitlab.com` OIDC provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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

## The domain

The site answers on `https://concordance.polycode.co.uk` when the repository variables
`CONCORDANCE_DOMAIN_NAME` and `CONCORDANCE_CERTIFICATE_ARN` are both set. `deploy.yml` passes them
to `cdk deploy` as the context values `domainName` and `certificateArn`. Without them the app stack
serves on its CloudFront name only. With them the distribution carries the name and the
certificate, the `SiteUrl` output and `config.json`'s `siteUrl` are the domain, and the HTTP API's
allowed origins and the Cognito client's callback and logout URLs list the domain beside the
CloudFront name. The output `DistributionDomainName` keeps the CloudFront name.

| Piece         | Value                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone          | `polycode.co.uk`, `Z2981ZT3I1K2HT`, in the management account `541134664601` (`polycode-management`)                                                                                                                                                                       |
| Certificate   | ACM in `us-east-1` of the sandbox account, DNS validation; CloudFront reads certificates from there                                                                                                                                                                        |
| Alias target  | the distribution `d1j45li8u6vyol.cloudfront.net`; CloudFront's alias zone id is `Z2FDTNDATAQYW2`                                                                                                                                                                           |
| Repo variable | `CONCORDANCE_DOMAIN_NAME` = `concordance.polycode.co.uk`; `CONCORDANCE_CERTIFICATE_ARN` = `arn:aws:acm:us-east-1:687443513271:certificate/13b123f5-b422-41c0-a920-2c97cbc2ac80` (issued 2026-10-20; the validation CNAME and the alias A and AAAA records are in the zone) |

The operator runs these once. Each AWS command is a write. The alias record goes in before the
variables, because the deploy that follows them smokes the `SiteUrl` output, which is then the
domain. The alias points at the CloudFront name, which exists already.

1. Request the certificate and keep its ARN:

   ```bash
   aws acm request-certificate --profile polycode-sandbox --region us-east-1 \
     --domain-name concordance.polycode.co.uk --validation-method DNS \
     --tags Key=project,Value=concordance Key=env,Value=sandbox \
     --query CertificateArn --output text
   ```

2. Read the validation record (its `Name` and `Value`):

   ```bash
   aws acm describe-certificate --profile polycode-sandbox --region us-east-1 \
     --certificate-arn <certificate-arn> \
     --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
   ```

3. Write the validation record in the management account's zone:

   ```bash
   aws route53 change-resource-record-sets --profile polycode-management \
     --hosted-zone-id Z2981ZT3I1K2HT \
     --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"<Name>","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"<Value>"}]}}]}'
   ```

4. Wait until the certificate is issued:

   ```bash
   aws acm wait certificate-validated --profile polycode-sandbox --region us-east-1 \
     --certificate-arn <certificate-arn>
   ```

5. Write the alias records (IPv4 and IPv6) in the management account's zone:

   ```bash
   aws route53 change-resource-record-sets --profile polycode-management \
     --hosted-zone-id Z2981ZT3I1K2HT \
     --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"concordance.polycode.co.uk","Type":"A","AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2","DNSName":"d1j45li8u6vyol.cloudfront.net","EvaluateTargetHealth":false}}},{"Action":"UPSERT","ResourceRecordSet":{"Name":"concordance.polycode.co.uk","Type":"AAAA","AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2","DNSName":"d1j45li8u6vyol.cloudfront.net","EvaluateTargetHealth":false}}}]}'
   ```

6. Set the two repository variables:

   ```bash
   gh variable set CONCORDANCE_DOMAIN_NAME --repo polycode-public/concordance --body concordance.polycode.co.uk
   gh variable set CONCORDANCE_CERTIFICATE_ARN --repo polycode-public/concordance --body <certificate-arn>
   ```

7. The next `deploy.yml` run on `main` attaches the name and the certificate to the distribution.

## Stacks

The CDK app is `infra/bin/app.mjs`. Context `env` (default `sandbox`), `account` (default the
credentials' account) and `region` (default `eu-west-2`); every stack is `concordance-<env>-<name>`
and carries the tags `project=concordance` and `env=<env>`.

| Stack                            | What                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concordance-sandbox-data`       | eu-west-2: private corpus bucket `concordance-sandbox-data-corpusbucket36de2aaa-7jolgc2qi4a4` (`raw/`, `text/`, `chunks/`, `media/`): versioned, SSE-S3, public access blocked, SSL enforced, noncurrent versions expire after 30 days, destroyed with the stack                   |
| `concordance-sandbox-guardrails` | eu-west-2: the budgets `concordance-sandbox-monthly` ($100 a month on tag `project=concordance`) and `concordance-sandbox-models` ($100 a month on the Bedrock services), email at 80% and 100% actual and the parameter `/concordance/sandbox/agents/kill-switch` (created `off`) |

The data and guardrails stacks were created by `deploy.yml` run 39127857512; the store stack (Aurora Serverless v2 Postgres 16.13, cluster `concordance-sandbox-store-clustereb0386a7-x6v5mikorswb`, 0 to 2 ACU, Data API) and the app stack (site `https://d1j45li8u6vyol.cloudfront.net`, WebSocket `wss://j9rbwwkazk.execute-api.eu-west-2.amazonaws.com/prod`, HTTP API `https://fjofcv9su9.execute-api.eu-west-2.amazonaws.com`, user pool `eu-west-2_XvxzifuNb`, client `7ja88r4l0k3021bo78jps3viv3`, user `demo`) by run 39168340123 of `fe3e72a8`; the ingest stack (state machine `IngestStateMachineB1E20B88-cprHyhUIUuRC`, three functions) by run 39171346285 of `025c763d`; all five are green (2026-10-18).
