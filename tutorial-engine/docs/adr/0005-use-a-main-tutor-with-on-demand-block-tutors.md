# 5. Use a main tutor with on-demand block tutors

Date: 2026-08-22

## Status

superseded

Supersedes [4. Use the workbook event log as canonical tutor history](0004-use-the-workbook-event-log-as-canonical-tutor-history.md)

Superseded by [11. Use a terminal Practice Coach with Main Tutor authority](0011-use-a-terminal-practice-coach-with-main-tutor-authority.md)

## Context

ADR 0004 made the workbook event log the durable source of a learner's course conversation and
projected it into one restricted Pi tutor session. That tutor was initially designed to review a
labelled practice attempt. Its prompt and authority therefore describe acceptance and feedback,
not ordinary conversation or help with a course note.

The workbook now also presents a "Message the tutor" interaction. Treating that conversation as
another attempt-review turn gives the learner the wrong tutor: it lacks the active block's working
context and may have no public answer to give. Conversely, replaying every command, output, and
draft from completed blocks into the main tutor forever would make later conversation noisy and
unbounded.

A learner needs detailed help while doing a block, and the tutor must be able to recover useful
detail from an older block when asked. Those needs do not require that every failed attempt remains
in the main tutor's normal context.

## Decision

Keep the workbook event log as the canonical learner-session record. It continues to retain the
complete learner-visible conversation and the immutable attempt evidence needed to reconstruct a
block.

Use a **main tutor** as the sole owner of the learner's ongoing conversation. While a block is
active, give the main tutor the complete context needed to help with it: the authored block
material, learner and tutor messages, submitted terminal/editor/reflection evidence, and any
feedback already given. When the learner completes the block, write a durable internal summary and
project that summary, rather than the block's detailed attempts, into later main-tutor context.
Lesson summaries continue to bound context across a lesson.

Provide one on-demand **block tutor** for focused help with a particular block. It receives the
learner's question, that block's authored material, its archived or active evidence, and the
relevant summary. It may use read-only workspace tools to list, search, and read files. It has no
write, shell, or other mutating authority. Use a fast model for this narrowly scoped work.

The block tutor's concise answer may be displayed directly to the learner as a tutor hint. Record
that answer in the canonical timeline as an assistant message, so the main tutor knows what help
the learner received. A later question about a compacted block can invoke the same block tutor;
the main tutor does not need to carry every old failed attempt in its default history.

Do not introduce further conversational roles or a supervisor-question protocol. A separate
constrained acceptance evaluator remains a possible future implementation detail, not a second
learner-facing tutor or a prerequisite for this design.

## Consequences

The learner gets a conversational tutor that can help with the work in front of them, while the
main tutor's normal context remains bounded after each completed block. The event log remains
complete enough to answer later questions accurately.

The engine must distinguish main-tutor turns, block-tutor hints, and internal summary records even
when the UI presents both tutors simply as "Tutor". The Pi-history projector must include the full
active-block record, then replace it with a summary at completion. It must also include block-tutor
hints, because they are part of what the learner was told.

Read-only file access lets a block tutor relate its answer to the current workspace, but a current
file may differ from the historical attempt. Block-tutor answers should therefore distinguish what
the archived evidence shows from what the current workspace contains.

Tests must cover active-block context, compaction after completion, direct durable block-tutor
hints, recovery after restart, and read-only tool exposure.
