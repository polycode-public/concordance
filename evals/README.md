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

| Field           | Type                    | Meaning                                                        |
| --------------- | ----------------------- | -------------------------------------------------------------- |
| `id`            | string                  | Stable row id.                                                 |
| `question`      | string                  | The question as a user types it.                               |
| `gold_locators` | array                   | The locators a correct answer cites; empty for an abstain row. |
| `expected`      | `"answer"`, `"abstain"` | `abstain` when the corpus does not cover the question.         |

## Where gold comes from

Every gold row comes from the inquiry report's own findings: the Phase 1 report states what each
witness said and cites the statement paragraph. Each row records that locator. A gold row is never
invented, paraphrased from memory or written from model output.
