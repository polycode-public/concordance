<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# corpora

One directory per corpus. Each corpus keeps its originals and derived files locally and commits
only its `README.md` and `manifest.jsonl`.

## Scraping rules

1. Honour `robots.txt` for every host.
2. Send at most 1 request per second to a host.
3. Keep every original byte untouched. Record its SHA-256 and its source URL.
4. Store the licence for each document.
5. Never re-host material in a way that could pair a cipher with an identity.

## Layout

```
corpora/<corpus>/
  README.md        source, licence and corpus notes (committed)
  manifest.jsonl   one line per fetched document (committed)
  raw/             original bytes as fetched (gitignored)
  text/            extracted canonical text with position maps (gitignored)
  chunks/          chunk files at the four levels (gitignored)
  media/           audio, video and derived transcripts (gitignored)
```

## Manifest line

```json
{
  "url": "https://...",
  "sha256": "<64 hex>",
  "bytes": 123456,
  "fetched_at": "2026-10-18T12:00:00Z",
  "licence": "OGL-3.0",
  "evidence_id": "IWS00001200"
}
```
