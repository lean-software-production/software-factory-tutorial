# Every path in this demo is absolute, derived once, from this file.
#
# Not for the sake of tidiness: a relative path written inside a subshell that
# has already `cd`-ed somewhere else expands against the new directory, not the
# one it was written in. That bug is the subject of lesson 007. Absolute paths
# make the whole class of it unreachable.
#
# Sourced, not executed. BASH_SOURCE rather than $0 so the answer does not
# depend on which script did the sourcing.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
CALC="$REPO/calculator"
RUN="$ROOT/run"
EVENTS="$RUN/events"
