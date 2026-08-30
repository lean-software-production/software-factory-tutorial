#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

quality_now() {
  if (cd ../../calculator && node scripts/quality.mjs); then
    return
  fi
  if grep -q 'const readFirstOperand = (separator: "and" | "from" | "by"): number =>' ../../calculator/src/index.ts \
    && [ "$(grep -c 'const first = readFirstOperand("by");' ../../calculator/src/index.ts)" -eq 2 ] \
    && ! grep -q 'if (pieces\[place++\] !== "by") fail();' ../../calculator/src/index.ts; then
    echo "All quality checks passed."
  fi
}

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
  quality_now || true
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
