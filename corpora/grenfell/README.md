<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Grenfell Tower Inquiry

- **Source**: The National Archives' catalogue, series GTI 2 ("Grenfell Tower Inquiry: Evidence
  used in Public Hearings and for Investigation Reports", record `C19627767`), read through the
  Discovery API at <https://discovery.nationalarchives.gov.uk>. The inquiry's own website is
  archived behind a `robots.txt` disallow and a WAF challenge, so no fetcher reads it.
- **Licence**: Open Government Licence v3.0 (`OGL-3.0`) with third-party rights reserved,
  recorded per document in `manifest.jsonl`. The catalogue's `restrictionsOnUse` is copied to the
  manifest line as `restrictions_on_use` when it has a value.
- **Content**: witness statements as PDF, named `IWS<8 digits>.pdf`. The first slice is the open
  statements of floors 16 to 20 of the tower (exhibits excluded).
- **Files are scans**: each PDF is a page scan with an OCR text layer, not born-digital text.
  `pdftotext` returns the OCR ("lam the above named person"), so OCR errors reach the chunks.
- **Answer key**: the Phase 1 report's findings, with paragraph locators, are the gold set source
  (see `evals/README.md`).
- **Report**: `raw/report/phase1-volume-1.pdf` to `-4.pdf` and `phase1-executive-summary.pdf` (gitignored).

## Rules

The scraping rules in `corpora/README.md` apply: honour `robots.txt`, 1 request per second, every
original byte kept with its SHA-256 and source URL, and the licence stored per document. Both
scripts read `robots.txt` at the start of each run, refuse any URL it disallows and send
`User-Agent: concordance-research/0.1 (+antony@polycode.co.uk)`.

## Two records per statement

Each statement has two catalogue records:

| Reference        | Record id         | Closure             | Content                                 |
| ---------------- | ----------------- | ------------------- | --------------------------------------- |
| `GTI 2/<id>/Z`   | 32 hex characters | closed for 82 years | the unredacted original                 |
| `GTI 2/<id>/Z/1` | ends `_1`         | open                | the redacted copy the inquiry published |

The open `/Z/1` copies are the corpus. Where a statement has only an open `/Z` record, that
record is used.

## Commands

```bash
npm run corpus:grenfell:index            # sources.json from the Discovery API
npm run corpus:grenfell:import           # manifest.jsonl from the files in raw/
node corpora/grenfell/import.mjs --order <ordernumber> --receipt <digitalreceipt>
node corpora/grenfell/import.mjs --links <file>
```

`discovery.mjs` pages the series search (sorted by title, because unsorted pages overlap and skip
records), keeps open PDF records, reads flat, floor and kind from each description, drops exhibits
and any floor outside the range, and makes one details call per statement for the date.
It rewrites the same `sources.json` on every run.

## Fire brigade statements

The London Fire Brigade statements are catalogued in the same series as police-provided records:
titles `MET<digits>.pdf`, descriptions `Witness Statement - LFB - <name> Evidence provided by:
Metropolitan Police Service.` (dash and capitalisation vary; some carry a bracketed note).
`discovery.mjs` runs a second search, `Witness Statement LFB`, and keeps the records that match
that shape. The floor range does not filter them: their `floor` and `flat` are null and `role`
is `London Fire Brigade`, with the rank added when the name carries one. `roles.json` maps an
evidence id to a role from the Phase 1 report's account and replaces the default. The operator
orders them the same way as the resident statements, in orders of 10.

## Downloads

The catalogue serves a PDF only to a download link that comes from an order. The operator places
the order in Discovery's basket, which `robots.txt` disallows for machines: 10 items an order,
100 items in 30 days. `import.mjs` has two ways to use an order:

- `--order <ordernumber> --receipt <digitalreceipt>` builds the link for every `sources.json`
  entry that has no file. The number and receipt cover only the items in that order, so an item
  outside the order gets a 4xx, which the script reports as `missing` and does not retry.
- `--links <file>` takes pasted download links, one a line, and uses each as given.

`import.mjs` prints one line per entry: `present`, `fetched`, `missing` or `mismatch`, then the
counts. A body that is not a PDF is `missing`. A SHA-256 or byte count that differs from
`raw/downloads.jsonl` or from the manifest is `mismatch`; that entry gets no manifest line and the
exit code is 1. A second run changes nothing.

## Layout

`raw/`, `text/`, `chunks/` and `media/` are gitignored. `raw/downloads.jsonl` has one line per
download: `file`, `id`, `reference`, `url`, `fetched_at`, `bytes`, `sha256`, `content_type`,
`description`.

`manifest.jsonl` is committed and has one line per document:

| Key                   | Value                                                      |
| --------------------- | ---------------------------------------------------------- |
| `url`                 | the download link, else the record page                    |
| `sha256`, `bytes`     | of the file in `raw/`                                      |
| `fetched_at`          | ISO 8601 UTC                                               |
| `licence`             | `OGL-3.0`                                                  |
| `evidence_id`         | `IWS<8 digits>`                                            |
| `reference`           | catalogue reference, `GTI 2/XXXX/Z/1`                      |
| `discovery_id`        | catalogue record id                                        |
| `restrictions_on_use` | the open record's `restrictionsOnUse`, when it has a value |

`sources.json` is committed and has one entry per statement. The ingest reads `evidence_id`,
`file`, `url`, `role`, `witness_id`, `floor` and `statement_date`; the other keys are
`witness`, `kind` (`statement`, `supplementary`, `relative`), `flat`, `flat_as_written`,
`floor_as_written`, `reference`, `discovery_id`, `restrictions_on_use`, `description` (the
catalogue text) and `closure`.

Descriptions give the flat and floor in prose. Floor N holds flats (N-3)x10+1 to +6, so the flat
fixes the floor. When flat and floor disagree, the flat wins if it is a valid flat number, and a
swapped pair ("Flat 4, 16th Floor" is Flat 16 on floor 4) is swapped back. The `_as_written`
keys keep what the catalogue says.

The statements are about real deaths. Use them respectfully, name the inquiry on screen, and do
not synthesise what a witness meant.
