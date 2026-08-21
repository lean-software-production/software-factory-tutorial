# 4. Use the workbook event log as canonical tutor history

Date: 2026-08-21

## Status

accepted

Supersedes [3. Use one long-running workbook tutor session](0003-use-one-long-running-workbook-tutor-session.md)

## Context

The workbook needs one continuous tutor conversation across authored lesson material, learner chat, and
attempt reviews. Its current server-owned Pi session has useful live context, but the durable state is a
browser transcript plus separate workbook and attempt state. After a restart, the tutor receives a generic
resume request instead of the messages and course material that the learner saw.

Pi's session history cannot be the durable record: it includes runtime-specific tool and compaction
internals, while the workbook needs a precise learner-facing sequence that can render independently of Pi.
At the same time, replaying an entire course into a model context will eventually exceed its context window.

## Decision

Use an append-only workbook event log as the canonical learner-session record. Record learner-visible
conversation in display order: displayed authored material as assistant messages, learner chat as user
messages, and tutor replies and review feedback as assistant messages. The browser renders this record.

Treat the Pi session as a disposable projection of the log. Before the learner can respond to authored
material, append its exact text to Pi history as an assistant turn. On restart, create a fresh restricted
Pi session and reconstruct its history from the log in role order rather than sending only a resume prompt.

Retain workflow state and immutable attempt evidence as dedicated records or stores. Do not copy raw
terminal output or editor buffers into general conversation context; supply current attempt evidence only
to its explicit review turn. Keep the tutor's authority unchanged: its only custom tool remains
`accept_current_attempt()`.

Compact context deliberately at teaching boundaries. After an accepted block, record an internal
`block-summarized` event. After a completed lesson, record a `lesson-summarized` event. The Pi-history
projection uses the newest applicable summary and the exact later events. The full learner-visible event
log remains intact.

## Consequences

The tutor can reliably refer to exactly what the learner has been shown, including after a restart. The
browser can present authored material, tutor chat, and learner chat as one chronological thread while
keeping the active terminal or editor pinned above it.

The engine gains a timeline writer, a Pi-history projection adapter, durable summary records, and recovery
tests. Timeline writes, tutor turns, and compaction must be serialized to preserve order. Compaction
failures must leave the original history available and must not block learner progress.

This supersedes ADR 0003's server-lifetime session as the recovery boundary. The workbook still owns one
restricted tutor session at a time, but that session is now an in-memory cache reconstructed from the
canonical event log.