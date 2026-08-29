#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .tmp
echo "Recording quality baseline..."
(cd ../../calculator && node scripts/quality.mjs) > .tmp/quality-before.txt || true
echo "Starting doer..."
cat refactor.md success.md \
  | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
