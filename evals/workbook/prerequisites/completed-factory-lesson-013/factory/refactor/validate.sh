#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

sanitize_calculator_cwd() {
  local calculator_cwd calculator_physical_cwd sed_script escaped_cwd
  sed_script=""
  calculator_cwd="$(cd ../../calculator && pwd)"
  calculator_physical_cwd="$(cd ../../calculator && pwd -P)"
  for candidate in "$calculator_cwd" "$calculator_physical_cwd"; do
    escaped_cwd="${candidate//\\/\\\\}"
    escaped_cwd="${escaped_cwd//\//\\/}"
    escaped_cwd="${escaped_cwd//&/\\&}"
    sed_script="${sed_script}s/${escaped_cwd}/<calculator>/g;"
  done
  sed "$sed_script"
}

quality_now() {
  (cd ../../calculator && node scripts/quality.mjs) 2>&1 | sanitize_calculator_cwd
  return "${PIPESTATUS[0]}"
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
