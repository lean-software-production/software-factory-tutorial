#!/usr/bin/env bash
# What did this cost, in dollars?
#
# Every `message_end` event carries the usage and cost of that message. Summing
# `cost.total` over one station's events gives that station's bill; over all of
# them, the run's. Takes any number of event files so the caller can ask either
# question with the same script.
#
# Prints a bare number at full precision. Round it where you display it.
#
# Usage: cost-of.sh <events.jsonl> [events.jsonl...]
set -euo pipefail

jq -s '[.[] | select(.type=="message_end") | .message.usage.cost.total? // 0]
       | add // 0' "$@"
