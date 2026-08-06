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

# flow FROM TO [detail] — "orchestrator → doer  [tools · model]"
flow() {
  if [ $# -ge 3 ]; then
    printf '%s%s → %s%s  %s[%s]%s\n' "$C_BOLD" "$1" "$2" "$C_OFF" "$C_DIM" "$3" "$C_OFF"
  else
    printf '%s%s → %s%s\n' "$C_BOLD" "$1" "$2" "$C_OFF"
  fi
}

note() { printf '%s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$1"; }
fail() { printf '  %s✗%s %s\n' "$C_ERR" "$C_OFF" "$1" >&2; }

SPINNER_PID=""

# spin_start LABEL — an in-place status line, replaced by whatever is printed next.
spin_start() {
  if [ ! -t 1 ]; then
    printf '  %s…\n' "$1"
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
