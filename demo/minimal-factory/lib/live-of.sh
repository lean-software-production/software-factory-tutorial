#!/usr/bin/env bash
# What has this station spent so far — while it is still spending it?
#
# `--mode json` writes each event as it happens and flushes, so the record is
# readable before the station that is writing it has finished. This reads the
# partial file and reports the running tokens, cost, and what the station is
# doing at this moment.
#
# The counting is not a sum. `message_update` events are successive *snapshots
# of the same message*, so adding them up would count one message a dozen times
# over. What is true is: every message that has ended is final, and the message
# in flight is worth whatever its latest snapshot says. So carry a completed
# total, reset the in-flight figure at each `message_end`, and add the two.
#
# Silent on failure. The last line of a file being appended to is often half
# written, and jq rightly refuses to parse it; the caller keeps whatever it had
# and asks again in a moment.
#
# Usage: live-of.sh <events.jsonl>
set -uo pipefail

jq -sr '
  reduce .[] as $e (
    { done_c: 0, live_c: 0, done_t: 0, live_t: 0, tool: "" };
    if $e.type == "message_end" then
      .done_c += ($e.message.usage.cost.total?  // 0)
      | .done_t += ($e.message.usage.totalTokens? // 0)
      | .live_c = 0
      | .live_t = 0
    elif $e.type == "message_update" then
      .live_c = ($e.message.usage.cost.total?  // 0)
      | .live_t = ($e.message.usage.totalTokens? // 0)
    elif $e.type == "tool_execution_start" then
      .tool = ($e.toolName // "")
    else . end
  )
  | (.done_t + .live_t) as $t
  | (.done_c + .live_c) as $c
  | [ (if $t >= 1000 then "\($t / 100 | floor / 10)k tok" else "\($t) tok" end),
      "$\(($c * 1000 | round) / 1000)",
      (if .tool == "" then empty else .tool end) ]
  | join(" · ")
' "$1" 2>/dev/null || true
