#!/usr/bin/env bash
# What did this station actually say?
#
# `--mode json` writes one JSON object per event, so a station's words are no
# longer its stdout. The `agent_end` event carries every message the run
# produced, which is why this reads that one event rather than reassembling the
# streamed fragments.
#
# Note it returns the text of *every* assistant message, one per line. A station
# that narrated a step before answering puts that narration above its answer —
# which is why the verdict is parsed with an anchor rather than by reading line 1.
#
# Usage: text-of.sh <events.jsonl>
set -euo pipefail

jq -r 'select(.type=="agent_end")
       | .messages[]
       | select(.role=="assistant")
       | .content[]?
       | select(.type=="text")
       | .text' "$1"
