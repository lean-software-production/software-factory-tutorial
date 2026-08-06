#!/usr/bin/env bash
# Ask the summariser instrument to compress a station's words to one line.
#
# Its own events go into the run's records like any other model call, so the
# total at the end includes what the watching cost. An instrument you are not
# billed for is an instrument you have stopped counting.
#
# Never fatal. If the summariser fails, times out, or says nothing, the line
# carries on without a summary — a missing label is not a reason to stop a run
# that is otherwise fine.
#
# Usage: summarise.sh <station-events.jsonl> <summary-events.jsonl>
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/paths.sh"

H="$ROOT/instruments/summariser"
TOOLS=""
MODEL=""
# shellcheck source=/dev/null
. "$H/flags"

said="$("$ROOT/lib/text-of.sh" "$1" 2>/dev/null)"
[ -z "$said" ] && exit 0

{
  cat "$H/prompt.md"
  printf '\n## What the station said\n\n%s\n' "$said"
} | timeout 90 "$PI" --no-session --mode json --no-tools --model "$MODEL" -p \
      > "$2" 2>/dev/null || exit 0

# One line, whatever it did. A summariser that ignored the word count should not
# be able to reflow the rail.
"$ROOT/lib/text-of.sh" "$2" 2>/dev/null | tr '\n' ' ' | cut -c1-72 | sed 's/ *$//'
