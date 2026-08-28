# 17. Simplify terminal learner feedback

Date: 2026-08-28

## Status

accepted

Supersedes [16. Model terminal coaching around submitted commands](0016-model-terminal-coaching-around-submitted-commands.md).

## Context

ADR 16 gave Bash command boundaries durable identities, but it also projected internal review detail
as learner-facing lifecycle states. Running-output checkpoints, preliminary and interim Coach
assessments, retry cards, handoff status, and separate activity labels could overlap. A learner could
therefore see submission, old feedback, and listening at the same time. The browser had to invent
attempt identities and lifecycle ordering to hide races that the public contract should not expose.

The learner needs only one answer at a time: whether the shell is running, the finished command is
being checked, feedback is ready, or the work is complete. Enter is visible to the browser before
Bash accepts a command, so it needs a local Sending gate without granting the browser authority over
an attempt boundary.

## Decision

The terminal learner display has only these states:

```text
Idle → Sending → Running → Checking → Feedback | Complete
```

Sending is local to the browser and begins immediately on Enter. It replaces any old terminal card
and ignores server Feedback and Complete snapshots until the server projects Running from Bash's
`terminal-command-submitted` event. Bash remains the authority that starts and finishes an attempt.

The private event stream uses `terminal-command-submitted`, `terminal-command-finished`,
`terminal-feedback-recorded`, `terminal-coach-handoff-recorded`, and `attempt_accepted`. There are
no running-output checkpoints or preliminary/interim Coach events. Finished evidence is the only
immutable terminal evidence and the only input that may start Practice Coach work.

A public terminal object contains only `running`, `checking`, `feedback`, or `complete`, with a final
learner message only for Feedback and Complete. It contains no command, evidence reference, attempt
ID, Coach handoff, or rubric. Terminal blocks do not fall back to legacy AttemptStore checkpoints.
An unfinished command from a previous terminal session reopens idle; a finished command and accepted
session work remain recoverable from the event log.

Practice Coach `working`, errors, and empty output retry internally while public state remains
Checking. Feedback records the one feedback result. Ready and interesting record a private handoff
to Main Tutor. Main Tutor errors, working outcomes, and empty output also retry internally; only its
accepted decision emits `attempt_accepted` and unlocks the block. A later Bash submission invalidates
and cancels earlier result or retry work.

The browser renders exactly one in-place terminal card for Sending, Running, Checking, Feedback,
Complete, or a transport error. It does not display Listening, Coach outcomes, retry state, handoff
state, a portal copy, or a second status node. Terminal WebSocket frames carry transport bytes and
transport errors only; lifecycle state comes from the public workbook state.

## Consequences

The terminal contract and UI are smaller, and tests can assert a direct EventStorming slice from
Bash markers through final feedback or Main Tutor acceptance. Model retries no longer create visible
noise or race with feedback. Privacy review is simpler because browser state has a single narrow
terminal object.

The engine no longer offers feedback for a command that is still running. A learner waits until Bash
reports completion before Practice Coach or Main Tutor assessment begins. Legacy unfinished terminal
attempts do not resume their old phases after restart.
