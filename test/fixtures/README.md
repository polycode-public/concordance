<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Statement page fixtures

Each `.txt` file holds the page text of two pages of a Grenfell Tower Inquiry witness statement.
Pages are separated by a form feed. The text is what `pdfToPagesFromBuffer` (pdf.js) returns for
the PDF, byte for byte, including the OCR errors of the source ("12.1 opened", "3, I was bom").

| File                        | Statement   | Pages |
| --------------------------- | ----------- | ----- |
| `IWS00000990-pages-1-2.txt` | IWS00000990 | 1-2   |
| `IWS00000913-pages-3-4.txt` | IWS00000913 | 3-4   |
| `IWS00000490-pages-1-2.txt` | IWS00000490 | 1-2   |

Source: Grenfell Tower Inquiry, witness statements, https://www.grenfelltowerinquiry.org.uk

Licence: Crown copyright, reproduced under the Open Government Licence v3.0
(https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

`MG11-unnumbered-pages-1-3.txt` is a made-up police statement form of three pages with invented
sentences: prose paragraphs without numbers and the three header lines on every page. It is not
a real statement.

`backfill/grenfell/` holds a made-up `manifest.jsonl` and `sources.json` of four documents for
`scripts/backfill-aliases.mjs`. The names and evidence ids are invented.
