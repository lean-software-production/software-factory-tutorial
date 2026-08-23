# Role-faithful workbook tutor history

## Status

Proposed for review — 2026-08-23

## Purpose

The workbook event log is the durable account of what the learner saw and did. The browser and
main tutor need different views of that record: the browser renders learner-visible events, while
the tutor needs a bounded conversation that preserves roles and completed-work memory.

The current Pi adapter projects every timeline turn through an unsafe cast. Reconstructed
assistant turns omit Pi's required provider metadata and fail when Pi reads their token usage. It
also treats course material as generic injected context rather than as the assistant turns the
learner saw.

This design refines the event-log decision in
[ADR 0005](../../tutorial-engine/docs/adr/0005-use-a-main-tutor-with-on-demand-block-tutors.md).

## Goals

- Keep one append-only event log for displayed course material, learner chat, tutor replies,
  block summaries, lesson summaries, and server-only records.
- Project displayed course material and conversation into Pi with their original user or assistant
  roles.
- Give the main tutor full detail for the active block.
- Bound the tutor's context hierarchically: a block summary replaces a completed block's detail;
  a lesson summary replaces that lesson's block summaries.
- Keep internal summaries visible to the tutor but invisible to the learner.
- Preserve the existing privacy boundary for author guidance, briefings, readiness records, and
  attempt evidence.
- Reconstruct safely after restart without fabricating incomplete Pi assistant messages.

## Non-goals

- Do not make Pi's JSONL session file the workbook's durable source of truth.
- Do not render summaries, private guidance, briefings, readiness signals, raw attempt evidence,
  or failures as ordinary learner conversation.
- Do not retain all raw completed-block conversation in the main tutor's working context.
- Do not change the main/block tutor roles, their authority, or the browser's visual design.

## Canonical record and projections

The event log remains canonical. It stores the full chronological record, including every message
that the browser may render and the internal records that support tutoring operations.

The browser projection selects safe learner-visible messages by their existing source and
presentation fields. It renders the original detailed course conversation even after the main
tutor has compacted that detail.

The tutor projection is independent of the browser projection. It selects three layers, in order:

1. one internal lesson summary for each completed lesson;
2. one internal block summary for each completed block in the active lesson; and
3. every displayed authored and chat turn in the active block, in chronological order.

The projection does not include the detailed messages covered by a selected summary. It does
include main-tutor responses, block-tutor hints, and review feedback while their block is active,
because they are part of what the learner has been told.

## Compaction boundaries

At block completion, the server writes a factual `block_summarized` record that covers the block's
last detailed event. On the next reconstruction, that summary replaces the block's displayed
course material, learner messages, tutor turns, and working evidence in main-tutor context.

At lesson completion, the server writes a factual `lesson_summarized` record. It replaces the
individual block summaries for that lesson in main-tutor context. It does not alter the event log
or browser projection.

Thus a learner working in block three of lesson two gives the tutor: summaries for earlier lessons,
summaries for blocks one and two of lesson two, and full detail for block three. The event log
continues to retain everything needed to render the original transcript or support a later focused
block-tutor request.

## Pi representation

### Conversation turns

A projected learner message becomes a Pi `UserMessage`. A projected authored course message,
main-tutor reply, block-tutor hint, or review reply becomes a complete Pi `AssistantMessage`.

Synthetic assistant messages must use the resolved tutor model's `api`, `provider`, and model ID,
with a complete zero-valued `usage` object, `stopReason: "stop"`, and the timeline event time.
Their text is static application content, not a provider response, so zero provider usage is
accurate. They contain text only: no thinking blocks, tool calls, or provider continuity
signatures are fabricated.

The session factory resolves the tutor model before appending projected history, then builds these
messages without an unsafe cast. This meets Pi's native message contract and lets it restore and
account for the history normally.

### Internal summaries

A block or lesson summary is not a learner-visible assistant turn. The Pi adapter adds it as a
hidden, labelled internal context message, with its event ID, scope, and `coveredThroughId` in
non-model metadata. The model sees the labelled summary; the browser does not. This is the sole
use of an injected context entry. It represents compaction memory, not reconstructed conversation.

The adapter must preserve the chronological order of selected lesson summaries, selected block
summaries, and active-block turns.

### Private operational material

`authorGuidance`, block-tutor briefings, readiness observations, and raw attempt snapshots remain
operation-specific trusted input. They are supplied only to the prompts that need them; they are
not projected as learner conversation or general internal summaries. Their existing public-output
restrictions remain unchanged.

## Lifecycle and recovery

`MainWorkbookTutor.restore()` recalculates the tutor projection from the event log. If its
projection signature changes, it disposes the existing disposable Pi session and creates a new
one from the new projection. No Pi session file is required for recovery.

A failed provider request does not create a tutor message. The existing resilient retry and
redacted logging adapter remains the only provider-failure boundary. The public server response
continues to be: `The tutor is temporarily unavailable. Please retry.`

## Verification

Tests must demonstrate that:

1. authored course content is projected as a complete native assistant message, while learner
   content is projected as a native user message;
2. reconstructed assistant turns include valid, zero-valued Pi usage metadata and no unsafe cast;
3. the model sees all learner-visible active-block conversation, including block-tutor hints and
   review feedback;
4. a completed block contributes exactly one hidden block summary and no longer contributes its
   detailed turns to main-tutor context;
5. a completed lesson contributes exactly one hidden lesson summary and no longer contributes its
   block summaries to main-tutor context;
6. the browser projection still renders the complete detailed transcript and never renders an
   internal summary or private record;
7. a restart produces the same tutor projection from the same event log; and
8. provider retries, redacted logs, and the generic public failure message retain their current
   behaviour.
