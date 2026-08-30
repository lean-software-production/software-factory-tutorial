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

producer=""
doer=""
stop_rpc() {
  [ -n "${producer:-}" ] && kill "$producer" 2>/dev/null || true
  [ -n "${doer:-}" ] && kill "$doer" 2>/dev/null || true
  [ -n "${producer:-}" ] && wait "$producer" 2>/dev/null || true
  [ -n "${doer:-}" ] && wait "$doer" 2>/dev/null || true
  producer=""
  doer=""
}
cleanup() {
  stop_rpc
  rm -f control .tmp/rpc-input .tmp/rpc-prompt.json
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
  quality_now > .tmp/quality-before.txt || true

  echo "Starting doer..."
  rm -f control .tmp/rpc-input .tmp/rpc-prompt.json
  mkfifo control .tmp/rpc-input
  jq -cn --arg m "$(cat refactor.md success.md)" '{type:"prompt",message:$m}' > .tmp/rpc-prompt.json
  # One tracked Node process owns RPC stdin: it writes the prepared prompt,
  # forwards the operator's FIFO command without closing stdout, and then stays
  # alive until stop_rpc reaps it. No wrapper shell or child can be orphaned.
  node --input-type=module -e '
    import { createReadStream, readFileSync } from "node:fs";
    process.stdout.write(readFileSync(".tmp/rpc-prompt.json"));
    createReadStream("control").pipe(process.stdout, { end: false });
    setInterval(() => {}, 2 ** 30);
  ' > .tmp/rpc-input &
  producer=$!
  (cd ../../calculator && pi --no-session --mode rpc \
      --tools read,edit,write,grep,find,ls) \
    < .tmp/rpc-input > ".tmp/events/$iteration-do.jsonl" &
  doer=$!

  until grep -q '"type":"agent_end"' ".tmp/events/$iteration-do.jsonl"; do sleep 1; done

  stop_rpc
  rm -f control .tmp/rpc-input .tmp/rpc-prompt.json

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
