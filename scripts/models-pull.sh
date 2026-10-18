#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited
#
# Pull the local models into Ollama. EMBED_MODEL, CHAT_MODEL and EXTRACT_MODEL
# in .env override the defaults.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      EMBED_MODEL | CHAT_MODEL | EXTRACT_MODEL | RERANK_MODEL) export "$key=$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' .env)
fi

if ! command -v ollama > /dev/null; then
  echo "ollama is not installed: brew install ollama, then run 'ollama serve'" >&2
  exit 1
fi

EMBED_MODEL="${EMBED_MODEL:-bge-m3}"
CHAT_MODEL="${CHAT_MODEL:-qwen2.5:7b-instruct}"
EXTRACT_MODEL="${EXTRACT_MODEL:-qwen2.5:7b-instruct}"
RERANK_MODEL="${RERANK_MODEL:-bge-reranker-v2-m3}"

pulled=""
for model in "$EMBED_MODEL" "$CHAT_MODEL" "$EXTRACT_MODEL"; do
  case " $pulled " in *" $model "*) continue ;; esac
  echo "pulling ${model}"
  ollama pull "$model"
  pulled="$pulled $model"
done

if ollama show "$RERANK_MODEL" > /dev/null 2>&1; then
  echo "reranker ${RERANK_MODEL} is present"
elif ollama pull "$RERANK_MODEL" > /dev/null 2>&1; then
  echo "pulled reranker ${RERANK_MODEL}"
else
  echo "skip: Ollama does not expose ${RERANK_MODEL}; retrieval uses RRF without a reranker"
fi

echo
ollama list
