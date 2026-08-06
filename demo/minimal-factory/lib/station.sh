#!/usr/bin/env bash
# Run one harness. This is the only place in the demo that invokes pi.
#
# A harness is a directory holding two files: `prompt.md`, the job, and `flags`,
# the configuration of the tool that does it — which tools it may call, and which
# model it runs on. Everything that distinguishes one station from another lives
# in those two files, which is why this script does not need to know which
# station it is running.
#
# Inputs are concatenated in a fixed order: the job, then the criteria, then
# whatever materials the caller passes. Each station was written expecting them
# that way round.
#
# Usage: station.sh <harness> <events-out> [input-file...]
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/paths.sh"
. "$ROOT/lib/say.sh"

harness="$1"
events="$2"
shift 2

H="$ROOT/harnesses/$harness"
if [ ! -d "$H" ]; then
  fail "no such harness: $harness"
  exit 2
fi

TOOLS=""
MODEL=""
EXTENSION=""
# shellcheck source=/dev/null
. "$H/flags"

ext_args=()
if [ -n "$EXTENSION" ]; then
  ext_args=(-e "$ROOT/$EXTENSION")
fi

# The pin in `flags` is the default and stays the default. This override exists
# so the line can be exercised — the wiring, the branch, the give-up path —
# without paying frontier prices to watch a shell loop work:
#
#     FACTORY_MODEL=anthropic/claude-haiku-4-5 ./factory <file>
#
# What comes out is worth less. What it costs to find out the plumbing is
# connected is worth less too.
MODEL="${FACTORY_MODEL:-$MODEL}"

# pi has no turn or token cap, so wall-clock is the only bound available. It is a
# crude one and it is better than none: nothing here should take ten minutes, and
# a station that does has stopped making progress rather than started making
# more.
STATION_TIMEOUT="${FACTORY_STATION_TIMEOUT:-10m}"

flow orchestrator "$harness" "$TOOLS · ${MODEL#*/}"
spin_start "$harness running"

# The station must not take the run down with it, so its exit code is captured
# rather than allowed to trip `set -e`. A failed station is reported, not hidden.
set +e
cat "$H/prompt.md" "$ROOT/criteria.md" "$@" \
  | (cd "$CALC" && timeout "$STATION_TIMEOUT" \
        "$PI" --no-session --mode json \
        --model "$MODEL" --tools "$TOOLS" "${ext_args[@]}" -p) \
  > "$events" 2> "$events.err"
status=$?
set -e

spin_stop

# 124 is `timeout`'s way of saying it killed the station. Worth naming, because
# it is the failure this demo is most likely to hit: a station that cannot solve
# the problem it was given does not stop, it keeps trying. One healer here spent
# a million tokens rewriting the build rather than concluding it was stuck.
if [ "$status" -eq 124 ]; then
  fail "$harness ran past ${STATION_TIMEOUT} and was stopped"
  note "  Partial record in ${events#"$REPO"/}"
  exit 124
fi

if [ "$status" -ne 0 ]; then
  fail "$harness failed (exit $status)"
  head -n 20 "$events.err" >&2
  exit "$status"
fi

tokens=$("$ROOT/lib/tokens-of.sh" "$events")
cost=$("$ROOT/lib/cost-of.sh" "$events")
ok "$(printf '%s finished — %s tokens, $%.2f' "$harness" "$tokens" "$cost")"
flow "$harness" orchestrator
