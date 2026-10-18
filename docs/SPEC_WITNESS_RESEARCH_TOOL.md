# Witness Research Tool — Demo Spec

Oct 18, 2026 · @Antony

## In one line

Yes: several public inquiries and tribunals publish hundreds to thousands of witness statements and testimony transcripts about one event or conflict, and the demo uses one of them, the Grenfell Tower Inquiry, with cloud ingest capped at $25. The rest of this spec covers the demo architecture on AWS, its port to a MacBook Pro, chunking, citation and hallucination controls, the fact-triple consistency engine, the realtime conversation layer, options, standards and the demo pitch.

Scope assumptions: single-tenant demo, Grenfell only, about 15,000 pages plus media transcribed on the laptop, cloud ingest spend capped at $25 with a billing alarm, no real ICC evidence touches the system.

## Datasets

Use Grenfell alone for the demo: every media type, an open licence, born-digital PDFs that need no OCR, and witness subsets that cover the same minutes from different floors and crews. The other rows are the roadmap, Bloody Sunday first for decades-apart statement changes and the Afghanistan inquiry for ciphered witnesses. Volumes marked approximate come from memory, not the pages opened.

| Role | Corpus | Event | Volume | Formats and media | Why it fits | Access |
| --- | --- | --- | --- | --- | --- | --- |
| Demo | [Grenfell Tower Inquiry](https://www.grenfelltowerinquiry.org.uk/node/1267) | Fire, 14 June 2017, one building, one night | Hundreds of witness statements, \~300 hearing days (approximate); demo slice about 15,000 pages and 40 hearing days | Witness statements as PDF with evidence IDs (IWS00001200 style), hearing transcripts PDF + ODT, hearing video, mp4 video exhibits, bodyworn camera, CCTV stills, 999 call transcripts; one zip per witness | Residents by floor, firefighters by crew, control-room operators, 999 callers, council and contractor witnesses describe the same minutes; written statements (2018 to 2019) versus later oral evidence give self-consistency pairs; the Phase 1 report is the answer key; Open Government Licence v3 | Public web, no registration |
| Roadmap | [Bloody Sunday Inquiry (Saville)](https://beta.nationalarchives.gov.uk/catalogue/id/C11669677) | Shooting, 30 January 1972, one afternoon | \~2,500 statements, \~900 oral witnesses, 434 hearing days (approximate) | Statements and transcripts as HTML/PDF in the UK Government Web Archive; 1972 Widgery statements and \~500 NICRA statements on [CAIN](https://cain.ulst.ac.uk/events/bsunday/irgovt1.htm) | Soldiers' 1972 statements differ from their 1998 to 2004 statements; a conflict case with a known answer key in the Saville report | Public record, Crown copyright |
| Roadmap | [Independent Inquiry relating to Afghanistan](https://www.iia.independent-inquiry.uk/documents/transcripts/) | UK special forces detention operations, mid-2010 to mid-2013, many raids | 21 open hearing days to 15 October 2026, corporate witness statements, gists of closed evidence | PDF transcripts on S3, hearing video on YouTube, Dari and Pashto site versions | Afghanistan; ciphered witnesses (N1799 style) under a Restriction Order, the test case for cipher-only mode | Public web; Restriction Order forbids identifying ciphered witnesses |
| Roadmap | [ICTY / ICTR / IRMCT Unified Court Records](https://peacepalacelibrary.nl/publication/unified-court-records-database) | Yugoslav and Rwandan conflicts; Srebrenica litigated in six trials | Hundreds of thousands of pages | Transcripts, exhibits, audiovisual hearing recordings, English, French, B/C/S, Kinyarwanda | Same witnesses testify in several trials years apart; closest to the audience's own court records | ucr.irmct.org, free registration |
| Roadmap | [FDNY World Trade Center interviews](https://www.firehouse.com/home/news/10507465/fdny-releases-oral-histories-transmissions-from-sept-11) | 11 September 2001, one morning | 503 oral histories, \~12,000 pages | Transcripts as PDF, 15 hours of radio audio; \~500 further responder oral histories with audio at the [Library of Congress](https://www.newswise.com/articles/hundreds-of-first-hand-911-responder-accounts-now-available-online) | Hundreds of subsets of one event, strong timeline signal | Public web |
| Roadmap | [Hillsborough Independent Panel](https://ckan.publishing.service.gov.uk/dataset/hillsborough-disclosure) | Crush, 15 April 1989, one afternoon | \~450,000 pages from \~80 organisations | Scanned PDFs with OCR of varying quality, CSV index on data.gov.uk | 164 police statements in original and altered versions, a ready-made diff task; OCR noise tests the ingest | Public web, archive migrated to The National Archives |

Reserve list: ICC public transcripts for Ongwen and Ntaganda on icc-cpi.int (the audience's own format), Post Office Horizon Inquiry (YouTube plus transcripts), Manchester Arena Inquiry, South African TRC hearing transcripts, Special Court for Sierra Leone (rscsl.org), ECCC (Khmer Rouge) records.

Scraping rules: honour robots.txt and rate-limit to 1 request/s; keep every original byte with its SHA-256 and source URL; store the licence per document; never re-host IIA material in a way that could pair a cipher with an identity.

## Architecture

One Postgres (pgvector + tsvector + a triples table) replaces a vector database, a search engine and a triple store, and that is what makes the laptop port a config change rather than a rewrite.

&#91;embedded content: architecture · 3 lanes, 9 components, each with an AWS and a laptop form\]

Ingest runs once and may take hours; the store is a single Postgres with three schemas; the serving lane is the only part that must answer in under a second. Every box swaps its AWS form for its laptop form by changing one adapter.

AWS demo, all scale-to-zero:

1. S3 for originals (`raw/`), derived text (`text/`), chunk files (`chunks/`) and media; object versioning on; SHA-256 in object metadata.
2. Aurora Serverless v2 Postgres 16 with pgvector 0.8 (HNSW index, halfvec for 1024-dim) and tsvector for BM25-style lexical search; min ACU 0.5 so it pauses when idle; the `facts` table holds subject, predicate, object, polarity, source chunk id, extraction model and confidence.
3. Lambda (Node 22 ESM, arm64) for every step; Step Functions Standard for the ingest map over documents and for nightly consistency runs; SQS between fetch and extract so a bad PDF does not block the batch.
4. Bedrock: Titan Text Embeddings v2 or Cohere Embed v3 for vectors (1024-dim), Claude Haiku for triple extraction and chunk-context headers, Claude Sonnet for the chat turn. Bedrock Guardrails off for the demo; grounding checks are done in code (hallucination section).
5. Textract and Transcribe stay switched off for the demo: Grenfell PDFs are born-digital (pdftotext), and media is transcribed on the laptop with whisper.cpp and the transcripts uploaded as derived files with word timestamps and speaker labels. Both stay behind the provider interface for later corpora.
6. API Gateway WebSocket for the chat stream and HTTP API for document fetch; CloudFront + S3 for the static ESM UI; Cognito for one demo user; CloudFront signed URLs for media so originals never go public.
7. CDK in Java (Maven) or TypeScript; GitHub Actions with bash steps; `cdk deploy` from a tag.

Laptop port (MacBook Pro, 64 GB or more):

1. Ollama or llama.cpp serving an OpenAI-compatible endpoint; the Bedrock client is behind an interface with two implementations, selected by `MODEL_PROVIDER`.
2. Postgres 16 + pgvector in Docker or Homebrew; identical schema and migrations.
3. whisper.cpp (large-v3-turbo) for ASR, Tesseract 5 or PaddleOCR for OCR, ffmpeg for media.
4. Node 22 running the same handler modules behind a tiny HTTP + WebSocket server (ws package); the Lambda entry points are thin wrappers around those modules.
5. Ingest throughput at Qwen 2.5 7B on an M-series Max: about 300 to 600 pages/hour for triple extraction, embeddings at thousands of chunks/minute; a 20,000-page corpus is an overnight job.

Model sizing, local: embeddings nomic-embed-text v1.5 or bge-m3 (bge-m3 if Dari/Pashto/B/C/S matter); chat Qwen 2.5 14B Instruct Q4\_K\_M or Llama 3.1 8B; extraction Qwen 2.5 7B with constrained JSON output; reranker bge-reranker-v2-m3. Keep embedding dimension and model name in every chunk row so a model change triggers a re-embed rather than a silent mismatch.

## Ingest and chunking

Store four chunk levels per document, each row carrying the same document header, so a hit at any level resolves to a page, a paragraph span, and for media a timecode.

Ingest steps, in order:

1. Fetch; write the original untouched; record URL, fetch time, HTTP headers, SHA-256, licence, source archive.
2. Classify format: born-digital PDF, scanned PDF, HTML, ODT/DOCX, image, audio, video.
3. Extract to a canonical text file with position maps: page and bounding box for PDFs, timecode per segment for media, line numbers for transcripts (court transcripts already carry page:line, keep them as the canonical locator).
4. Normalise names and ciphers: a witness register maps every spelling and cipher (Soldier F, N1799, IWS00001200) to one witness id without ever storing a real identity for a ciphered witness.
5. Segment into sections by the document's own structure (statement paragraphs are numbered; transcripts have Q/A turns; inquiries have exhibit IDs).
6. Write the document header: title, witness id, role (resident, soldier, firefighter), date of statement, date of event covered, taking body (NICRA, Treasury Solicitor, Inquiry), language, page count, locator scheme.
7. Chunk at four levels and embed each; extract facts from the sentence level; store everything with a `pipeline_version`.

Chunking schemes:

| Level | Unit | Size | Embedding text | Use |
| --- | --- | --- | --- | --- |
| Document | Whole statement or transcript | Any | Header + a 200-word model-written abstract, not the full text | Which witnesses are relevant at all; grouping; dedup of re-served statements |
| Section | Numbered paragraph block, Q/A exchange, transcript page | 300 to 800 tokens | Header line + the model-written one-sentence context line + section text | Default retrieval unit; what the chat quotes |
| Passage | Sliding window of 3 to 5 sentences, stride 2 | 80 to 200 tokens | Header line + passage | Precise citation; adjacent-context expansion pulls the neighbours |
| Sentence | One sentence or one Q or A turn | 10 to 60 tokens | Context line + sentence | Fact extraction, contradiction pairs, timeline building |

Contextual headers: every embedded string is prefixed with a fixed header, for example `[Grenfell Inquiry | Witness IWS00001200 | resident, floor 18 | statement 6 Aug 2019 | event 14 Jun 2017 | p.3 para 11]`, and section and passage chunks also carry a one-sentence context line written by the extraction model ("The witness describes leaving flat 151 by the stairs between 01:15 and 01:30"). This is the Anthropic contextual-retrieval pattern and it cuts misses from pronoun-only chunks by about a third to a half in published tests.

Adjacent context: each passage row stores `prev_id` and `next_id`; retrieval returns the hit plus one neighbour each side by default and the full section on request, with the hit sentences marked so the citation stays exact.

Media: audio and video are transcribed with word timestamps and diarisation; chunks map to `[start_ms, end_ms]`; the UI seeks the player to `start_ms` minus 3 s. Keep a frame thumbnail per minute for video so a hit shows a picture. Scanned images get OCR text plus a bounding box per line so a citation can highlight on the scan.

Languages: bge-m3 or Cohere Embed multilingual if any corpus is not English; store `lang` per chunk and never translate the canonical text, translate on display with the translation marked as machine output.

## Retrieval and citations

Retrieve hybrid (vector + lexical), rerank, expand to neighbours, and make the model cite chunk ids that the server resolves to locators; the model never writes a citation string itself.

Query pipeline per chat turn:

1. Rewrite: the chat model turns the user turn plus the last three turns into one to three standalone queries and a filter set (witness ids, date range, document type, event tag).
2. Lexical: tsvector query with the witness register expanding names and ciphers; exact-phrase search for quoted strings.
3. Vector: top 40 at passage level and top 20 at section level, HNSW, cosine.
4. Fuse with reciprocal rank fusion; rerank the top 60 with a cross-encoder (Bedrock Cohere Rerank 3.5, local bge-reranker-v2-m3); keep the top 12.
5. Expand: add prev and next passage for each hit; collapse hits that share a section into that section; cap at \~6,000 tokens of context.
6. Answer: the model receives numbered evidence blocks `[E1] … [E12]`, each with header and locator, and must write `[E3]` after every sentence that relies on evidence. Sentences with no tag are rendered in grey and labelled "unsupported".
7. Resolve: the server maps `[E3]` to document id, locator (page:line, paragraph number, or timecode), and a signed URL; the UI renders the citation chip, the referenced-documents panel, and the deep link.

Referenced-documents panel: every document cited in the session appears once with title, witness id, role, date, type icon, number of citations, and a button that opens the original at the first cited locator; the panel is the session's bibliography and is exported with the transcript.

Locator formats to support: PDF page + text span (highlight via PDF.js `find`), transcript page:line, statement paragraph number, image bounding box, media `start_ms` to `end_ms`. Every locator is stored in the chunk row at ingest, never derived at query time.

Filters the UI exposes: witness, role, source body, statement date, event window, document type, language, and "accepted facts only" (facts section).

## Hallucination controls

Treat the model as a drafter of claims that the system then checks against the evidence it was given, and show the user which claims passed; a prosecutor's tool needs auditability more than fluency.

Controls, in the order they act:

1. Closed-world prompt: the model answers only from the evidence blocks, says "the corpus does not say" when they do not cover the question, and never uses prior knowledge about the real event (Grenfell and Bloody Sunday are in every model's training data, so this matters for the demo).
2. Citation-per-sentence, enforced in code: the response is split into sentences; each must carry at least one `[En]` or be flagged. Flagged sentences render grey; a response with more than 30% flagged sentences is returned with a warning banner.
3. Entailment check: for each sentence and its cited chunk, a second, cheaper call (Haiku, local Qwen 7B) answers supported / partly / not supported with a quoted span from the chunk. Not-supported sentences get a red marker; the quoted span is what the hover shows.
4. Quote verification: any text in quotation marks is string-matched against the cited chunk after whitespace and Unicode normalisation; a non-match is replaced with the nearest real span and marked as corrected.
5. Number and date guard: every number, date and time in the answer is checked for presence in the cited chunks; absent values are flagged.
6. Abstention: if the reranker's top score is below a threshold tuned on the eval set, the system answers with the three closest sections and no narrative.
7. Temperature 0 for the answer, structured JSON output for extraction, and a fixed prompt version stored with every response.
8. Eval set: 150 question and answer pairs per corpus with gold locators, built from the inquiry reports' own findings (Saville and Moore-Bick state what each witness said); track citation precision, citation recall, unsupported-sentence rate and abstention correctness in CI; a model or prompt change that lowers citation precision fails the build.
9. Session log: every turn stores query rewrites, retrieved ids, reranker scores, prompt version, model id and the raw model output, so any answer can be replayed and audited.

What the user sees: sentence-level colour (black supported, grey unsupported, red contradicted), hover to see the exact supporting span, and a per-answer score line such as "11 of 12 sentences supported, 2 numbers checked". The score line is the single most persuasive element in a demo to lawyers.

## Fact store and consistency engine

Extract one assertion per sentence as a quintuple (witness, event, claim, time, place) with polarity and hedging, store it with its sentence id, and run three comparisons: the same witness against themselves across documents, witnesses against each other on the same event, and everyone against the accepted-facts set.

Representation: plain triples lose who said it and when, so use an event-centred model. In Postgres: `assertions(id, witness_id, source_chunk_id, event_id, predicate, object_text, object_entity_id, time_text, time_start, time_end, place_text, place_entity_id, polarity, modality, confidence, extractor, pipeline_version)`. Expose a `triples` view (subject, predicate, object) for SPARQL-minded users and export as RDF with reification or RDF-star; the sentence is the named graph. Entities (people, places, vehicles, units) live in a register with aliases; events are user-defined ("shooting at the rubble barricade", "first floor 4 door opened") with a time window and place.

Extraction: the extraction model receives the sentence, its two neighbours and the document header, and returns JSON validated against a schema; the schema forbids values absent from the text. Low-confidence rows are stored but excluded from comparisons by default.

Accepted facts: a curated table the analyst builds in the UI by promoting assertions or typing them in, with a source citation required for each (the inquiry report's paragraph number works for the demo). Everything else is a witness assertion, never a fact.

Comparisons, run nightly and on demand:

1. Alignment: candidate pairs of assertions about the same event and the same predicate, found by vector similarity on the claim text plus entity overlap.
2. Classification: an NLI model (DeBERTa-v3 NLI locally, or the chat model) labels each pair agree / contradict / unrelated with a one-line reason and the two quoted spans.
3. Grouping: contradictions are grouped by event and predicate so the UI shows "time first shot fired: 7 witnesses say 16:07 to 16:10, 2 soldiers say 16:15".
4. Self-consistency: the same witness's assertions across documents ordered by statement date; a changed value is flagged with both dates (Bloody Sunday 1972 vs 1999 statements, Hillsborough original vs amended).
5. Against accepted facts: each witness assertion labelled consistent / inconsistent / not covered.

Outputs: a contradiction matrix per event (witnesses on both axes), a per-witness consistency report, a timeline view with each assertion as a point and its uncertainty as a bar, and a diff view for two versions of one witness's account. Every cell links back to the two source sentences.

Session facts: assertions the user makes in chat ("assume the first shot was at 16:07") are stored as session-scoped accepted facts, marked as hypotheses, and included in the comparison so the user can test a theory against the corpus and discard it.

## Conversation layer

One WebSocket per browser tab, one thread per topic, every model call cancellable by thread id, and the UI built as raw ESM modules with a PDF viewer and a media player that accept deep links from citations.

Protocol (JSON frames over WebSocket, same on API Gateway and the local `ws` server):

1. `client → server`: `{type:'turn', thread, turnId, text, attachments[]}`, `{type:'cancel', thread, turnId}`, `{type:'open', docId, locator}`.
2. `server → client`: `{type:'status', thread, turnId, stage}` (rewriting, retrieving, answering, checking), `{type:'token', thread, turnId, text}`, `{type:'evidence', thread, turnId, blocks[]}`, `{type:'done', thread, turnId, checks}`, `{type:'cancelled'}`.
3. Interruption: a new turn on a thread sends `cancel` for the in-flight turn; the Lambda aborts the Bedrock stream with an AbortController and the partial answer stays on screen marked "interrupted". On AWS, the WebSocket Lambda posts to a per-thread SQS FIFO queue and a worker Lambda streams back through the management API, so a cancel is a message the worker polls between tokens.
4. Threads: the UI shows threads as tabs or a side list; each thread has its own retrieval filters and its own session facts; a message can be "forked" into a new thread with the evidence carried over.
5. Voice: optional. Browser `MediaRecorder` → Transcribe streaming (or whisper.cpp locally) → text turn; replies via Polly or local Piper. Leave out of the first demo unless the audience works by voice; it adds latency and failure modes.

UI modules (ESM, no framework): `chat.js` (threads, streaming, citation chips), `evidence.js` (referenced-documents panel), `viewer-pdf.js` (PDF.js with highlight at locator), `viewer-media.js` (`<video>`/`<audio>` with transcript sync and seek to `start_ms`), `viewer-image.js` (OpenSeadragon or plain `<img>` with box overlay), `facts.js` (assertion table, promote-to-accepted, contradiction matrix), `timeline.js` (SVG, assertions by time). Styling with CSS custom properties; keyboard shortcuts for next citation and open source.

Latency budget on AWS: rewrite 0.4 s, retrieval 0.3 s, rerank 0.4 s, first token 0.8 s, checks run after `done` and update the colours within 2 to 4 s. Locally with a 14B model: first token 1 to 2 s, 20 to 40 tokens/s on an M3 Max class machine; checks 5 to 10 s. Both feel like a conversation if status frames show progress.

Media playback: signed CloudFront URLs with a 10-minute lifetime; HLS not needed for demo-sized files; the transcript panel scrolls with playback and each segment is itself a chunk you can cite.

## Critique and improvements

The plan is sound on retrieval and weak on three things: the consistency engine is the product and RAG chat is the on-ramp, the triple model needs attribution built in, and "runs on a laptop" must be a tested path from day one rather than a port at the end.

1. Lead with contradictions, not chat. A head of investigations has seen chatbots; a matrix showing that seven witnesses place the first shot before a soldier's stated time, each cell a click from the source, is the thing nobody has. Build the fact store in week one.
2. Plain triples will fail. "Soldier F fired at the barricade" needs who said it, when they said it, how sure they were and whether they later changed it. The assertion table above keeps that; a bare RDF graph would merge contradictory claims into one node.
3. Open-weight models hallucinate more than frontier ones, so the checking layer is doing the work the model cannot. Budget two cheap calls per answer (entailment, extraction) rather than one expensive one; that ratio is what keeps the laptop path viable.
4. Multiple chunk levels multiply storage and index time by about four; at 15,000 pages that is about 100 MB of vectors, the $25 cap is the corpus cap, and the ingest cost per 1,000 pages goes on a slide.
5. Full-text search is not optional. Investigators search for names, ciphers and exhibit numbers; vectors are poor at exact tokens. The hybrid design covers it, so do not let it get cut for time.
6. Postgres over a dedicated vector database. One engine, one backup, one Docker image locally, transactions across chunks and facts; Neptune, OpenSearch Serverless and Pinecone each add a service with no laptop equivalent and a cost floor that is not zero.
7. ICC reality: the OTP's 2025 cyber-enabled crimes policy puts digital evidence and AI on the agenda, and the Office reports about 57 TB of electronic evidence, so the audience will ask about disclosure obligations. A tool that surfaces exculpatory contradictions as readily as inculpatory ones is a selling point and an obligation (Rome Statute art. 67(2)); say so.
8. Air-gap is a feature, not a port. Build the local path first with a 7B model, then swap in Bedrock for the demo; the reverse order leaves prompts tuned for a model the court cannot run. Keep an `evals/` run that passes on both providers.
9. Redaction and ciphers: the IIA corpus has a Restriction Order; the ICC has protective measures (Rule 87). The witness register must support a cipher-only mode where no real identity exists in the system, and the UI must refuse to display two documents side by side if that pairing is marked as identity-revealing. Showing this in the demo answers the first security question.
10. Chain of custody: hash on ingest, hash on every derived file, a provenance record (W3C PROV-O or a simple table) linking derived text to original to model version; without it nothing from the tool can be referred to in a filing.
11. Scope creep risks: voice, video face blurring, multilingual, entity resolution across corpora. Each is a second-phase item; list them on the roadmap slide and leave them out of the build.
12. Ethics of the test data: Grenfell and Bloody Sunday statements are public but about real deaths; the demo should use them respectfully, name the inquiries on screen, and not synthesise "what the witness really meant".

## Options

The recommended column is the one the architecture above assumes; the others are what to say when someone asks "why not X".

| Layer | Recommended | Alternative | Trade-off |
| --- | --- | --- | --- |
| Vector + text store | Postgres 16, pgvector 0.8 HNSW, tsvector | LanceDB (embedded, file-based); OpenSearch Serverless | LanceDB is simpler locally but has no transactions with the facts table; OpenSearch has a cost floor of about $700/month and no laptop twin |
| Embeddings, cloud | Cohere Embed v3 multilingual on Bedrock | Titan Text Embeddings v2 | Titan is cheaper and English-strong; Cohere handles Dari, Pashto, B/C/S |
| Embeddings, local | bge-m3 (1024-dim, multilingual) | nomic-embed-text v1.5 (English, 8k context) | nomic is faster; bge-m3 matches Cohere's languages |
| Chat model, cloud | Claude Sonnet on Bedrock | Claude Haiku; Llama 3.x 70B on Bedrock | Haiku is 5 to 10× cheaper and adequate once the checker runs; Llama 70B on Bedrock is the closest proxy for what the court can self-host |
| Chat model, local | Qwen 2.5 14B Instruct Q4 | Llama 3.1 8B; Mistral Small 24B; Qwen 32B if 96 GB RAM | 14B is the floor for reliable citation tagging; 8B needs stronger post-checks |
| Extraction model | Claude Haiku / Qwen 2.5 7B with JSON schema | GLiNER + REBEL (small specialised extractors) | Specialised extractors are 10× faster but need event-schema training; fine for a later phase |
| Reranker | Cohere Rerank 3.5 / bge-reranker-v2-m3 | None (RRF only) | Dropping the reranker costs about 10 to 20 points of citation precision on long corpora |
| NLI for contradictions | DeBERTa-v3-large MNLI locally; chat model on AWS | Chat model everywhere | DeBERTa runs 100 pairs/s on CPU and gives stable labels; the chat model gives better reasons |
| OCR | Textract / Tesseract 5 | PaddleOCR; Surya | Surya is better on degraded scans (Hillsborough) but heavier to install |
| ASR | Transcribe / whisper.cpp large-v3-turbo | faster-whisper (Python) | whisper.cpp is a single binary with Metal acceleration; Python stacks are easier to extend |
| Triple export | Postgres table + RDF-star export | Oxigraph embedded triple store with SPARQL | Oxigraph is a one-binary SPARQL endpoint if the audience wants SPARQL live; otherwise the table is enough |
| Realtime transport | API Gateway WebSocket + Lambda | AppSync Events; Lambda response streaming over HTTP | Response streaming is simpler for one thread; WebSocket is needed for cancel and multi-thread |
| Compute | Lambda + Step Functions | ECS Fargate scale-to-zero service | Fargate avoids the 15-minute Lambda limit for huge PDFs; use it only for ingest if a document exceeds the limit |
| Hosting the UI | S3 + CloudFront | Amplify Hosting | Amplify adds a build pipeline you already have in Actions |
| Infrastructure code | CDK, Java/Maven | CDK TypeScript | Same constructs; TypeScript matches the Node runtime if the second developer prefers one language |

Budget: cloud ingest for the Grenfell slice lands at $11 to $19 against a $25 cap, with a CloudWatch billing alarm at $20 and the ingest job reading the alarm state before each batch. Prices are approximate Bedrock and AWS list prices.

| Item | Basis | Estimate |
| --- | --- | --- |
| Embeddings | \~15,000 pages at four chunk levels, \~30 M tokens, Titan Text v2 or Cohere Embed v3 | $1 to $3 |
| Extraction and context lines, Claude Haiku | \~8 M input and \~2 M output tokens, witness statements and resident or firefighter hearing days only | $8 to $12 |
| OCR | None; born-digital PDFs through pdftotext | $0 |
| ASR | whisper.cpp large-v3-turbo on the laptop, transcripts uploaded | $0 |
| Optional cloud ASR sample | mp4 exhibits only, under 300 minutes on Transcribe, for one cloud-ASR slide | under $8 |
| S3, Lambda, Step Functions, Aurora storage | \~20 GB and a few thousand invocations | under $2 |

Run rate after ingest: Aurora Serverless v2 paused at idle, S3 under $2/month, a 50-turn demo session on Sonnet plus Haiku checks under $2. Skipped for budget: expert reports, closing submissions, counsel-only hearing days; they can be added later at about $1 per 1,000 pages.

## Normative standards

Name these on a slide and map each to a feature; the audience will recognise every one and it turns "an AI tool" into "a tool that follows our rules".

| Standard | What it governs | Feature it maps to |
| --- | --- | --- |
| Rome Statute art. 54(1)(a), 67(2); Rules of Procedure and Evidence r. 77, 81, 87 | Investigate incriminating and exonerating circumstances equally; disclosure to the defence; protective measures for witnesses | Contradiction engine surfaces both directions; export of the session log for disclosure; cipher-only witness register |
| ICC e-Court Protocol and Evidence Record Number (ERN) conventions | Metadata every item of evidence carries in the Court's systems | Document header fields and locator formats mirror ERN-style ids and page:line locators |
| OTP Policy on Cyber-Enabled Crimes (Dec 2025) | Digital evidence collection, authentication, preservation; AI in investigations | Hash-on-ingest, provenance table, model and prompt versions on every output |
| Berkeley Protocol on Digital Open Source Investigations (UN OHCHR, 2020/2022) | Collection, preservation, verification and analysis of open-source material | Scraping rules, originals kept byte-exact, SHA-256, source URL and capture time, verification notes field |
| Méndez Principles on Effective Interviewing (2021) | Non-coercive, rapport-based interviewing; accurate recording | Statement-date and taking-body metadata; self-consistency view ordered by interview date, never treating a change as a lie |
| Istanbul Protocol (2022 ed.) and Minnesota Protocol (2016) | Documenting torture and unlawful death | Medical and forensic documents typed separately; timeline view supports cause-of-death sequencing |
| Murad Code (2022) | Working with survivors of conflict-related sexual violence | Trauma-aware UI defaults: no autoplay, content warnings per document type, survivor statements excluded from automated contradiction scoring unless an analyst opts in |
| International Protocol on the Documentation and Investigation of Sexual Violence in Conflict (2017, 2nd ed.) | Evidence standards for CRSV | Same as above plus consent and confidentiality flags on the witness register |
| W3C PROV-O; NIST SP 800-86; ISO/IEC 27037 | Provenance and digital forensics handling | Provenance records; read-only originals bucket with object lock |
| EU AI Act (high-risk: administration of justice, Annex III) and the ICC's own data-protection framework | Human oversight, logging, transparency for AI used in justice | Every answer auditable and replayable; sentence-level support colours; the tool recommends, the analyst decides, and the log shows who promoted each accepted fact |
| Council of Europe CEPEJ Ethical Charter on AI in judicial systems (2018) | Five principles: rights, non-discrimination, quality and security, transparency, user control | Eval set reported per corpus and per language; user can disable any automated label |
| ISO 15489 / OAIS (ISO 14721) | Records management and long-term digital preservation | Ingest package layout (original, derived, metadata, fixity) is a submission information package |

Three lines to put on the slide: evidence is never altered, every claim links to a locator, and every automated judgment is reversible by a person.

## Demo and presentation

Run a 12-minute live demo on one corpus with one scripted question chain, then show the laptop running the same question offline, then one slide of standards and one of cost.

Script (Grenfell):

1. Open on the referenced-documents panel, empty, and the corpus counter: "about 400 statements and 40 hearing days of video, ingested once overnight for under $25".
2. Ask: "When did residents on floors 16 to 20 first see smoke outside their windows?" The answer streams with citation chips; hover one; click it; the PDF opens at the paragraph with the sentence highlighted.
3. Ask a follow-up that interrupts the first answer mid-stream to show cancellation: "only the ones who called 999".
4. Click a citation that is a video exhibit; the player opens at 01:14:30 and the transcript scrolls.
5. Open the facts view: "first smoke seen" grouped by witness and time; one witness differs from the rest; click the cell; both source sentences appear side by side.
6. Promote the inquiry report's finding to accepted facts and watch the status column recolour.
7. Fork the thread, type a hypothesis as a session fact, and show how many witnesses it contradicts.
8. Ask a question the corpus cannot answer ("what was the wind speed at 02:00") to show abstention.
9. Switch to the laptop, Wi-Fi off, same question from step 2, same citations, slower.
10. Close on the standards slide and the cost slide.

Slides, in order: the problem (a witness pool measured in thousands of pages, consistency checked by hand); the demo; what the tool never does (alter evidence, decide, invent); architecture at the level of the diagram above; offline and air-gap path; standards mapping; eval numbers per corpus; cost at idle and per 10,000 pages; a 12-week roadmap and the ask.

Presentation ideas that land with this audience: show the session audit log exported as a PDF with every claim, locator and model version; show the eval scoreboard rather than claiming accuracy; use the inquiry's own report as the answer key so the "accepted facts" are a judge's findings; keep an "unsupported" sentence visible in grey during the demo rather than hiding it, because the point is that the tool shows its uncertainty; name Bloody Sunday and the Afghanistan inquiry on the roadmap slide as the next datasets, with cipher mode listed as the feature the Afghanistan corpus will prove.

Failure planning: record a screen capture of the full script as a fallback; pre-warm the Aurora cluster 15 minutes before; keep the laptop demo on a local corpus of about 2,000 pages so first token stays under 2 seconds.

## Build plan

Six stages, each shippable, the local path tested from stage 1; steps 1 to 4 are yours, 5 and 6 are shared with the ICC-side developer.

1. Corpus and schema (week 1 to 2): scraper for Grenfell witness statements and video exhibits with hashing and licence capture; Postgres schema (documents, chunks at four levels, assertions, entities, events, accepted\_facts, provenance, sessions); Docker compose for the laptop; CDK stack with S3, Aurora Serverless v2, one Lambda. Exit: 300 statements ingested locally and on AWS with identical row counts.
2. Retrieval and citations (week 3 to 4): hybrid search, reranker, neighbour expansion, evidence-block prompt, server-side citation resolution, PDF viewer with highlight. Exit: 50 gold questions, citation precision above 0.85 on both providers.
3. Checking layer (week 5): sentence splitting, entailment calls, quote and number guards, abstention threshold, session log and replay. Exit: unsupported-sentence rate reported per answer; CI gate in GitHub Actions.
4. Facts and consistency (week 6 to 8): extraction with JSON schema, entity and witness register with cipher mode, alignment and NLI labelling, contradiction matrix, self-consistency diff, accepted-facts promotion, timeline view. Exit: the known Grenfell timing disputes appear in the matrix without hand-tuning.
5. Conversation layer and media (week 9 to 10): WebSocket protocol with cancel, threads and forks, media player with transcript sync, image viewer with boxes, referenced-documents panel and export. Exit: the 10-step demo script runs end to end on AWS.
6. Laptop demo and polish (week 11 to 12): laptop build with a 2,000-page Grenfell slice, Wi-Fi off; evals on the laptop provider; slides, screen recording, dry run. A second corpus, if wanted, is ingested on the laptop only at zero cloud cost.

Repository layout: `packages/core` (ingest, retrieval, checks, facts; provider interfaces), `packages/aws` (Lambda entry points, CDK), `packages/local` (HTTP + WebSocket server, Docker), `packages/ui` (ESM), `evals/` (gold sets, runner, scoreboard), `corpora/` (scrapers and licence notes). One `npm run eval -- --provider=bedrock|local` is the acceptance test for every stage.

Open questions to settle before stage 1: whether the ICC developer's machine has 64 GB or more; whether SPARQL must be live or an export is enough; whether the audience wants voice.

Sources: [Grenfell Tower Inquiry witness evidence](https://www.grenfelltowerinquiry.org.uk/node/1267); [Bloody Sunday Inquiry website record, The National Archives](https://beta.nationalarchives.gov.uk/catalogue/id/C11669677); [CAIN, Bloody Sunday eyewitness statements](https://cain.ulst.ac.uk/events/bsunday/irgovt1.htm); [Independent Inquiry relating to Afghanistan, transcripts](https://www.iia.independent-inquiry.uk/documents/transcripts/); [IRMCT Unified Court Records](https://peacepalacelibrary.nl/publication/unified-court-records-database); [FDNY oral histories release](https://www.firehouse.com/home/news/10507465/fdny-releases-oral-histories-transmissions-from-sept-11); [Stony Brook 9/11 responder oral histories at the Library of Congress](https://www.newswise.com/articles/hundreds-of-first-hand-911-responder-accounts-now-available-online); [Hillsborough disclosure index, data.gov.uk](https://ckan.publishing.service.gov.uk/dataset/hillsborough-disclosure); [ICC OTP Policy on Cyber-Enabled Crimes, ASIL note](https://asil.org/ilib/icc-otp-issues-first-policy-cyber-enabled-crimes/); [ICC evidence volume and AI adoption, Kyunghyang Shinmun](https://www.khan.co.kr/en/article/202602181049007).
