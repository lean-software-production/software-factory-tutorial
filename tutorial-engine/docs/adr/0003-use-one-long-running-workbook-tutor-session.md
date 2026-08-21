# 3. Use one long-running workbook tutor session

Date: 2026-08-20

## Status

superseded

Superseded by [4. Use the workbook event log as canonical tutor history](0004-use-the-workbook-event-log-as-canonical-tutor-history.md)

## Context

The workbook currently creates separate Pi sessions for editor review, terminal observation, and
reflection conversation. Those sessions cannot retain what the learner demonstrated in earlier blocks.
They also duplicate model setup, safety prompts, and completion behaviour.

## Decision

Use one server-owned Pi session for the life of a workbook server. Serialize all tutor turns through that
session. Give it no filesystem, shell, network, workspace, or built-in tools. Its only custom tool is
`accept_current_attempt()`.

The server binds that no-argument tool to the attempt under review. The tutor cannot select a block, path,
or version. After the learner continues from an accepted checkpoint, queue Pi compaction with instructions
to retain a concise factual summary of the completed block before the next review turn runs.

## Consequences

The tutor can carry relevant learner context between editor, terminal, and reflection blocks without
broadening its authority. One queue prevents overlapping tutor turns and compaction. The engine must own
session lifecycle, recovery after restart, and compaction failures; a failed tutor turn cannot be allowed
to stall learner input or accept work by default.
