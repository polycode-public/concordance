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

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, fusion boost, name and flat matches

The same command and store as the aliases run below, with `RERANK=off`, after four changes. One
run, from 20:42:05Z to 20:51:25Z. Spend: about $0.70 by the day's Sonnet rate; Cost Explorer lags
by hours. The run report is `evals/grenfell/runs/2026-10-21T20-51-25-724Z-bedrock-rerank-off.json`.

1. The named-witness scope is a fusion boost. When a query names a witness, `retrieve()` keeps the
   corpus-wide vector rankings and adds vector rankings over the named witnesses' documents
   beside them. A page witness filter stays a hard scope.
2. `namedWitnesses` also matches the surname of an alias, and the first and last words of an alias
   of three or more words, after the full names.
3. A question that names "flat <number>" names the witnesses whose role names that flat, never a
   cipher-only witness.
4. Row 0023's gold adds paragraph 87 of Sener Macit's first statement (IWS00000069, page 15). The
   gold set holds 64 locators.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.495 |
| citation recall           | 0.797 |
| unsupported-sentence rate | 0.145 |
| abstention correctness    | 0.960 |

The 103 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 51    |
| `page`        | 22    |
| `paragraph`   | 18    |
| `document`    | 11    |
| `abstain-row` | 1     |

The 64 gold locators: 51 cited, 11 retrieved but not cited (4 of them with the gold paragraph
itself in the evidence blocks), 2 not retrieved at all (rows 0022 and 0047).

Against the aliases run (precision 0.448, recall 0.746, unsupported 0.186, abstention 0.920; 105
citations: 47 gold, 22 page, 18 paragraph, 17 document, 1 abstain-row; 63 gold: 47 cited, 12
retrieved not cited, 4 not retrieved: rows 0008, 0009, 0022, 0047), precision rises 0.047, recall
rises 0.051, the unsupported rate falls 0.041 and abstention rises 0.040. Gold citations rise from
47 to 51 and `document` misses fall from 17 to 11. Rows 0008, 0023 and 0045 cite every gold
locator; row 0023 has no `document` miss against 7 before. Rows 0038 and 0042 no longer abstain
and cite their gold. Row 0009 retrieves all three gold locators, and row 0015 falls from 4
`document` misses to 1. Row 0047 no longer abstains; its gold is still not retrieved. Row 0006
now abstains.

The rows that still miss:

| id            | miss                                     | cause in the run                                                                                                                                |
| ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| grenfell-0047 | 2 `document`, 1 gold not retrieved       | the lexical rankings still need a name of Sener Macit; Sue Pimblett's page 8 (MET00008034) never names him, so only the vector path can find it |
| grenfell-0022 | 1 `document`, 1 gold not retrieved       | names no witness and no flat; Petra Doulova's statement (IWS00000835) is not retrieved                                                          |
| grenfell-0006 | abstains, 1 gold retrieved but not cited | names Edward Daffarn; the gold page is in the evidence and the gold paragraph is not                                                            |
| grenfell-0012 | 3 `document`                             | Sener Macit holds two ids; the model cites IWS00000069, the gold names IWS00001156                                                              |
| grenfell-0013 | 3 `document`, 1 gold retrieved not cited | as 0012                                                                                                                                         |
| grenfell-0015 | 1 `document`                             | the flat match names Walid Wahbi (IWS00000113) beside Hamid Wahbi; the model cites him, the gold names Hamid Wahbi only                         |
| grenfell-0048 | 1 `document`                             | the question names Flat 133, so the flat match names Dean Nelson (MET00010926), whose role names Flat 133; the model cites him                  |
| grenfell-0020 | 1 `abstain-row`                          | an abstain row that the model answers                                                                                                           |

The next changes the evidence names:

1. Turn the lexical name groups into a boost too: keep a corpus-wide lexical ranking beside the
   one that needs a witness name, for row 0047.
2. Check rows 0012 and 0013 against Sener Macit's first statement (IWS00000069), as row 0023 was.
3. Hold the flat match to resident roles, for row 0048, and check whether row 0015's finding also
   rests on Walid Wahbi's statement.

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, aliases and named-witness scope

The same command, store and gold set as the corrected-gold run below, with `RERANK=off`, after
two changes. `scripts/backfill-aliases.mjs --apply` gave the 38 Grenfell witnesses their names as
aliases (0 of 38 had one before), so `namedWitnesses` now fires. When a query names a witness, the
vector rankings read only that witness's documents. One run, from 20:25:00Z to 20:35:03Z. Spend:
about $0.70 by the day's Sonnet rate; Cost Explorer lags by hours. The run report is
`evals/grenfell/runs/2026-10-21T20-35-03-729Z-bedrock-rerank-off.json`.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.448 |
| citation recall           | 0.746 |
| unsupported-sentence rate | 0.186 |
| abstention correctness    | 0.920 |

The 105 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 47    |
| `page`        | 22    |
| `paragraph`   | 18    |
| `document`    | 17    |
| `abstain-row` | 1     |

The 63 gold locators: 47 cited, 12 retrieved but not cited (4 of them with the gold paragraph
itself in the evidence blocks), 4 not retrieved at all (rows 0008, 0009, 0022, 0047).

Against the corrected-gold run (precision 0.463, recall 0.698, unsupported 0.180, abstention
0.920; 95 citations: 44 gold, 22 document, 15 page, 14 paragraph; 63 gold: 44 cited, 15 retrieved
not cited, 4 not retrieved), recall rises 0.048, precision falls 0.015, the unsupported rate rises
0.006 and abstention is the same. Gold citations rise from 44 to 47 and `document` misses fall
from 22 to 17. Rows 0006, 0035 and 0036 lose all 9 of their `document` misses and cite gold, and
the gold locators of rows 0006 and 0036 are now retrieved. Rows 0005, 0012 and 0030 no longer
abstain. The model cites 105 locators against 95, and `page` and `paragraph` misses rise from 29
to 40.

