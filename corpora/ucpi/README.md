<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Undercover Policing Inquiry

The second corpus, id `ucpi`. The page lists it in the header's drop list beside Grenfell; a
conversation, a report or an accepted fact made with it selected belongs to it, and retrieval
reads only its chunks.

- **Source**: the evidence pages of the Undercover Policing Inquiry, <https://www.ucpi.org.uk>.
- **Content**: witness statements as PDF, referenced `UCPI0000…` or `MPS-…` (the inquiry's own
  evidence numbers, used as the document id). The first slice held three statements; the second
  adds ten around HN43: two Special Demonstration Squad managers, two officers of the same unit,
  and six people the unit reported on, one with two statements. The slice holds two kinds of
  witness:
  - undercover officers of the Special Demonstration Squad and the National Public Order
    Intelligence Unit, named by an `HN` cipher (`HN1`, `HN10`, …) and by the cover name they used;
  - the people they reported on or who knew them under the cover name.
- **Licence**: Crown copyright. Read the licence line on each document's page when it is fetched
  and store it per document in `manifest.jsonl`; record nothing here that the page does not state.
- **Ciphers**: an `HN` cipher is a witness id. A witness known only by a cipher is `cipher_only`
  in the witness register, and the system holds no real name for it. A document pair that
  reveals an identity together is recorded in `identity_revealing_pairs`, and the page refuses
  to show it side by side.
- **Shared events**: none are defined yet; `sharedEventsFor("ucpi")` returns an empty list
  until the slice is read.

## Layout

As for every corpus (`corpora/README.md`): `manifest.jsonl` committed, one line per fetched
document; `raw/`, `text/`, `chunks/` and `media/` gitignored. The originals go to the bucket
under `ucpi/raw/<UCPI id>.pdf`, which the document route reads by the corpus the store records.

## Rules

The scraping rules in `corpora/README.md` apply: honour `robots.txt`, 1 request per second, every
original byte kept with its SHA-256 and source URL, and the licence stored per document.
