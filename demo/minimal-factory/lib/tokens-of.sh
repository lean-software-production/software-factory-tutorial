#!/usr/bin/env bash
# How many tokens did this station use?
#
# Summed over the station's messages, so a station that took six turns reports
# more than the context window it ran in. That is the number you are paying for,
# not the number the last message happened to carry.
#
# Prints a human string: 44.2k, or the bare count below a thousand.
#
# Usage: tokens-of.sh <events.jsonl> [events.jsonl...]
set -euo pipefail

jq -sr '[.[] | select(.type=="message_end") | .message.usage.totalTokens? // 0]
        | add // 0
        | if . >= 1000 then "\(. / 100 | floor / 10)k" else "\(.)" end' "$@"
