#!/usr/bin/env bash
# Which way does the line branch?
#
# Both halves of this pattern are load-bearing.
#
# `^` anchors it to the start of a line. Without it, the pattern matches a
# verdict string anywhere — including inside a sentence about verdicts, and a
# model asked to justify itself quotes the rules it was given. "The verdict must
# be VERDICT: PASS or VERDICT: FAIL, and mine is:" is an ordinary thing for a
# validator to write above its actual answer, and unanchored this would read
# PASS out of it and commit the change the file below was failing.
#
# `-m1` stops at the first matching *line* — not the first match. With `-o` a
# single line carrying two verdicts would print both, and the caller would
# compare a two-line string against each arm and match neither. The anchor is
# what makes that unreachable, since a line can only open with VERDICT: once.
#
# No verdict at all is a FAIL. A validator that did not answer has not passed
# anything.
#
# A code fence around the answer is survivable — the fence line is not a match,
# and the verdict inside it still starts its own line. What is not survivable is
# a validator that *demonstrates* the format in a fence before answering, since
# `-m1` would take the demonstration. That is what the validator's prompt is
# telling it not to do when it says not to restate the instructions.
#
# Usage: verdict-of.sh <findings.txt>
set -uo pipefail

grep -m1 -o '^VERDICT: \(PASS\|FAIL\)' "$1" || echo "VERDICT: FAIL"
