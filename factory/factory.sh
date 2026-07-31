#!/usr/bin/env bash
# The smallest software factory: change, validate, pause.

set -u

FACTORY_DIR="$(cd "$(dirname "$0")" && pwd)"
KATA_DIR="$FACTORY_DIR/../natural-language-calculator"
FAILURE_LOG="$FACTORY_DIR/test-failure.log"

while true; do
  # Bash chooses the prompt. Pi works only in the calculator and has no shell tool.
  if [ -f "$FAILURE_LOG" ]; then
    echo "== Attempting to fix tests... =="
    cat "$FACTORY_DIR/heal.md" "$FAILURE_LOG" |
      (cd "$KATA_DIR" && pi --no-session --tools read,edit,write,grep,find,ls -p)
  else
    echo "== Implementing next refactoring... =="
    cat "$FACTORY_DIR/work.md" |
      (cd "$KATA_DIR" && pi --no-session --tools read,edit,write,grep,find,ls -p)
  fi

  # Standard output streams to the learner. Standard error becomes healing evidence.
  if npm --prefix "$KATA_DIR" test 2>"$FAILURE_LOG"; then
    rm -f "$FAILURE_LOG"
    echo "== tests passed =="
  else
    echo "== tests failed — see test-failure.log =="
    cat "$FAILURE_LOG"
  fi

  read -r -p "Press Enter to continue (Ctrl-C to stop)..." _
done
