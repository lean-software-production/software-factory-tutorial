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

holder=""
doer=""
cleanup() {
  [ -n "${holder:-}" ] && kill "$holder" 2>/dev/null || true
  [ -n "${doer:-}" ] && kill "$doer" 2>/dev/null || true
  rm -f control
}
trap cleanup EXIT

mkdir -p .tmp/events

text_of() {
  jq -r 'select(.type=="agent_end") | .messages[]
         | select(.role=="assistant") | .content[]?
         | select(.type=="text") | .text' "$1"
}

max_iterations=5
iteration=0
consecutive_failures=0

while [ "$iteration" -lt "$max_iterations" ]; do
  iteration=$((iteration + 1))
  echo "=== Iteration $iteration of $max_iterations ==="
  echo "Recording quality baseline..."
  (cd ../../calculator && node scripts/quality.mjs) > .tmp/quality-before.txt || true

  echo "Starting doer..."
  rm -f control
  mkfifo control
  (cd ../../calculator && pi --no-session --mode rpc \
      --tools read,edit,write,grep,find,ls) \
    < control > ".tmp/events/$iteration-do.jsonl" &
  doer=$!
  sleep infinity > control &
  holder=$!

  jq -cn --arg m "$(cat refactor.md success.md)" '{type:"prompt",message:$m}' > control

  until grep -q '"type":"agent_end"' ".tmp/events/$iteration-do.jsonl"; do sleep 1; done

  kill "$holder" "$doer" 2>/dev/null || true
  holder=""
  doer=""
  rm -f control

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
    | (cd ../../calculator && pi --no-session --mode json \
        --tools read,grep,find,ls -p) \
    > ".tmp/events/$iteration-validate.jsonl"
  text_of ".tmp/events/$iteration-validate.jsonl" > .tmp/validate-findings.txt

  verdict=$(grep -m1 -o '^VERDICT: \(PASS\|FAIL\)' .tmp/validate-findings.txt || echo "VERDICT: FAIL")
  if [ "$verdict" = "VERDICT: FAIL" ]; then
    consecutive_failures=$((consecutive_failures + 1))
    echo "Starting repair..."
    cat repair.md success.md .tmp/validate-findings.txt \
      | (cd ../../calculator && pi --no-session --mode json \
          --tools read,edit,write,grep,find,ls -p) \
      > ".tmp/events/$iteration-repair.jsonl"
  else
    consecutive_failures=0
    echo "Starting commit..."
    cat commit.md success.md .tmp/validate-findings.txt .tmp/evidence.txt \
      | (cd ../../calculator && pi --no-session --mode json \
          --tools read,grep,find,ls -p) \
      > ".tmp/events/$iteration-commit.jsonl"
    text_of ".tmp/events/$iteration-commit.jsonl" > .tmp/commit-message.txt
    message="$PWD/.tmp/commit-message.txt"
    (cd ../../calculator && git add -- . && git commit -q -F "$message")
    break
  fi

  if [ "$consecutive_failures" -ge 2 ]; then
    echo "Stopping: two failing verdicts in a row."
    break
  fi
done

echo "Line finished after $iteration iterations."
