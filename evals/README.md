<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# evals

`npm run eval -- --provider=laptop|bedrock --gold=evals/grenfell/gold.jsonl` runs every gold
question through the query pipeline and reports four metrics:

- **citation precision**: the share of cited locators that are gold locators.
- **citation recall**: the share of gold locators that the answer cites.
- **unsupported-sentence rate**: the share of answer sentences with no `[En]` tag.
- **abstention correctness**: the share of rows where the system answers or abstains as `expected` says.

Each run also writes a miss report to `evals/<corpus>/runs/<timestamp>-<provider>-rerank-<RERANK>.json`
(gitignored; `--report=<path>` sets another path) and prints its path as `report`. For each row
the report gives every distinct cited locator a `kind`: `gold`, `paragraph` (the page of a gold
locator, another paragraph), `page` (the document of a gold locator, another page), `document`
(no gold locator names the document) or `abstain-row`. For each gold locator it records `cited`,
`retrieved` (an evidence block comes from its document) and `retrievedParagraph`. The `summary`
block counts both over all rows.

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

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, miss report

The same command and store as the run below, with `RERANK=off`, run once from 14:06:10Z to
14:17:49Z with the miss report on.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.360 |
| citation recall           | 0.500 |
| unsupported-sentence rate | 0.201 |
| abstention correctness    | 0.860 |

The 86 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 31    |
| `page`        | 29    |
| `document`    | 18    |
| `paragraph`   | 7     |
| `abstain-row` | 1     |

The 62 gold locators: 31 cited, 27 retrieved but not cited (14 of them with the gold paragraph
itself in the evidence blocks), 4 not retrieved at all (rows 0006, 0008, 0022, 0036).

Example rows, checked against the statement text with `pdftotext`:

| Row             | Gold names                                                                                                | The model cited                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `grenfell-0021` | IWS00000913 p.3 ¶11 (the fire engines arrive), IWS00000990 p.1 ¶2 (on whose behalf the statement is made) | IWS00000913 p.4 ¶20 and IWS00000990 p.3 ¶14, the two paragraphs that say the smoke rushed in when the door opened |
| `grenfell-0017` | IWS00000835 p.2 ¶11 (the neighbours in flats 171 to 176)                                                  | IWS00000835 p.8 ¶54 and ¶55, where the couple agree not to stay put                                               |
| `grenfell-0009` | IWS00000913 p.20 ¶109, p.7 ¶37 and IWS00000990 p.1 ¶2                                                     | p.20 ¶109 (gold) and p.19 ¶102, which also says they would ignore the sign                                        |
| `grenfell-0015` | IWS00001157 p.6 ¶26 and p.10 ¶55                                                                          | p.6 ¶26 (gold) and four paragraphs of Edward Daffarn and IWS00000113                                              |
| `grenfell-0036` | IWS00000608 p.11 ¶69 (the firefighter on the 11th floor); never retrieved                                 | three firefighter statements (MET00012483, MET000083321, MET000083300)                                            |
| `grenfell-0030` | IWS00001091 p.8 ¶42, in the evidence blocks                                                               | nothing: the model abstained                                                                                      |

The evidence points first at the gold set. Three gold locators name a paragraph that does not
say what the row asks: IWS00000835 p.2 ¶11 (rows 0016, 0017, 0022, 0025), IWS00000990 p.1 ¶2
(rows 0008, 0009, 0021, 0024) and IWS00000913 p.3 ¶11 (rows 0007, 0008, 0021, 0022). These nine
rows hold 21 of the 55 non-gold citations, and the four spot-checked ones (IWS00000913 p.4 ¶20,
IWS00000990 p.3 ¶14, IWS00000835 p.8 ¶55, IWS00000913 p.19 ¶102) support the answer. So 15 of
the 29 `page` misses sit in rows whose gold is wrong, and neighbour expansion in
`packages/core/retrieval/expand.mjs` and block choice in `evidence.mjs` are not yet shown to be at
fault. The 18 `document` misses (rows 0006, 0015, 0036 hold 10) point at the rewrite in
`packages/core/retrieval/rewrite.mjs` and the fusion in `rrf.mjs` and `hybrid.mjs`, which rank the firefighter and other residents'
statements above the named witness. Six answer rows (0005, 0027, 0030, 0032, 0035, 0042) abstain
with a gold document in the evidence, four of them with the gold paragraph, which points at the
answer prompt. The first change: check every gold locator against the statement text, correct
the ones that name the wrong paragraph from the inquiry report's quote, and score again.

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off and on

Chat model `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, embeddings `amazon.titan-embed-text-v2:0`,
reranker `eu.anthropic.claude-haiku-4-5-20251001-v1:0` when on, store polycode-sandbox Aurora with
38 Grenfell statements and the store tools offered. The full gold set: 50 rows (46 answer, 4
abstain), 62 locators, matched by document and paragraph, or by page when the row names no
paragraph. Two runs of the same command, one with `RERANK=off` and one with `RERANK=model`, after
PR #56 (the query rewrite, aliases, exact phrase, `websearch_to_tsquery` and the reranker).

| Metric                    | `RERANK=off` | `RERANK=model` |
| ------------------------- | ------------ | -------------- |
| citation precision        | 0.372        | 0.302          |
| citation recall           | 0.516        | 0.516          |
| unsupported-sentence rate | 0.187        | 0.198          |
| abstention correctness    | 0.860        | 0.940          |
| wall time                 | 11 min 24 s  | 16 min 38 s    |

The reranker cites the same share of gold locators and more non-gold ones, and takes five minutes
longer, so the deploy keeps `RERANK` off. Against the 25-row run below, precision rose from 0.193
to 0.372 and recall from 0.297 to 0.516; the 25 added rows name a page only for the fire-brigade
statements, so part of the rise is the looser key on those rows. The Phase 3 exit (precision above
0.85) is not met. Cost Explorer on the day: Sonnet 4.5 $2.56 and Haiku 4.5 $16.04, which hold the
day's UCPI ingest and lag by hours; about $0.70 per run by the day's Sonnet rate.

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
