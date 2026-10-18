<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Grenfell Tower Inquiry

- **Source**: <https://www.grenfelltowerinquiry.org.uk/node/1267> (witness evidence).
- **Licence**: Open Government Licence v3.0 (`OGL-3.0`), recorded per document in `manifest.jsonl`.
- **Content**: witness statements as born-digital PDF with evidence ids (`IWS00001200` style),
  hearing transcripts (PDF and ODT), hearing video, video exhibits and 999 call transcripts. Each
  witness has one zip.
- **Answer key**: the Phase 1 report's findings, with paragraph locators, are the gold set source
  (see `evals/README.md`).

## Rules

The scraping rules in `corpora/README.md` apply: honour `robots.txt`, 1 request per second, every
original byte kept with its SHA-256 and source URL, and the licence stored per document.

## Layout

`raw/`, `text/`, `chunks/` and `media/` are gitignored. `manifest.jsonl` is committed and has one
line per fetched document with `url`, `sha256`, `bytes`, `fetched_at`, `licence` and
`evidence_id`.

The statements are about real deaths. Use them respectfully, name the inquiry on screen, and do
not synthesise what a witness meant.