The rows that still miss:

| id            | miss                                     | cause in the run                                                                                        |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| grenfell-0008 | 2 `document`, 1 gold not retrieved       | names Flat 131 and no witness                                                                           |
| grenfell-0015 | 4 `document`                             | names Flat 136 and no witness                                                                           |
| grenfell-0022 | 1 gold not retrieved                     | names no witness                                                                                        |
| grenfell-0009 | 1 gold not retrieved (IWS00000990)       | "Hime Gashaw" does not match the alias "Hime Haymanot Gashaw", so the scope holds Richard Fletcher only |
| grenfell-0047 | 1 gold not retrieved, abstains           | names Sener Macit; the gold is in Sue Pimblett's statement (MET00008034), which the scope keeps out     |
| grenfell-0012 | 3 `document`                             | Sener Macit holds two ids; the model cites IWS00000069, the gold names IWS00001156                      |
| grenfell-0023 | 7 `document`                             | as 0012; the question asks "across his statements", so the gold lacks the first statement               |
| grenfell-0045 | 1 `document`                             | "Firefighter Hippel" and "Crew Manager Stern" match no full alias                                       |
| grenfell-0038 | abstains, 2 gold retrieved but not cited | names both control room officers; the gold is in the evidence                                           |
| grenfell-0042 | abstains, 1 gold retrieved but not cited | as in the run below                                                                                     |
| grenfell-0020 | 1 `abstain-row`                          | an abstain row that the model answers                                                                   |

The next changes the evidence names:

1. Turn the scope into a fusion boost: keep the corpus-wide vector rankings and add the scoped
   ones beside them. Rows 0009 and 0047 lose a gold locator because the scope keeps out a
   statement that holds the answer.
2. Match a witness by a part of the alias (a surname, or the first and last words of the name)
   for rows 0009 and 0045.
3. Match a flat number to the witness whose role names that flat, for rows 0008, 0015 and 0022.
4. Correct the gold of row 0023 to add Sener Macit's first statement (IWS00000069).

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, corrected gold

The same command and store as the miss-report run below, with `RERANK=off`, on the gold set of
pull request #60 (63 locators over 50 rows). One run, from 20:02:08Z to 20:12:11Z. Spend: about
$0.70 by the day's Sonnet rate; Cost Explorer lags by hours. The run report is
`evals/grenfell/runs/2026-10-21T20-12-11-275Z-bedrock-rerank-off.json`.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.463 |
| citation recall           | 0.698 |
| unsupported-sentence rate | 0.180 |
| abstention correctness    | 0.920 |

The 95 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 44    |
| `document`    | 22    |
| `page`        | 15    |
| `paragraph`   | 14    |
| `abstain-row` | 0     |

The 63 gold locators: 44 cited, 15 retrieved but not cited (5 of them with the gold paragraph
itself in the evidence blocks), 4 not retrieved at all (rows 0006, 0008, 0022, 0036).

The gold changes this run scores:

| id                        | document    | old    | new              |
| ------------------------- | ----------- | ------ | ---------------- |
| grenfell-0005             | IWS00000169 | p4 ¶9  | p4 ¶9 and p5 ¶10 |
| grenfell-0007, 0022       | IWS00000913 | p3 ¶11 | p3 ¶14           |
| grenfell-0008, 0021       | IWS00000913 | p3 ¶11 | p4 ¶20           |
| grenfell-0008, 0021       | IWS00000990 | p1 ¶2  | p3 ¶14           |
| grenfell-0009, 0024       | IWS00000990 | p1 ¶2  | p12 ¶71          |
| grenfell-0012, 0023       | IWS00001156 | p3 ¶10 | p4 ¶14           |
| grenfell-0016, 0022, 0025 | IWS00000835 | p2 ¶11 | p9 ¶61           |
| grenfell-0017             | IWS00000835 | p2 ¶11 | p8 ¶55           |

Row grenfell-0013 keeps IWS00001156 p3 ¶10 because no paragraph of that statement holds the
finding, which cites the witness's first statement, not in the corpus.

Against the miss-report run (precision 0.360, recall 0.500, unsupported 0.201, abstention 0.860;
86 citations: 31 gold, 29 page, 18 document, 7 paragraph; 62 gold: 31 cited, 27 retrieved not
cited, 4 not retrieved), precision rises 0.103, recall 0.198 and abstention 0.060, and the
unsupported rate falls 0.021. Gold citations rise from 31 to 44 and `page` misses fall from 29 to
15, because the corrected locators now match what the model cites. `document` misses rise from 18
to 22 and now make the largest miss kind. Rows 0006, 0015, 0035 and 0036 hold 13 of them: the
firefighter and other residents' statements rank above the named witness's statement. The 4 gold
locators never retrieved sit in rows 0006, 0008, 0022 and 0036. Four answer rows abstain (0005,
0012, 0030, 0042); three of them (0005, 0012, 0030) have the gold paragraph in the evidence. The
next pipeline change is the rewrite in `packages/core/retrieval/rewrite.mjs` and the fusion in
`rrf.mjs` and `hybrid.mjs`, because they cause the `document` misses and all 4 unretrieved gold
locators. The answer prompt is the change after it, for the three abstaining rows.

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
