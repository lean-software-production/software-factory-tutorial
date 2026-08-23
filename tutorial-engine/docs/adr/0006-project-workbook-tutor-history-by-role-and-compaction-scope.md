# 6. Project workbook tutor history by role and compaction scope

Date: 2026-08-23

## Status

proposed

## Context

The workbook event log is the durable record of the learner's displayed course material and tutor
conversation. The browser already needs a projection of that record, and the main tutor needs a
separate, bounded projection. Reconstructing those tutor turns through Pi's `appendMessage()`
with only a role, text, and timestamp is invalid: Pi assistant messages also require provider,
model, stop-reason, and usage metadata. Pi later reads that usage while managing context.

The tutor also needs two different forms of context over time. It needs the full displayed
conversation while a learner works on a block. Once work completes, it needs a concise durable
memory of that block rather than its full history. At lesson completion, it needs one lesson-level
memory rather than a collection of block summaries.

## Decision

Keep the append-only workbook event log as the canonical record. Derive two projections from it:
a browser projection that renders only learner-visible events, and a main-tutor projection that
contains prior lesson summaries, prior block summaries in the active lesson, and the complete
active-block conversation.

Project displayed authored material and tutor responses as complete synthetic Pi assistant
messages. Project learner messages as Pi user messages. Synthetic assistant messages carry the
resolved model identity, `stopReason: "stop"`, and complete zero-valued usage because the workbook,
not a provider call, authored them.

Use hidden labelled Pi context entries only for internal block and lesson summaries. They are
model-visible compaction memory, not reconstructed conversation and never appear in the browser.
A block summary replaces detailed completed-block context. A lesson summary replaces that lesson's
block summaries. Private guidance, briefings, readiness signals, and raw attempt evidence remain
operation-specific input rather than general conversation context.

## Consequences

The learner sees a complete stable transcript while the tutor gets an accurate, bounded account of
what the learner saw. Restart recovery remains deterministic because it rebuilds the projection
from the canonical log instead of depending on a Pi session file.

The projector must understand summary scope and history roles. Synthetic assistant messages must
remain text-only and satisfy Pi's complete message contract. Summaries must be generated before
their covered detail can be removed from tutor context. Pi's built-in single-checkpoint compaction
is not the durable representation of per-block and per-lesson summaries; the workbook event log
is.