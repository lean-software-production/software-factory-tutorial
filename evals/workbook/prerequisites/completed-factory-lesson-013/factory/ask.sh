#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
line="${1:?usage: ask.sh <line> <question>}"
shift

{
  echo "$*"
  echo
  echo "Below is the record of the most recent run of the '$line' assembly line."
  echo "Each line is one JSON event. Answer only from what is in it."
  echo
  jq -c 'select(.type=="tool_execution_start" or .type=="message_end")' \
    "$line"/.tmp/events/*.jsonl
} | pi --no-session --no-tools -p
