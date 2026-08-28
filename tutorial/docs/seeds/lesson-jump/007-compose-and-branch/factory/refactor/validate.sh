#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .tmp
if [ ! -f .tmp/quality-before.txt ]; then
  echo "No quality baseline. Run ./do.sh first." >&2
  exit 1
fi
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
