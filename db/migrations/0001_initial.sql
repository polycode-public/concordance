-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited
--
-- Initial schema: corpus documents, four-level chunks with hybrid search columns,
-- the witness and entity registers, the assertion (fact) store, accepted facts,
-- consistency comparisons, provenance, and the session log.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Registers
-- ---------------------------------------------------------------------------

-- A witness is identified by an evidence id or a cipher. The table has no column
-- for a real name: a cipher-only witness has no real identity anywhere in the system.
CREATE TABLE witnesses (
  id           text PRIMARY KEY,
  cipher_only  boolean NOT NULL DEFAULT false,
  role         text,
  aliases      text[] NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE witnesses IS
  'Witness register. No real identity is stored; for cipher_only witnesses aliases hold ciphers only.';

-- People, places, vehicles, units, each with every spelling seen in the corpus.
CREATE TABLE entities (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  canonical  text NOT NULL,
  aliases    text[] NOT NULL DEFAULT '{}'
);

-- Analyst-defined events with a time window and a place.
CREATE TABLE events (
  id               bigserial PRIMARY KEY,
  name             text NOT NULL,
  time_start       timestamptz,
  time_end         timestamptz,
  place_text       text,
  place_entity_id  bigint REFERENCES entities (id)
);

-- ---------------------------------------------------------------------------
-- Documents and chunks
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id                text PRIMARY KEY,
  corpus            text NOT NULL,
  source_url        text NOT NULL,
  fetched_at        timestamptz NOT NULL,
  http_headers      jsonb NOT NULL DEFAULT '{}',
  sha256            char(64) NOT NULL,
  licence           text NOT NULL,
  source_archive    text,
  format            text NOT NULL,
  title             text,
  witness_id        text REFERENCES witnesses (id),
  role              text,
  statement_date    date,
  event_date        date,
  taking_body       text,
  lang              text NOT NULL DEFAULT 'en',
  page_count        integer,
  locator_scheme    text,
  abstract          text,
  pipeline_version  text NOT NULL
);

CREATE INDEX documents_sha256_idx ON documents (sha256);
CREATE INDEX documents_witness_idx ON documents (witness_id);

CREATE TYPE chunk_level AS ENUM ('document', 'section', 'passage', 'sentence');

-- One row per chunk at every level. The locator is written at ingest and never
-- derived at query time. Embedding model and dimension sit in every row so a
-- model change is a re-embed and never a silent mismatch.
CREATE TABLE chunks (
  id                bigserial PRIMARY KEY,
  document_id       text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  level             chunk_level NOT NULL,
  ordinal           integer NOT NULL,
  text              text NOT NULL,
  header            text,
  context_line      text,
  locator           jsonb NOT NULL DEFAULT '{}',
  prev_id           bigint REFERENCES chunks (id),
  next_id           bigint REFERENCES chunks (id),
  parent_id         bigint REFERENCES chunks (id),
  start_ms          integer,
  end_ms            integer,
  lang              text NOT NULL DEFAULT 'en',
  embedding         halfvec(1024),
  embedding_model   text,
  embedding_dim     integer,
  pipeline_version  text NOT NULL,
  tsv               tsvector GENERATED ALWAYS AS
                      (to_tsvector('english', coalesce(header, '') || ' ' || text)) STORED
);

CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX chunks_tsv_gin_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_document_level_ordinal_idx ON chunks (document_id, level, ordinal);

-- ---------------------------------------------------------------------------
-- Fact store
-- ---------------------------------------------------------------------------

-- One assertion per sentence: who said what about which event, when and where,
-- with polarity and hedging. A witness assertion is never a fact.
CREATE TABLE assertions (
  id                bigserial PRIMARY KEY,
  witness_id        text REFERENCES witnesses (id),
  source_chunk_id   bigint NOT NULL REFERENCES chunks (id),
  event_id          bigint REFERENCES events (id),
  predicate         text NOT NULL,
  object_text       text,
  object_entity_id  bigint REFERENCES entities (id),
  time_text         text,
  time_start        timestamptz,
  time_end          timestamptz,
  place_text        text,
  place_entity_id   bigint REFERENCES entities (id),
  polarity          text NOT NULL DEFAULT 'positive' CHECK (polarity IN ('positive', 'negative')),
  modality          text,
  confidence        real,
  extractor         text NOT NULL,
  pipeline_version  text NOT NULL
);

CREATE INDEX assertions_witness_idx ON assertions (witness_id);
CREATE INDEX assertions_event_predicate_idx ON assertions (event_id, predicate);

-- Subject, predicate, object over assertions for SPARQL-minded users.
CREATE VIEW triples AS
  SELECT a.witness_id AS subject,
         a.predicate AS predicate,
         a.object_text AS object,
         a.id AS assertion_id,
         a.source_chunk_id
    FROM assertions a;

-- Curated accepted facts, each with a required source citation. A row with a
-- session_id is a session-scoped hypothesis.
CREATE TABLE accepted_facts (
  id               bigserial PRIMARY KEY,
  assertion_id     bigint REFERENCES assertions (id),
  text             text NOT NULL,
  source_citation  text NOT NULL,
  promoted_by      text NOT NULL,
  promoted_at      timestamptz NOT NULL DEFAULT now(),
  session_id       uuid,
  is_hypothesis    boolean NOT NULL DEFAULT false,
  CHECK (NOT is_hypothesis OR session_id IS NOT NULL)
);

-- Pairwise labels: self (same witness across documents), cross (witnesses on the
-- same event), accepted (witness against an accepted fact).
CREATE TABLE assertion_comparisons (
  id           bigserial PRIMARY KEY,
  assertion_a  bigint NOT NULL REFERENCES assertions (id),
  assertion_b  bigint REFERENCES assertions (id),
  kind         text NOT NULL CHECK (kind IN ('self', 'cross', 'accepted')),
  label        text NOT NULL CHECK (label IN
                 ('agree', 'contradict', 'unrelated', 'consistent', 'inconsistent', 'not_covered')),
  reason       text,
  span_a       text,
  span_b       text,
  model        text NOT NULL,
  run_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Chain of custody
-- ---------------------------------------------------------------------------

-- Links each derived file to its source bytes and the tool and model that made it.
CREATE TABLE provenance (
  id              bigserial PRIMARY KEY,
  derived_sha256  char(64) NOT NULL,
  source_sha256   char(64) NOT NULL,
  step            text NOT NULL,
  tool            text NOT NULL,
  tool_version    text,
  model           text,
  prompt_version  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provenance_derived_idx ON provenance (derived_sha256);

-- ---------------------------------------------------------------------------
-- Session log: every turn can be replayed and audited
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  user_id     text,
  started_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE accepted_facts
  ADD CONSTRAINT accepted_facts_session_fk FOREIGN KEY (session_id) REFERENCES sessions (id);

CREATE TABLE session_turns (
  id               bigserial PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  thread           text NOT NULL,
  turn_id          text NOT NULL,
  user_text        text NOT NULL,
  query_rewrites   jsonb NOT NULL DEFAULT '[]',
  retrieved_ids    bigint[] NOT NULL DEFAULT '{}',
  reranker_scores  jsonb NOT NULL DEFAULT '{}',
  prompt_version   text NOT NULL,
  model_id         text NOT NULL,
  raw_output       text,
  checks           jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, thread, turn_id)
);
