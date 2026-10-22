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

The `bedrock` provider calls the models through the stack's tagged application inference profiles and
refuses to start unless `BEDROCK_CHAT_PROFILE_ARN`, `BEDROCK_EXTRACT_PROFILE_ARN` and
`BEDROCK_EMBED_PROFILE_ARN` are set. After `aws sso login --sso-session polycode`, run
`eval "$(scripts/model-profile-env.sh)"` once in the shell; it reads the three ARNs from the
`concordance-sandbox-model-profiles` stack outputs.

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

### 2026-10-22, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, ranked witness claims and whole findings

The same command and store as the run of 2026-10-21 23:30Z below, with `RERANK=off`, after three
changes. One run, from 08:05:03Z to 08:14:59Z. The run printed its tokens: 903,382 input, 14,052
output, 178,092 cache read, 1,746 cache write, about $2.98 at the Sonnet 4.5 list price; Cost
Explorer lags by hours. The run report is `evals/grenfell/runs/2026-10-22T08-14-59-700Z-bedrock-rerank-off.json`.

1. Four gold rows quote the whole finding and add the locators that say its other sentences: row
   0001 IWS00000490 p12 ¶66 (finding 10.10), row 0003 IWS00000490 p13 ¶72 (10.17), row 0039
   MET00008044 p4 (10.106), row 0048 MET00018800 p11 (18.20 b). Row 0034 stays: its question
   asks what finding 11.68's first sentence says, and ¶48 holds it. The gold set holds 75 locators.
2. `witness_claims` gives the 12 claims of a witness whose sentences are nearest the question by
   embedding, in document order. It gave up to 50 claims in document order, so 39 of its 41 calls
   in the 23:30Z run added the claims of a statement's first pages.
3. The run prints and records its summed token use.

Row 0013's ¶103 stays out of retrieval, and retrieval is unchanged. In the corpus lexical
rankings of the question, ¶103's passages rank 122nd and 172nd and its section 71st (the walk
reads 40 and 20); ¶102 and ¶105 rank 12th and 13th. ¶103 shares only "Hanife" and the header's
"flat 133" with the question; "bucket", "water" and "bathroom" are not in it. The question names
¶103 by its order before ¶105, which is in the evidence, and the model's searches name the
bedroom fire of ¶105.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.550 |
| citation recall           | 0.813 |
| unsupported-sentence rate | 0.175 |
| abstention correctness    | 0.980 |

The 111 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 61    |
| `paragraph`   | 23    |
| `page`        | 22    |
| `document`    | 4     |
| `abstain-row` | 1     |

The 75 gold locators: 61 cited, 13 retrieved but not cited (4 of them with the gold paragraph
itself in the evidence blocks), 1 not retrieved at all (row 0022).

Against the 23:30Z run (precision 0.540, recall 0.859, unsupported 0.143, abstention 0.980; 113
citations: 61 gold, 27 paragraph, 21 page, 3 document, 1 abstain-row; 71 gold: 61 cited, 9
retrieved not cited, 1 not retrieved: row 0022), precision rises 0.010, recall falls 0.046 on 4
more gold locators, the unsupported rate rises 0.032 and abstention is the same. Gold citations
stay at 61: 3 of the 4 new gold locators are cited (rows 0003, 0039, 0048), and 3 are lost. Row
0007's p4 ¶16 and row 0011's p2 ¶6 are no longer in the evidence; the claims of the first pages
had added them. Row 0015's IWS00001157 ¶55 is in the evidence and not cited. Non-gold citations
fall from 52 to 50: rows 0003, 0004, 0013, 0022, 0025, 0034 and 0039 lose 10, and rows 0007,
0008, 0011, 0016, 0023, 0043 and 0048 gain 8. The evidence blocks of the 50 rows fall from 2,823 to 1,468;
`witness_claims` runs 51 times in 40 rows. The unsupported sentences rise from 41 to 50 of 285,
by at most 3 in a row (row 0002).

The rows that still miss:

