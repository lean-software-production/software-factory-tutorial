#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f refactor-quality-before.txt ]; then
  echo "No quality baseline. Run ./refactor-do.sh first." >&2
  exit 1
fi
echo "Starting validation..."
cat refactor-validate.md refactor-quality-before.txt \
  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
  | tee refactor-validate-findings.txt
