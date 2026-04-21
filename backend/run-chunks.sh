#!/bin/bash
# Sequential chunked run of the LongMemEval bench. Each chunk is a fresh
# Node process so ONNX/transformers.js memory doesn't accumulate past the
# OOM threshold we were hitting around question ~15-30 in single-process
# runs. Chunk-00 was already run separately.
#
# Usage:  bash run-chunks.sh
# Output: longmemeval-chunk-{00..09}.jsonl + longmemeval-tuned.jsonl (concat)

set -euo pipefail

export USE_LOCAL_EMBEDDINGS=1
export EMBEDDING_MAX_NEW_PER_CALL=300

for i in 01 02 03 04 05 06 07 08 09; do
  start=$((10#$i * 50))
  out="longmemeval-chunk-$i.jsonl"
  log="longmemeval-chunk-$i.log"
  if [ -s "$out" ] && [ "$(wc -l < "$out")" -ge 50 ]; then
    echo "=== chunk-$i already complete ($out), skipping ==="
    continue
  fi
  echo "=== chunk-$i: start=$start limit=50 ==="
  t0=$(date +%s)
  npx tsx src/bench/longmemeval.ts --start "$start" --limit 50 --out "$out" > "$log" 2>&1
  rc=$?
  t1=$(date +%s)
  echo "chunk-$i: exit=$rc, elapsed=$((t1-t0))s, rows=$(wc -l < "$out" 2>/dev/null || echo 0)"
  if [ "$rc" -ne 0 ]; then
    echo "chunk-$i FAILED, aborting chain"
    exit 1
  fi
done

echo "=== concat chunks → longmemeval-tuned.jsonl ==="
cat longmemeval-chunk-00.jsonl longmemeval-chunk-01.jsonl longmemeval-chunk-02.jsonl longmemeval-chunk-03.jsonl longmemeval-chunk-04.jsonl longmemeval-chunk-05.jsonl longmemeval-chunk-06.jsonl longmemeval-chunk-07.jsonl longmemeval-chunk-08.jsonl longmemeval-chunk-09.jsonl > longmemeval-tuned.jsonl
echo "total rows: $(wc -l < longmemeval-tuned.jsonl)"
