#!/usr/bin/env bash
# Label a file so a station knows what it is looking at.
#
# Stations receive their materials concatenated onto their prompt, with nothing
# between them. A bare diff following a bare test report reads as one confusing
# document; a heading above each says which is which.
#
# Usage: material.sh <title> <file>
set -euo pipefail

printf '\n## %s\n\n' "$1"
cat "$2"
printf '\n'
