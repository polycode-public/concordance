<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Sandbox cost

**This project cost about $66.30 of the sandbox's $504.41 in October 2026 (month to date): ingest $42.64, usage $23.49, standing $0.17.**

Read at 2026-10-22 00:35 UTC. Cost Explorer data ends at the end of 2026-10-21 UTC (the last day is partial, and every figure is an estimate that can move). CloudTrail and CloudWatch data ends 2026-10-22 00:30 UTC.

The account is polycode-sandbox (`687443513271`), eu-west-2. The stacks `concordance-sandbox-{guardrails,data,store,app,ingest}` were created on 2026-10-18, so the per-day rate in every table is the month-to-date figure divided by 4 days (10-18 to 10-21). Ingest runs in bursts, so a day's real figure is far from the average: Haiku 4.5 cost $25.82 on 10-20 and $16.04 on 10-21, and about $1 on every other day.

## How the figures were found

Only 4.7% of the project's spend carries the `project=concordance` tag ($3.09: Aurora $2.36, Lambda $0.63, Secrets Manager $0.04, API Gateway $0.03, Step Functions $0.01). Bedrock model calls, S3, CloudFront and CloudWatch carry no tag. These rules give the other lines.

| Rule              | Method                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model lines       | CloudTrail records `Converse`, `ConverseStream` and `InvokeModel` for Bedrock. 176,869 events from 2026-10-02 to 2026-10-22 were grouped by caller role, model id and day. A `ConverseStream` call writes a second event without a model id; those are not counted. |
| Share of a line   | A caller's share of a model line is its share of the invocations of that model id. The invocation count is a proxy, because token counts are not available by caller. A caller with larger prompts than the others is under-counted.                                |
| Haiku 4.5 split   | The `eu.` profile lines (`EUW2-MP:...` without `_Global`) are this project's. The `_Global` lines ($10.55) are the `global.` profile, which only the `chat-with-diya-gl` BFF role and the operator's SSO session called.                                            |
| Lambda            | CloudWatch `Duration` sum for each `concordance-sandbox-*` function, times its memory, times the ARM price of $0.0000133334 per GB-second. The tagged figure is $0.63.                                                                                              |
| Per-caller prices | `eu.` profile rates seen in Cost Explorer: Haiku 4.5 $1.10 input and $5.50 output per million tokens; Sonnet 4.5 $3.30 and $16.50. The `global.` Haiku rates are $1.00 and $5.00.                                                                                   |

Callers in CloudTrail:

| Caller role                                                                    | What it is                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `concordance-sandbox-ingest-IngestDocument*`, `...ExtractAssertions*`          | ingest Lambdas (Haiku 4.5, Titan)                 |
| `concordance-sandbox-app-Turn*`, `...Report*`, `...Compare*`                   | usage Lambdas (Sonnet 4.5, Haiku 4.5, Titan)      |
| `AWSReservedSSO_AdministratorAccess_*`                                         | the operator's SSO session (evals, probes)        |
| `concordance-github-deploy`                                                    | agent workflows (`InvokeModelWithResponseStream`) |
| `chat-with-diya-gl-api-BffFunction*`, `word-team-rebuild-meter-ProxyFunction*` | other projects                                    |

## Ingest: $42.64 month to date, $10.66 a day

| Line                 | Service and usage type                                                                          | Month to date | Per day | Caller evidence                                                                                                                      | Source                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------: | ------: | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Haiku 4.5 extraction | Claude Haiku 4.5 (Amazon Bedrock Edition), `EUW2-MP:...` input, output, cache read, cache write |        $41.56 |  $10.39 | 11,194 of 11,840 `eu.` Haiku calls (94.5% of $43.96): `IngestDocument` 6,733 and `ExtractAssertions` 4,461                           | `ce` by `USAGE_TYPE`, `cloudtrail lookup-events` |
| Titan embeddings v2  | Amazon Bedrock, `EUW2-TitanEmbeddingV2-Text-input-tokens`                                       |         $0.46 |   $0.12 | 84,331 of 151,486 Titan calls (`IngestDocument`)                                                                                     | `ce` by `USAGE_TYPE`, `cloudtrail lookup-events` |
| Step Functions       | AWS Step Functions, `EUW2-StateTransition`                                                      |         $0.01 |   $0.00 | 20 executions started, 16 succeeded, 4 failed. Tagged `project=concordance`; the service total is $0.07 and the rest is untagged.    | `ce --filter tag`, CloudWatch `AWS/States`       |
| Ingest Lambdas       | AWS Lambda, `EUW2-Lambda-GB-Second-ARM`                                                         |         $0.60 |   $0.15 | `IngestDocument` 266 calls, 15,336 s at 2 GB; `ExtractAssertions` 216 calls, 28,452 s at 0.5 GB; `ListManifest` 18; `CheckBudget` 35 | CloudWatch `AWS/Lambda` (estimate)               |
| Corpus bucket        | Amazon S3, `EUW2-TimedStorage-ByteHrs`                                                          |         $0.01 |   $0.00 | 564 MB stored in `concordance-sandbox-data-corpusbucket*` at $0.023 per GB-month. S3 requests are untagged and shared (see below).   | CloudWatch `AWS/S3` `BucketSizeBytes`            |