| id            | miss                                                 | cause in the run                                                                                                      |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| grenfell-0023 | 11 `page` and `paragraph`                            | a list across two statements; every gold locator is cited                                                             |
| grenfell-0001 | 4 `page` and `paragraph`, 1 gold not in the evidence | cites IWS00000490 ¶68, ¶71, ¶76 and p18 ¶103 beside ¶67; ¶66 (the beeping) is not in the evidence                     |
| grenfell-0012 | 4 `paragraph`, 1 gold in the evidence not cited      | cites IWS00000069 ¶85, ¶86, ¶88 and ¶89 around the gold ¶87 (cited); IWS00001156 ¶14 is in the evidence and not cited |
| grenfell-0022 | 1 gold not retrieved, 3 misses                       | names no witness and no flat; Petra Doulova's statement (IWS00000835 p9 ¶61) is not retrieved                         |
| grenfell-0048 | 3 `page`                                             | cites MET00018800 p8 (the task), p9 and p10 beside both gold pages, after `search_chunks`                             |
| grenfell-0007 | 2 `page` and `paragraph`, 1 gold not in the evidence | cites IWS00000913 ¶17 and ¶25; p4 ¶16 (the bedroom window) is not in the evidence                                     |
| grenfell-0008 | 2 `page` and `document`                              | cites IWS00000913 ¶34 and Jamal Stern's MET00012483 p12 beside both gold locators                                     |
| grenfell-0009 | 2 `page` and `paragraph`, 1 gold not in the evidence | cites IWS00000913 ¶102 and IWS00000990 ¶72; IWS00000913 p7 ¶37 is not in the evidence                                 |
| grenfell-0024 | 2 `page` and `paragraph`, 1 gold not in the evidence | the same two paragraphs as row 0009, from `matrix_cell`                                                               |
| grenfell-0011 | 2 `paragraph`, 1 gold not in the evidence            | cites IWS00001156 ¶5 and ¶7 around the gold ¶6, which is not in the evidence                                          |
| grenfell-0015 | 2 `document`, 1 gold in the evidence not cited       | cites Edward Daffarn's IWS00000169 ¶50 and ¶51; IWS00001157 ¶55 is not cited                                          |
| grenfell-0016 | 2 `paragraph`                                        | cites IWS00000835 ¶62 and ¶64 beside the gold                                                                         |
| grenfell-0017 | 2 `paragraph`                                        | cites IWS00000835 ¶54 and ¶56 beside the gold                                                                         |
| grenfell-0013 | 1 `paragraph`, 2 gold not in the evidence            | ¶103 (the buckets of water) is not retrieved for a question that names it by its order; cites ¶105                    |
| grenfell-0010 | 1 `page`, 1 gold not in the evidence                 | cites IWS00001156 p1 ¶4; p2 ¶5 is not in the evidence                                                                 |
| grenfell-0020 | 1 `abstain-row`                                      | an abstain row that the model answers from the improvement works budget in IWS00000169 p126                           |

Rows 0002, 0003, 0025, 0032, 0039 and 0043 have one `page` or `paragraph` miss each; rows 0002,
0005 and 0014 have one gold locator that is not cited.

The next changes the evidence names:

1. Rows 0001, 0007, 0009, 0010 and 0011: the gold paragraph is not in the evidence. Read the
   fused rank of each gold chunk for its question; the claims of the first pages had covered 0007
   and 0011 by chance.
2. Row 0013: a tool that gives the paragraphs before and after a locator in the evidence, so that
   the model can read what comes before ¶105. Measure it against the `paragraph` misses of rows
   0012 and 0016, which cite neighbours of their gold.
3. Row 0023: check its gold against the whole finding paragraph, as rows 0001 to 0048 were here.
4. Row 0020: decide whether a question about a part of a cost is answered by the whole budget, then
   change the prompt or the row.

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, blocks at one locator and a longer walk

The same command and store as the lexical-boost run below, with `RERANK=off`, after four changes.
One run, from 23:21:29Z to 23:30:19Z. Spend: about $0.70 by the day's Sonnet rate; Cost Explorer
lags by hours. The run report is `evals/grenfell/runs/2026-10-21T23-30-19-836Z-bedrock-rerank-off.json`.

1. A passage block holds text of its own locator only. A passage hit took its previous and next
   passage at any locator: in IWS00000069 a hit in ¶88 showed the last sentence of ¶87 under the
   locator of ¶88, and ¶87 was then covered and had no block of its own.
