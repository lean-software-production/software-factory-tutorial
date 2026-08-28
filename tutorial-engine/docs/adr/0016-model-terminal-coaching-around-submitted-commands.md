# 16. Model terminal coaching around submitted commands

Date: 2026-08-28

## Status

accepted

Builds on [11. Use a terminal Practice Coach with Main Tutor authority](0011-use-a-terminal-practice-coach-with-main-tutor-authority.md).

## Context

The terminal manager currently regards any command that has ever received Enter as pending. Bash
echoes later ordinary typing as terminal output, and the manager's quiet timer turns that output into
new terminal attempts. Each new snapshot supersedes the previous one, so a Coach result can be
correctly discarded as stale before the learner ever sees it. The browser then presents a transient
socket status such as “Checking…” as though it were durable feedback.

A quiet interval is not command completion. The terminal owns a long-lived Bash process, so its PTY
can observe the shell exiting but cannot otherwise learn that one child command has returned. At the
same time, a learner may benefit from a quick assessment of the exact command they submitted and of
useful output from a command that remains running.

ADR 11 correctly gives the Main Tutor sole authority to accept work. Its terminal observation
generation does not, however, express command submission, output checkpoints, command completion,
or their display consequences.

## Decision

The controlled Bash shell reports an exact command marker before executing each submitted command.
The terminal observation session records it in the canonical session event log as:

```text
terminal-command-submitted { attemptId, blockId, command, terminalSessionId }
```

This creates the stable identity for the command's whole coaching lifecycle. Typing before the Bash
marker is a local draft signal only: it creates no model request, attempt, or durable event. The
browser retains any prior feedback while typing and shows a separate subtle listening indicator.

The shell also reports a machine-readable completion marker immediately before its next fresh prompt,
including the exit status. The observation session records:

```text
terminal-command-finished { attemptId, exitStatus, evidenceRef }
```

The final evidence is self-contained: the exact submitted command, only its input/output
interaction, and its exit status. It contains no rolling terminal history. Input, including Enter,
while a command owns the terminal belongs to that same running attempt; it is not another Bash command
or another attempt.

A fresh output burst from a still-running command may become quiet for one second. The session then
records one `terminal-output-settled` checkpoint for that new output revision. It must not create two
checkpoints for identical evidence. A checkpoint is not command completion: its Coach assessment may
provide useful feedback, but cannot accept work or unlock progression.

Policies request a preliminary Coach assessment when a command is submitted, an interim assessment
for each settled running-output checkpoint, and a result assessment when it finishes. Requests are
external effects, not domain events. Their returned facts are recorded against the same `attemptId` as
`preliminary-coaching-received`, `interim-coaching-received`, and
`result-coaching-received`. The result assessment is authoritative over every earlier assessment.
The Main Tutor remains the only authority that can accept work or advance the learner.

A preliminary or interim assessment returns either useful feedback or `wait-for-result`. Useful
feedback is shown immediately even while the command still runs; a smaller activity indicator says
that execution continues. Fresh output does not hide that provisional feedback. Once a command has
finished, its result path must resolve visibly to feedback, acceptance, a positive
“Looks good — confirming…” Main Tutor hand-off, or a Coach-unavailable state retrying automatically.
It may not leave the learner in silent working state. Automatic retries use capped backoff and continue
until the attempt becomes stale, succeeds, or the session closes.

The event log, rather than a mutable `AttemptStore`, is the durable authority for attempt lifecycle
state. Immutable terminal evidence remains session-local and is referenced by `evidenceRef`, rather
than copied into every event-log row. Projections derive the current attempt, feedback, and
eligibility from the event log. Private Coach material is excluded from the Main Tutor projection and
from the browser unless it is the current learner-facing feedback.

The browser presents an explicit display-state projection, not the latest socket frame. Enter replaces
the blue feedback field with blue running state; result review says “Reviewing command result…”; and
stale frames and results for an earlier `attemptId` cannot replace the current attempt's presentation.

## Consequences

Each Bash command has one identity, one event history, and deliberately bounded assessment points.
Ordinary typing cannot create, supersede, or delay an attempt. A Coach response can be correlated with
the command and phase that caused it, and recovery can reconstruct that lifecycle from the main
session log.

The terminal needs shell integration for authoritative markers and a dedicated observation session
that owns the command lifecycle. The browser-safe terminal contract, workflow projections, and UI
display state must be revised together.

Tests must cover event slices from keystrokes through Bash markers, stubbed Coach and Main Tutor
responses, event-log projections, WebSocket/SSE delivery, and display state. They must verify that
typing has no model or event-log effect; one Bash command creates one attempt; each new running-output
burst creates at most one feedback-only checkpoint; command completion creates final evidence; stale
assessments cannot win; and the display shows the projection of the current attempt.
