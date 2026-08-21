# Workbook conversational timeline design

## Status

Approved for planning — 2026-08-21

## Purpose

The workbook should feel like one continuous conversation with a tutor while retaining the course
writer's authored teaching material. A learner must be able to read the tutor's feedback while keeping
the terminal, editor, or other active exercise available.

The tutor must also know what the learner has already been shown. Today, lesson content, browser state,
and Pi session state are separate and a restarted tutor receives only a generic resume instruction. This
design makes the workbook event log the durable record from which both the learner interface and the
tutor's context are reconstructed.

## Goals

- Show a chronological learning thread containing authored material, learner messages, tutor messages,
  and review feedback.
- Add the exact text of displayed authored material to Pi history as an `assistant` turn before the
  learner can respond to it.
- Recreate a fresh, restricted Pi session from the persisted event log after a server restart.
- Keep the current interactive terminal or editor visibly available while discussion and feedback scroll.
- Compact context deliberately at block and lesson boundaries without deleting the learner-visible record.
- Preserve the tutor's restricted authority and immutable-attempt review model.

## Non-goals

- Replace the workbook with the legacy transcript tutor.
- Treat terminal output, editor buffers, or every UI state change as chat messages.
- Add a generated summary of each learner edit to the thread.
- Change curriculum-owned lesson markdown or the authoring format in this iteration.

## Canonical timeline

The workbook owns one append-only timeline in `.tutorial/.tmp/`. It is the source of truth for a
learner session. The browser transcript, active Pi session, and restart recovery are projections of this
record; Pi's own in-memory history is disposable.

Timeline records have stable ordered IDs. The timeline writer serializes appends, persists each record,
and only then publishes it to browser subscribers. A browser refresh therefore replays the same sequence
without creating a second authored message or tutor reply.

The timeline distinguishes these record families:

- **Conversation messages.** A message has a role (`assistant` or `user`), a block ID, text, and source.
  Sources are `authored` for course material, `learner` for learner chat, and `tutor` for Pi replies and
  review feedback. Authored messages render with course-note styling even though their Pi role is
  `assistant`.
- **Workflow records.** Block activation, attempt submission, acceptance, rejection, and active-workspace
  state reconstruct the workbook without becoming general model context. Attempt evidence remains attached
  to its immutable attempt.
- **Context-summary records.** Internal `block-summarized` and `lesson-summarized` records reduce the
  context supplied to Pi. They are not browser chat messages and do not replace the original records.

The existing workbook state and attempt stores may remain specialized storage where appropriate, but the
new timeline must contain enough workflow references to restore the thread and select the active block.

## Pi-history projection

The engine projects timeline records into the single restricted workbook tutor session.

When the workbook displays authored content for an active block, it first appends an `assistant` message
with that exact text to the timeline and to Pi history. When the learner sends a message, the engine
records a `user` message and queues the tutor turn. When Pi completes a reply, the engine records the
completed `assistant` message before the reply becomes durable browser history. Streaming deltas are
transient display state only.

A new server creates a fresh in-memory Pi session, then projects the relevant timeline history into it in
role order. It must not use a generic "the learner resumed" message as a substitute for the history.
The projection adapter owns the Pi-specific message and compaction entry construction so that the rest of
the workbook does not depend on Pi session-file details.

A submitted terminal, editor, or reflection attempt is still reviewed with its current immutable evidence
and private guidance. This evidence is not copied wholesale into the general conversation. The tutor may
accept only the attempt currently bound to `accept_current_attempt()` and retains no filesystem, shell,
network, workspace, or built-in tools.

All tutor turns, timeline writes that lead to tutor work, and compaction operations share the existing
serialization queue. This prevents a learner message, a review result, and a compaction from being
interleaved out of order.

## Deliberate compaction

The learner-visible timeline is complete. Pi context is bounded by summaries made only at meaningful
teaching boundaries.

After the learner has an accepted attempt and moves on, the restricted tutor creates a factual
`block-summarized` record. It names the completed block, records the final concept, accepted evidence in
concise form, and material feedback or misconception worth carrying forward. The record includes the last
timeline event it covers.

After a lesson is complete and before the next lesson starts, the tutor creates a `lesson-summarized`
record. It covers the lesson's block summaries and remaining lesson conversation. The Pi-history projector
uses the newest applicable summary and the exact records after its boundary. A lesson summary supersedes
its earlier block summaries for model context, but never removes them or their underlying conversation
from the browser timeline.

A summary is an internal timeline record and a Pi compaction input, not a message attributed to the tutor
in the browser. If summary generation fails, the learner can continue: the engine records no summary and
projects a larger exact history until a later compaction succeeds.

## Learner interface

The workbook renders one vertical learning thread in authored order:

- Authored course material remains visibly distinct as a course note or lesson card.
- Tutor messages are left-aligned bubbles. Learner messages are right-aligned bubbles.
- Structured review feedback is a left-aligned review card, followed by ordinary tutor bubbles when the
  tutor continues the discussion.

A terminal-practice, editor-practice, or other learner-controlled block becomes the **current-activity
band** when active. The band sticks below the page header and floats above the conversation while the
learner scrolls. The thread continues beneath it, so feedback can be read and answered without losing the
work surface. The band stays pinned during review and revision, and releases only once the attempt is
accepted and the next block becomes active.

Terminal output and editor state stay in the work surface and attempt snapshot. They do not become chat
bubbles. This keeps the conversation readable and prevents large or untrusted evidence from consuming
history tokens.

## Failure handling

A failed tutor request produces a durable, learner-visible error record but no invented tutor response.
The queue remains available for a retry. A failure during a summary produces no summary record and does
not block progression. If recovery cannot rebuild a Pi session, the restored browser timeline remains
available and the server exposes a retryable failure state.

## Verification

Tests must demonstrate that:

1. An authored block is recorded once, appears in the browser timeline, and is projected as an assistant
   turn before subsequent learner input.
2. A restarted server reconstructs the same UI timeline and Pi-history roles and order.
3. Concurrent learner actions, review results, and compaction requests retain a single event order.
4. A block summary replaces only the intended prefix of Pi context; a lesson summary supersedes its block
   summaries; neither alters the browser transcript.
5. Tutor and compaction failures preserve learner work and permit a later retry.
6. The workbook UI pins the active terminal/editor above a flowing thread and renders tutor and learner
   messages with left/right alignment.