2. The block walk reads the first 40 fused hits, up from 12, and stops at 12 blocks or the
   character budget. The first 12 hits often sit in one or two sections and collapse into a few
   blocks: row 0012 had 4 blocks and 5.9k of the 24k characters. Retrieval only, over the 50
   questions: 56 of the 67 gold locators are in the first evidence, up from 46 (rows 0002, 0005,
   0012, 0015, 0018, 0023, 0025, 0032, 0038, 0047), and no row loses one.
3. Two gold rows add locators that say what the report says. Row 0007 quotes the whole of finding
   11.71 and adds IWS00000913 p4 ¶16, p4 ¶18 and p21 ¶111. Row 0045 adds Jamal Stern's
   MET00012483 p12. Row 0006 stays: Stern's p11 tells the rescue from his side and does not say
   the tap on the leg. The gold set holds 71 locators.
4. The miss report lists the evidence blocks and the tool calls of each row.

A weight on the named rankings is rejected. Retrieval only, with change 2 in place:

| Fusion                                        | Gold in the first evidence | Rows that lose a gold locator      |
| --------------------------------------------- | -------------------------- | ---------------------------------- |
| every named ranking at weight 1               | 56 of 67                   | none                               |
| named rankings at weight 0.75                 | 53                         | 0002, 0032, 0038                   |
| named rankings at weight 0.5                  | 51                         | 0002, 0015, 0032, 0036, 0038, 0044 |
| only `namedPassage` and `namedLexicalPassage` | 53                         | 0025, 0038, 0044                   |

Row 0047's gold page is in the evidence in all four (block 7 at weight 1), so change 2 is its fix.

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.540 |
| citation recall           | 0.859 |
| unsupported-sentence rate | 0.143 |
| abstention correctness    | 0.980 |

The 113 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 61    |
| `paragraph`   | 27    |
| `page`        | 21    |
| `document`    | 3     |
| `abstain-row` | 1     |

The 71 gold locators: 61 cited, 9 retrieved but not cited (5 of them with the gold paragraph
itself in the evidence blocks), 1 not retrieved at all (row 0022).

Against the lexical-boost run (precision 0.530, recall 0.791, unsupported 0.140, abstention 0.960;
100 citations: 53 gold, 27 page, 16 paragraph, 3 document, 1 abstain-row; 67 gold: 53 cited, 12
retrieved not cited, 2 not retrieved: rows 0022 and 0047), precision rises 0.010, recall rises
0.068 on 4 more gold locators, the unsupported rate rises 0.003 and abstention rises 0.020. Gold
citations rise from 53 to 61: 4 from the gold rows (row 0007 three, row 0045 one) and 4 from
retrieval (rows 0015, 0018, 0038, 0047). Row 0047 no longer abstains and cites MET00008034 p8. Row
0038 cites both its gold locators. Row 0012 cites ¶87 and no longer cites IWS00001156 ¶14, which
is in its evidence. Non-gold citations rise from 47 to 52: `page` misses fall from 27 to 21 and
`paragraph` misses rise from 16 to 27. Of the 52, 36 are blocks of the first retrieval and 16 are
blocks that a tool call added; 41 of the 50 rows call `witness_claims`, which adds up to 50 claims
of one statement.

The rows that still miss:

