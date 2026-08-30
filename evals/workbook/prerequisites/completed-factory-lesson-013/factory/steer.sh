#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
line="${1:?usage: steer.sh <line> <message>}"
shift

jq -cn --arg m "$*" '{type:"steer",message:$m}' > "$line"/control
