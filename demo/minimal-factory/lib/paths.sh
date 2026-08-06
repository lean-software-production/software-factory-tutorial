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

# Prefer the pi this repository depends on over whatever the shell resolves.
#
# `pi` on PATH is whichever one a version manager happens to pick, and a version
# manager pins tools per language runtime — so changing the node this repository
# uses can silently change, or remove, the pi it gets. package.json names the
# version the lessons were written against; use that one when it is installed.
if [ -x "$REPO/node_modules/.bin/pi" ]; then
  PI="$REPO/node_modules/.bin/pi"
else
  PI="pi"
fi