| id            | miss                                                 | cause in the run                                                                                                                |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| grenfell-0023 | 10 `page` and `paragraph`                            | a list across two statements; every gold locator is cited                                                                       |
| grenfell-0012 | 4 `paragraph`, 1 gold in the evidence not cited      | cites IWS00000069 ¶85, ¶86, ¶88 and ¶89 around the gold ¶87 (cited); IWS00001156 ¶14 is in the evidence and not cited           |
| grenfell-0001 | 4 `page` and `paragraph`                             | cites four more paragraphs of IWS00000490 beside the gold, after `witness_claims` for that statement                            |
| grenfell-0022 | 1 gold not retrieved, 4 misses                       | names no witness and no flat; Petra Doulova's statement (IWS00000835 p9 ¶61) is not retrieved                                   |
| grenfell-0003 | 3 `page` and `paragraph`                             | cites three more paragraphs of IWS00000490 beside both gold locators                                                            |
| grenfell-0034 | 3 `page` and `paragraph`                             | cites IWS00000608 ¶49, ¶51 and ¶52 beside the gold                                                                              |
| grenfell-0013 | 2 `paragraph`, 2 gold retrieved not cited            | ¶103 (the buckets of water) is not in the evidence; the model searches for the bedroom fire and cites IWS00000069 ¶102 and ¶105 |
| grenfell-0009 | 2 `page` and `paragraph`, 1 gold retrieved not cited | cites IWS00000913 ¶102 and IWS00000990 ¶72                                                                                      |
| grenfell-0024 | 2 `page` and `paragraph`, 1 gold retrieved not cited | the same two paragraphs as row 0009, from `matrix_cell`                                                                         |
| grenfell-0015 | 2 `document`                                         | cites Edward Daffarn's IWS00000169 ¶50 and ¶51; every gold locator is cited                                                     |
| grenfell-0039 | 2 `page`                                             | cites Watson's MET00008044 p4 and p5 beside the gold p3, with no tool call; check them against finding 10.106                   |
| grenfell-0017 | 2 `paragraph`                                        | cites IWS00000835 ¶53 and ¶54 beside the gold                                                                                   |
| grenfell-0025 | 2 `page`                                             | cites IWS00000835 p1 and p1 ¶1 (the statement's opening)                                                                        |
| grenfell-0048 | 2 `page`                                             | cites MET00018800 p8 and p11 beside the gold                                                                                    |
| grenfell-0020 | 1 `abstain-row`                                      | an abstain row that the model answers from the improvement works budget in IWS00000169 p126                                     |

Rows 0002, 0004, 0007, 0010, 0011, 0016 and 0032 have one `page` or `paragraph` miss each; rows
0002, 0005, 0010 and 0014 have one gold locator in the evidence that is not cited.

The next changes the evidence names:

1. Gold checks of the rows whose question asks more than their quote holds, as row 0007 did: read
   each finding paragraph in full for rows 0001, 0003, 0034, 0039 and 0048, and add a locator only
   where the statement says what the finding says.
2. `witness_claims` without a predicate returns 50 claims of a statement, and 16 non-gold citations
   come from tool blocks. Rank its claims by the question, or cap them, and measure the misses.
3. Row 0013: ¶103 is not in the fused list of the question. The question asks what happened
   "immediately before" they left and the statement says "bucket" and "water"; read the context
   line of the chunk and the rewrite of the query.
4. Row 0020: decide whether a question about a part of a cost is answered by the whole budget, then
   change the prompt or the row.

### 2026-10-21, bedrock, `answer-closed-world-v4`, `ingest-v2`, 38 statements, 50 rows, reranker off, lexical boost and resident flat match

The same command and store as the fusion-boost run below, with `RERANK=off`, after three changes.
One run, from 22:35:37Z to 22:44:59Z. Spend: about $0.70 by the day's Sonnet rate; Cost Explorer
lags by hours. The run report is `evals/grenfell/runs/2026-10-21T22-44-58-960Z-bedrock-rerank-off.json`.

1. The witness name groups are a lexical boost. A query that names a witness keeps the lexical
   rankings over the corpus and adds the rankings that need a name of the witness beside them. A
   page witness filter stays a hard scope.
2. A flat names only its residents: `residentFlats` reads the flats of a role that starts with
   "resident". Of the 21 stored roles that name a flat, 16 are residents' roles; the 3 fire-brigade
   roles and the 2 relatives' roles name a flat that is not theirs.
3. Three gold rows add a locator of a second statement that says what the report's quote says:
   row 0012 IWS00000069 p15 ¶87, row 0013 IWS00000069 p18 ¶103, row 0015 IWS00000113 p3 ¶15. The
   gold set holds 67 locators.

The answer prompt stays at `answer-closed-world-v4`. Rows 0006 and 0020 name no common change:
row 0006 abstained because its gold paragraph was not in the evidence, and row 0020's evidence
holds a related figure (IWS00000169 p126, "nearly £10 million" for the whole improvement works).

| Metric                    | Value |
| ------------------------- | ----- |
| citation precision        | 0.530 |
| citation recall           | 0.791 |
| unsupported-sentence rate | 0.140 |
| abstention correctness    | 0.960 |

The 100 distinct cited locators by miss kind:

| `kind`        | Count |
| ------------- | ----- |
| `gold`        | 53    |
| `page`        | 27    |
| `paragraph`   | 16    |
| `document`    | 3     |
| `abstain-row` | 1     |

The 67 gold locators: 53 cited, 12 retrieved but not cited (4 of them with the gold paragraph
itself in the evidence blocks), 2 not retrieved at all (rows 0022 and 0047).

Against the fusion-boost run (precision 0.495, recall 0.797, unsupported 0.145, abstention 0.960;
103 citations: 51 gold, 22 page, 18 paragraph, 11 document, 1 abstain-row; 64 gold: 51 cited, 11
retrieved not cited, 2 not retrieved: rows 0022 and 0047), precision rises 0.035, recall falls
0.006 on 3 more gold locators, the unsupported rate falls 0.005 and abstention is the same.
`document` misses fall from 11 to 3 and `page` misses rise from 22 to 27. Row 0006 no longer
abstains and cites its gold. Row 0048 no longer cites Dean Nelson. The 3 `document` misses of
row 0012 become `paragraph` misses in IWS00000069, and rows 0003 and 0016 now cite every gold
locator. Row 0047 abstains again: its gold page ranks 20th in the corpus-wide lexical ranking
and still falls outside the evidence. Row 0038 cites 1 of its 2 gold locators against 2.

The rows that still miss:

| id            | miss                                      | cause in the run                                                                                                                                                              |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| grenfell-0047 | abstains, 1 gold not retrieved            | for the question text, MET00008034 p8 ranks 20th in the corpus-wide lexical passage ranking; Sener Macit's two statements gain from four named rankings and fill the evidence |
| grenfell-0022 | 1 gold not retrieved                      | names no witness and no flat; Petra Doulova's statement (IWS00000835 p9 ¶61) is not retrieved                                                                                 |
| grenfell-0013 | 2 gold retrieved not cited, 1 `paragraph` | the model cites IWS00000069 ¶105 (they leave the flat), the gold names ¶103 (the buckets of water); ¶103 is not in the evidence                                               |
| grenfell-0012 | 1 gold retrieved not cited, 3 `paragraph` | the model cites IWS00000069 ¶85, ¶88 and ¶89 around the gold ¶87, which is not in the evidence                                                                                |
| grenfell-0007 | 4 `page`                                  | cites four more paragraphs of Richard Fletcher's statement (IWS00000913) beside the gold                                                                                      |
| grenfell-0023 | 9 `page` and `paragraph`                  | a list across two statements; every gold locator is cited                                                                                                                     |
| grenfell-0006 | 1 `document`                              | cites MET00012483 p11 (Jamal Stern) beside the gold; check whether it holds the rescue that the finding quotes                                                                |
| grenfell-0045 | 1 `document`                              | the question names Crew Manager Stern, and the model cites his statement (MET00012483 p12); the gold names Hippel's only                                                      |
| grenfell-0015 | 1 `document`, 1 gold retrieved not cited  | cites Edward Daffarn's statement (IWS00000169 p15 ¶50); ¶55 of Hamid Wahbi is not cited                                                                                       |
| grenfell-0038 | 1 gold retrieved not cited                | cites MET00007764 p4 and not Angie Gotts' page 5 (MET00007694)                                                                                                                |
| grenfell-0020 | 1 `abstain-row`                           | an abstain row that the model answers from the improvement works budget in IWS00000169 p126                                                                                   |

The next changes the evidence names:

1. Rows 0012 and 0013: the gold paragraph of IWS00000069 is retrieved but not in the evidence,
   while its neighbours are. Read the block choice in `evidence.mjs` and the neighbour expansion in
   `expand.mjs` for a paragraph whose chunks rank below its neighbours'.
2. Row 0047: weight the named rankings against the corpus-wide ones, or link a witness to the
   roles of the witnesses who took his calls ("control room officer; floor 16 calls").
3. Check rows 0006 and 0045 against Jamal Stern's statement (MET00012483 p11, p12), as rows 0012,
   0013 and 0015 were.
4. Row 0020: decide whether a question about a part of a cost is answered by the whole budget, then
   change the prompt or the row.

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
