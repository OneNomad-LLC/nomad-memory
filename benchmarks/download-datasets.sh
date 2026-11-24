#!/usr/bin/env bash
# nomad-memory benchmark dataset downloader.
#
# Fetches the open datasets the benchmark suite uses into benchmarks/data/.
# Idempotent: anything already on disk is skipped. Safe to abort and resume.
#
# Datasets:
#   lme     LongMemEval S, cleaned (~265 MB, MIT)
#           https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
#   lme-m   LongMemEval M, cleaned (~2.7 GB, MIT)
#   beam    BEAM 100K/500K/1M chats and probing questions (code MIT, data CC BY-SA 4.0)
#           https://github.com/mohammadtavakoli78/BEAM
#   mab     MemoryAgentBench Conflict_Resolution and Accurate_Retrieval (MIT)
#           https://huggingface.co/datasets/ai-hyz/MemoryAgentBench
#
# Usage:
#   bash benchmarks/download-datasets.sh              # lme, beam, mab (not the 2.7 GB lme-m)
#   bash benchmarks/download-datasets.sh lme-m beam   # just these
#   bash benchmarks/download-datasets.sh --force lme  # re-download
#
# Requires: curl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/data"

FORCE=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    lme|longmemeval) TARGETS+=("lme") ;;
    lme-m|beam|mab) TARGETS+=("$arg") ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ "${#TARGETS[@]}" -eq 0 ] && TARGETS=("lme" "beam" "mab")

mkdir -p "$DATA_DIR"
log() { printf "[download-datasets] %s\n" "$*"; }
err() { printf "[download-datasets] ERROR: %s\n" "$*" >&2; }

# fetch URL FILE: download to FILE unless present (or --force), atomically.
fetch() {
  local url="$1" file="$2"
  if [ -f "$file" ] && [ "$FORCE" -eq 0 ]; then return 0; fi
  mkdir -p "$(dirname "$file")"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "${file}.partial" "$url"; then
    rm -f "${file}.partial"; err "failed: $url"; return 1
  fi
  mv "${file}.partial" "$file"
}

LME_BASE="https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main"
download_lme()   { log "LongMemEval S";  fetch "$LME_BASE/longmemeval_s_cleaned.json" "$DATA_DIR/longmemeval_s_cleaned.json"; }
download_lme_m() { log "LongMemEval M (2.7 GB)"; fetch "$LME_BASE/longmemeval_m_cleaned.json" "$DATA_DIR/longmemeval_m_cleaned.json"; }

download_mab() {
  log "MemoryAgentBench"
  local base="https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data"
  for split in Conflict_Resolution Accurate_Retrieval; do
    fetch "$base/${split}-00000-of-00001.parquet" "$DATA_DIR/mab/${split}.parquet" || return 1
  done
}

download_beam() {
  log "BEAM (100K, 500K, 1M)"
  local raw="https://raw.githubusercontent.com/mohammadtavakoli78/BEAM/main/chats"
  local api="https://api.github.com/repos/mohammadtavakoli78/BEAM/contents/chats"
  for size in 100K 500K 1M; do
    local ids
    ids=$(curl -fsSL "$api/$size" | grep -o '"name": *"[0-9]*"' | grep -o '[0-9]\+') || { err "could not list BEAM $size"; return 1; }
    for id in $ids; do
      fetch "$raw/$size/$id/chat.json" "$DATA_DIR/beam/$size/$id/chat.json" || return 1
      fetch "$raw/$size/$id/probing_questions/probing_questions.json" "$DATA_DIR/beam/$size/$id/probing_questions/probing_questions.json" || return 1
    done
  done
}

status=0
for t in "${TARGETS[@]}"; do
  case "$t" in
    lme) download_lme || status=1 ;;
    lme-m) download_lme_m || status=1 ;;
    beam) download_beam || status=1 ;;
    mab) download_mab || status=1 ;;
  esac
done
log "data root: $DATA_DIR"
exit $status
