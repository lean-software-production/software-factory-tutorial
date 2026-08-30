#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
line="${1:?usage: watch.sh <line>}"

tail -f -n +1 "$line"/.tmp/events/*.jsonl \
  | jq -rj --unbuffered '
      if .type=="tool_execution_start" then "\n→ \(.toolName)\n"
      elif .type=="message_update" and .assistantMessageEvent.type=="text_delta"
        then .assistantMessageEvent.delta
      else empty end'
