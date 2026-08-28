#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .tmp
while true; do
  echo "Recording quality baseline..."
  (cd ../../calculator && node scripts/quality.mjs) > .tmp/quality-before.txt || true
  echo "Starting doer..."
  cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  echo "Gathering evidence..."
  {
    echo "=== QUALITY BEFORE (recorded before the doer ran) ==="
    cat .tmp/quality-before.txt
    echo
    echo "=== QUALITY NOW ==="
    (cd ../../calculator && node scripts/quality.mjs) || true
    echo
    echo "=== TESTS ==="
    (cd ../../calculator && npm test 2>&1) || true
    echo
    echo "=== WORKING DIFF ==="
    (cd ../../calculator && git diff -- .)
  } > .tmp/evidence.txt
  echo "Starting validation..."
  cat validate.md success.md .tmp/evidence.txt \
    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \
    | tee .tmp/validate-findings.txt
  read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
done
