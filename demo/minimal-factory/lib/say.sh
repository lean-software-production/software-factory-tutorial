# What the factory tells you while it runs.
#
# Two kinds of message: the flow between parts of the factory, and the status of
# whatever is running right now. The status line overwrites itself; the flow
# lines accumulate, so when a run surprises you the transcript says which
# handoff it surprised you at.
#
# Sourced, not executed.

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi

# The rail.
#
# An earlier version of this printed `orchestrator → doer` on the way out and
# `doer → orchestrator` on the way back, for every station. Half the output was
# arrows, and the return arrow never carried information — it fired whether or
# not anything had gone well, so it only ever said the run had not crashed.
#
# The rail says the same thing structurally. `├─` is a station hanging off a
# line that is still running; the line continuing past it is the handoff back.
# It costs one character instead of a line, and it survives a run with five
# rounds in it, which the arrows did not.

RAIL_NAME=14   # width of the station-name column
RAIL_TEXT=32   # width of the result column, before the elapsed time

# How deep the current station sits. A round contains its stations, so they are
# drawn inside it rather than beside it. Exported because `station.sh` is a
# separate process that sources this file fresh, and it has to draw at whatever
# depth the orchestrator left it at.
RAIL_PREFIX="${RAIL_PREFIX-}"
export RAIL_PREFIX

rail_in()  { RAIL_PREFIX="$RAIL_PREFIX│  "; export RAIL_PREFIX; }
rail_out() { RAIL_PREFIX="${RAIL_PREFIX%│  }"; export RAIL_PREFIX; }

rail_head() { printf '%s%-7s%s %s\n' "$C_BOLD" "$1" "$C_OFF" "$2"; }
rail_gap()  { printf '%s│\n' "$RAIL_PREFIX"; }
rail_end()  { printf '%s│\n' "$RAIL_PREFIX"; }

# rail_start NAME [detail] — a station begins
rail_start() {
  if [ $# -ge 2 ] && [ -n "$2" ]; then
    printf '%s├─ %s%-*s%s %s%s%s\n' "$RAIL_PREFIX" \
      "$C_BOLD" "$RAIL_NAME" "$1" "$C_OFF" "$C_DIM" "$2" "$C_OFF"
  else
    printf '%s├─ %s%s%s\n' "$RAIL_PREFIX" "$C_BOLD" "$1" "$C_OFF"
  fi
}

# rail_note TEXT — a continuation line under the station above
rail_note() {
  printf '%s│  %-*s %s%s%s\n' "$RAIL_PREFIX" "$RAIL_NAME" "" "$C_DIM" "$1" "$C_OFF"
}

# rail_ok/warn/fail TEXT [elapsed] — a station's result
rail_ok()   { _rail_result "$C_OK✓$C_OFF"   "$1" "${2:-}"; }
rail_warn() { _rail_result "$C_WARN!$C_OFF" "$1" "${2:-}"; }
rail_fail() { _rail_result "$C_ERR✗$C_OFF"  "$1" "${2:-}"; }

_rail_result() {
  local glyph="$1" text="$2" elapsed="${3:-}" pad
  if [ -z "$elapsed" ]; then
    printf '%s│  %-*s %s %s\n' "$RAIL_PREFIX" "$RAIL_NAME" "" "$glyph" "$text"
    return
  fi
  # Pad against the *plain* text: the glyph carries escape sequences, and %-*s
  # would count those as characters and misalign every coloured line. Indenting
  # also eats width, so the elapsed column pulls left as the rail gets deeper
  # and every station's time stays in one column.
  pad=$(( RAIL_TEXT - ${#text} - ${#RAIL_PREFIX} ))
  [ "$pad" -lt 1 ] && pad=1
  printf '%s│  %-*s %s %s%*s%s%s%s\n' "$RAIL_PREFIX" \
    "$RAIL_NAME" "" "$glyph" "$text" "$pad" "" "$C_DIM" "$elapsed" "$C_OFF"
}

note() { printf '%s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$1"; }
fail() { printf '  %s✗%s %s\n' "$C_ERR" "$C_OFF" "$1" >&2; }

# elapsed START — "41.2s" or "1m 32s", from a `date +%s%N` stamp
elapsed() {
  local ms=$(( ($(date +%s%N) - $1) / 1000000 ))
  if [ "$ms" -ge 60000 ]; then
    printf '%dm %02ds' $(( ms / 60000 )) $(( (ms % 60000) / 1000 ))
  else
    printf '%d.%01ds' $(( ms / 1000 )) $(( (ms % 1000) / 100 ))
  fi
}

SPINNER_PID=""

# spin_start LABEL — an in-place status line, replaced by whatever is printed next.
spin_start() {
  # Nothing when the output is not a terminal. There is no cursor to rewind, so
  # a status line would be a permanent line — and it would land between a
  # station's header and its result, breaking the rail in exactly the logs
  # someone reads later. `rail_start` has already said the station began.
  if [ ! -t 1 ]; then
    return
  fi
  (
    frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
    i=0
    while :; do
      printf '\r\033[K  %s %s…' "${frames[i]}" "$1"
      i=$(( (i + 1) % ${#frames[@]} ))
      sleep 0.1
    done
  ) &
  SPINNER_PID=$!
}

spin_stop() {
  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    printf '\r\033[K'
  fi
}