The `Haiku 4.5 extraction` line is 74% output tokens: $32.19 of the $43.96 `eu.` Haiku cost is `EUW2-MP:EUW2_OutputTokenCount-Units` (5.9 million tokens).

## Usage: $23.49 month to date, $5.87 a day

| Line                                      | Service and usage type                                                                                 |            Month to date | Per day | Caller evidence                                                                                                                                                                    | Source                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | -----------------------: | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Sonnet 4.5, operator evals                | Claude Sonnet 4.5 (Amazon Bedrock Edition), `EUW2-MP:...`                                              |                    $9.18 |   $2.30 | 1,117 of 2,280 calls (49.0% of $18.74), SSO session on 10-20, 10-21 and 10-22                                                                                                      | `ce` by `USAGE_TYPE`, `cloudtrail lookup-events`                     |
| Sonnet 4.5, report Lambda                 | same                                                                                                   |                    $5.01 |   $1.25 | `ReportFunction` 610 calls (26.8%)                                                                                                                                                 | same                                                                 |
| Sonnet 4.5, answers (turn Lambda)         | same                                                                                                   |                    $4.29 |   $1.07 | `TurnFunction` 522 calls (22.9%)                                                                                                                                                   | same                                                                 |
| Sonnet 4.5, agent workflows               | same                                                                                                   |                    $0.17 |   $0.04 | `concordance-github-deploy` 21 calls (`.github/workflows/agent-*.yml`, `InvokeModelWithResponseStream`)                                                                            | same                                                                 |
| Haiku 4.5, compare, report, evals, agents | Claude Haiku 4.5 (Amazon Bedrock Edition), `EUW2-MP:...`                                               |                    $2.02 |   $0.51 | 546 of 11,840 `eu.` calls (4.6%): `CompareFunction` 224, SSO 203, `ReportFunction` 75, `concordance-github-deploy` 44                                                              | same                                                                 |
| Titan embeddings v2                       | Amazon Bedrock, `EUW2-TitanEmbeddingV2-Text-input-tokens`                                              |                    $0.36 |   $0.09 | `CompareFunction` 63,617 calls, SSO 1,325, `TurnFunction` 548, `ReportFunction` 76                                                                                                 | same                                                                 |
| Aurora ACU while awake                    | Amazon RDS, `EUW2-Aurora:ServerlessV2Usage`                                                            |                    $2.23 |   $0.56 | 24 ACU-hours over 44 awake hours of `concordance-sandbox-store-*`; ingest and usage both wake it. Tagged.                                                                          | `ce --filter tag`, CloudWatch `AWS/RDS` `ServerlessDatabaseCapacity` |
| Usage Lambdas                             | AWS Lambda, `EUW2-Lambda-GB-Second-ARM`                                                                |                    $0.19 |   $0.05 | `Compare` 16 calls, 5,701 s at 1.7 GB; `Turn` 312 calls, 3,166 s; `Report` 71 calls; `WsRoutes` 1,132; `Reports` 586; `Facts` 156; others under 340                                | CloudWatch `AWS/Lambda` (estimate)                                   |
| API Gateway WebSocket                     | Amazon API Gateway, `EUW2-ApiGatewayMessage`                                                           |                    $0.03 |   $0.01 | Tagged `project=concordance`                                                                                                                                                       | `ce --filter tag`                                                    |
| Guardrail units (shared)                  | Amazon Bedrock, `EUW2-Guardrail-ContentPolicyUnitsConsumed` $0.81, `...TopicPolicyUnitsConsumed` $0.60 | $1.41 (not in the total) |   $0.35 | CloudTrail has no guardrail-call events, and the units carry no caller. This project's guardrail applies to its `Converse` calls; the account's guardrail applies to every caller. | `ce` by `USAGE_TYPE`                                                 |
| CloudFront (shared)                       | Amazon CloudFront                                                                                      | $0.45 (not in the total) |   $0.11 | The service total for the sandbox is untagged. This project's distribution is `E3CUX1EAKX4LJW`; four distributions share the line.                                                 | `svc`                                                                |

