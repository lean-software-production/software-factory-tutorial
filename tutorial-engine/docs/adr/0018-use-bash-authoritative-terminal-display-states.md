# 18. Use Bash-authoritative terminal display states

Date: 2026-08-28

## Status

accepted

Supersedes [17. Simplify terminal learner feedback](0017-simplify-terminal-learner-feedback.md).

## Context

ADR 17 added a browser-local Sending state because Enter reaches xterm before Bash records a
submission. That local gate had to distinguish a new Bash state from a prior feedback snapshot. A
fast command can finish before the browser observes Running, leaving the gate visible despite an
already-authoritative Feedback or Complete state.

The server already derives terminal lifecycle from Bash markers and rejects stale Coach and Main
Tutor results after a later Bash submission. The browser does not need a second lifecycle authority.

## Decision

The terminal learner display has only these states:

```text
Idle → Running → Checking → Feedback | Complete
```

Enter sends terminal input only. It neither changes the learner display nor creates a browser-local
submission, attempt, generation, or gate. The browser renders the latest browser-safe terminal object
from the server directly.

Bash remains the authority for `terminal-command-submitted` and `terminal-command-finished` records.
The server workflow continues to discard Coach and Main Tutor results for an attempt that a later Bash
submission has superseded.

Running uses the existing single in-place blue status bar with a small decorative CSS spinner. Its
accessible status text remains “Running…”. Checking remains “Checking…” unless the design later
needs a distinct indicator. Terminal WebSocket frames still carry transport bytes and transport errors
only; public workbook state carries lifecycle state.

## Consequences

The learner may wait briefly after Enter before Bash projects Running, but sees no browser-invented
state and cannot become stuck in one. Fast commands render their server Feedback or Complete state
directly. The public terminal contract remains limited to lifecycle phase and learner messages; it does
not need a browser synchronization field.
