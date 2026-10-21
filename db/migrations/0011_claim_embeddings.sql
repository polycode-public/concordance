-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright 2026 Polycode Limited

-- The vector of an assertion's claim text, stored by the comparison run so that a resumed run, and
-- the next run over the same assertions, embeds only the claims that have none. The digest names
-- the claim text the vector was made from; a vector whose digest differs from the current claim
-- text is stale and is made again. The column has the chunks' type and dimension.
ALTER TABLE assertions
  ADD COLUMN claim_embedding halfvec(1024),
  ADD COLUMN claim_embedding_sha256 text;
