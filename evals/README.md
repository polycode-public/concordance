<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# evals

`npm run eval -- --provider=laptop|bedrock --gold=evals/grenfell/gold.jsonl` runs every gold
question through the query pipeline and reports four metrics:

- **citation precision**: the share of cited locators that are gold locators.
- **citation recall**: the share of gold locators that the answer cites.
- **unsupported-sentence rate**: the share of answer sentences with no `[En]` tag.
- **abstention correctness**: the share of rows where the system answers or abstains as `expected` says.

The default provider is `laptop`. With an empty gold file the runner prints
`0 gold rows in <path>; nothing to score` and exits 0.

## Gold row schema

One JSON object per line in `evals/<corpus>/gold.jsonl`:

```json
{
  "id": "grenfell-0001",
  "question": "When did the witness first see smoke outside the window?",
  "gold_locators": [{ "document": "IWS00001200", "page": 3, "paragraph": 11 }],
  "expected": "answer"
}
```

| Field           | Type                    | Meaning                                                                                               |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`            | string                  | Stable row id.                                                                                        |
| `question`      | string                  | The question as a user types it.                                                                      |
| `gold_locators` | array                   | The locators a correct answer cites; empty for an abstain row.                                        |
| `expected`      | `"answer"`, `"abstain"` | `abstain` when the corpus does not cover the question.                                                |
| `report`        | object, optional        | The inquiry report finding the row comes from: `{ volume, paragraph, quote }`; the runner ignores it. |

## Where gold comes from

Every gold row comes from the inquiry report's own findings: the Phase 1 report states what each
witness said and cites the statement paragraph. Each row records that locator. A gold row is never
invented, paraphrased from memory or written from model output.

## Results

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, `assertions-v5`, 38 statements

Chat model `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, embeddings `amazon.titan-embed-text-v2:0`,
store polycode-sandbox Aurora with 38 Grenfell statements (the 11 residents' plus 7 more residents
and 20 fire-brigade statements) and the store tools offered. 25 rows, 37 gold locators, every one
with a paragraph, matched by document and paragraph.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.193 |
| citation recall           | 0.297 |
| unsupported-sentence rate | 0.236 |
| abstention correctness    | 0.880 |

Not comparable with the runs below: every gold locator now names a paragraph, so a citation of
the right page and the wrong paragraph is a miss, and the store holds 27 more statements, which
compete in retrieval for the same questions. Three rows abstained or answered against their
expectation. About $0.35 by the day's Sonnet rate; Cost Explorer lags by hours.

### 2026-10-20, bedrock, `answer-closed-world-v3`, `ingest-v2`, `assertions-v4`

Chat model `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, embeddings `amazon.titan-embed-text-v2:0`,
store polycode-sandbox Aurora, 11 statements re-chunked by numbered paragraph (922 sections) with
the store tools offered. 25 rows (23 answer, 2 abstain), 34 gold locators: the first 20 rows and
five that need a tool. A gold locator now matches by document and paragraph, or by page when it
has none.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.230 |
| citation recall           | 0.412 |
| unsupported-sentence rate | 0.294 |
| abstention correctness    | 0.960 |

The figures are not comparable with the run below: that run matched whole-page locators and this
one matches paragraphs, and 15 of its 34 gold locators named a page only, so a citation of
the right paragraph on a page the gold row does not name counts as a miss. The same run with the
whole-object key scored precision 0.028 and recall 0.059 (two runs, about $0.35 each by the day's
Sonnet rate; Cost Explorer lags by hours).
The gold set now holds 50 rows (46 answer, 4 abstain) and 62 locators: the 37 of the first 25 rows each name a paragraph, and the 25 added rows name a paragraph for residents and a page for the fire-brigade statements (their text has no numbered paragraphs); the next run scores against them.

### 2026-10-20, bedrock, `answer-closed-world-v2`, `ingest-v1`

Chat model `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, embeddings `amazon.titan-embed-text-v2:0`,
store polycode-sandbox Aurora, 11 statements. 20 rows (18 answer, 2 abstain), 23 gold locators.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.350 |
| citation recall           | 0.609 |
| unsupported-sentence rate | 0.262 |
| abstention correctness    | 0.950 |

Wall time 117 s. 40 Bedrock calls: 20 embeddings and 20 chat (76,341 input and 3,663 output
tokens). Cost Explorer shows $0.34 for Sonnet 4.5 and $0.04 for Haiku 4.5 on the day, which also
holds other runs and lags by hours.

Run through `evals/run.mjs` with `openDb: openDbFromEnv`; the runner's own default opens the
`pg` pool, which ignores `DB_RESOURCE_ARN`.