## Standing: $0.17 month to date, $0.04 a day

| Line                   | Service and usage type                                             | Month to date | Per day | Caller evidence                                                                                                                                                                                 | Source                           |
| ---------------------- | ------------------------------------------------------------------ | ------------: | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Aurora storage and I/O | Amazon RDS, `EUW2-Aurora:StorageIOUsage` (storage is under $0.005) |         $0.13 |   $0.03 | Tagged. The cluster holds 1 GB allocated; `ServerlessDatabaseCapacity` is 0 while it is paused.                                                                                                 | `ce --filter tag`                |
| Secrets Manager secret | AWS Secrets Manager, `EUW2-AWSSecretsManager-Secrets`              |         $0.04 |   $0.01 | Tagged; the cluster's generated secret. The service total is $0.80 for 5 secrets (shared).                                                                                                      | `ce --filter tag`                |
| KMS keys               | AWS Key Management Service                                         |         $0.00 |   $0.00 | The sandbox has no customer-managed key for this project; the Aurora cluster and the secret use the AWS-managed keys. The service total, $2.02, belongs to other projects (shared).             | `aws kms list-aliases`           |
| CloudWatch alarms      | AmazonCloudWatch, `EUW2-CW:AlarmMonitorUsage`                      |         $0.00 |   $0.00 | None of the 20 alarms in the account belongs to this project. The service total, $2.52, is shared.                                                                                              | `aws cloudwatch describe-alarms` |
| CloudWatch log storage | AmazonCloudWatch                                                   |       < $0.01 |   $0.00 | 24 `concordance` log groups hold 2.05 MB (one week for the app Lambdas, one month for the ingest Lambdas and the state machine)                                                                 | `aws logs describe-log-groups`   |
| Route 53               | Amazon Route 53, `HostedZone`                                      |         $0.00 |   $0.00 | `concordance.polycode.co.uk` is a record in the management account's `polycode.co.uk` zone. The sandbox's $2.50 pays for 4 zones of other projects and the unused `aws-sandbox.polycode.co.uk`. | `aws route53 list-hosted-zones`  |

S3 requests (`EUW2-Requests-Tier1` $13.44, `Tier2` $3.43) are untagged and have no per-bucket figure. The service total is $17.13. S3 cost per day was $3.68 on 10-14, before this project's stacks existed, and $1.41 on 10-20, the heaviest ingest day. This project's share is therefore a fraction of the line that the data does not give.

## Other projects in the sandbox

Attribution of these lines by tag and caller role. The Macie, DynamoDB, GuardDuty and tax lines come from the board row that records them; this read re-checked their totals only.

| Project                   | Lines                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat-with-diya-gl`       | Opus 4.6 $36.97 (BFF role 1,547 calls, SSO session 16), Haiku 4.5 `global.` profile $10.55 (BFF 1,722 calls, SSO about 1,050), Sonnet 4.6 $0.86, Nova Pro $2.27, Nova Lite $0.01, all on 10-02 to 10-06; tag $0.31 |
| `word-team-rebuild`       | Macie $123.93, DynamoDB $86.15, GuardDuty $59.59, Haiku and Sonnet through `ProxyFunction` about $0.45 (110 Haiku calls, 10 Sonnet calls); tag $12.85                                                              |
| `word-team-resurrected`   | tag $0.04                                                                                                                                                                                                          |
| Tax                       | $84.05, spread over every line                                                                                                                                                                                     |
| Untagged, no caller found | Athena $1.49, Cost Explorer $0.25, ECR $0.11, EFS $0.02, SES $0.01, S3 $17.13 and RDS $1.73 beyond this project's $2.36 (shared lines above)                                                                       |

The `concordance-sandbox-models` budget reads $77.78 of $100. This project's model lines are $63.05 (Haiku $43.59, Sonnet $18.65, Titan $0.81); the other $14.73 is the `global.` Haiku, Nova, the guardrail units and the other callers above. `concordance-sandbox-monthly` reads $3.09 of $100.

## Reductions

Savings use this month's spend, not a forecast; ingest cost depends on how many corpora run. A "ceiling" is the cost line the change applies to.

| Change                                              | Saving on this month's spend                                                                                                                                                        | Evidence                                                                                                                                                                                                     | Board row |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Ingest extraction through Bedrock batch inference   | $20.78 (half of the $41.56 ingest Haiku line, at the 50% batch price in the row)                                                                                                    | 94.5% of Haiku `eu.` calls come from the ingest Lambdas; batch pricing is the row's premise and is not re-read here                                                                                          | A11       |
| Prompt caching on the extraction and answer prompts | Not measured. The lines it applies to: Haiku input $10.19 (ingest share of $10.77) and Sonnet 4.5 input $14.79. A cache read costs 0.1 times the input price and a write 1.25 times | No `cachePoint` in `packages/core/providers/bedrockProvider.mjs`; the existing non-global Haiku cache lines ($1.00) come from callers that cache already (agent workflows, the proxy), not this provider     | A10       |
| Application inference profiles tagged `project`     | $0. It moves $63 of model spend under the `project=concordance` tag; the profiles are copied from the `eu.` system profiles, so the 10% price premium stays                         | Model lines carry no tag today ($3.09 tagged of $66.30)                                                                                                                                                      | A9        |
| `global.` profiles in place of `eu.` profiles       | $5.66 (the `eu.` rate is 1.1 times the `global.` rate: Haiku $1.10 and $5.50 against $1.00 and $5.00 per million tokens; $62.24 of this project's Haiku and Sonnet cost is `eu.`)   | Cost Explorer unit prices by usage type; the `chat-with-diya-gl` BFF role already calls `global.anthropic.claude-haiku-4-5-20251001-v1:0` in this account. A `global.` call can run in any commercial region | no row    |
| Shorter extraction output                           | $3.04 for each 10% fewer output tokens (ingest share of the $32.19 `eu.` Haiku output line)                                                                                         | Output tokens are 74% of the `eu.` Haiku cost; 5.9 million output tokens against 9.8 million input tokens                                                                                                    | no row    |
| Ingest executions that fail                         | Not measured                                                                                                                                                                        | 4 of 20 executions of `IngestStateMachine` failed; the Haiku calls they made are billed and have no separate figure                                                                                          | no row    |

## Read it again

Each Cost Explorer request bills $0.01. This document used 7: month by `SERVICE`, `USAGE_TYPE` and tag; tag-filtered by `SERVICE` and by `USAGE_TYPE`; daily by `SERVICE`; and the Bedrock services by usage type with quantity. CloudTrail and CloudWatch reads are free.

```bash
export AWS_PROFILE=polycode-sandbox AWS_REGION=eu-west-2
aws sso login --sso-session polycode
P="Start=2026-10-01,End=2026-10-22"   # end date is exclusive
aws ce get-cost-and-usage --time-period $P --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
aws ce get-cost-and-usage --time-period $P --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE
aws ce get-cost-and-usage --time-period $P --granularity MONTHLY --metrics UnblendedCost --group-by Type=TAG,Key=project
aws ce get-cost-and-usage --time-period $P --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Tags":{"Key":"project","Values":["concordance"]}}'
aws ce get-cost-and-usage --time-period $P --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
aws ce get-cost-and-usage --time-period $P --granularity MONTHLY --metrics UnblendedCost UsageQuantity \
  --group-by Type=DIMENSION,Key=SERVICE Type=DIMENSION,Key=USAGE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Claude Haiku 4.5 (Amazon Bedrock Edition)","Claude Sonnet 4.5 (Amazon Bedrock Edition)","Amazon Bedrock"]}}'
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=bedrock.amazonaws.com \
  --start-time 2026-10-19T00:00:00Z --end-time 2026-10-20T00:00:00Z --max-results 50   # page with --next-token; group by userIdentity.sessionContext.sessionIssuer.userName, eventName, requestParameters.modelId
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Duration --dimensions Name=FunctionName,Value=<function> \
  --start-time 2026-10-01T00:00:00Z --end-time 2026-10-22T00:00:00Z --period 86400 --statistics Sum
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity \
  --dimensions Name=DBClusterIdentifier,Value=<concordance-sandbox-store cluster> \
  --start-time 2026-10-01T00:00:00Z --end-time 2026-10-22T00:00:00Z --period 3600 --statistics Average
aws budgets describe-budgets --account-id 687443513271
```
