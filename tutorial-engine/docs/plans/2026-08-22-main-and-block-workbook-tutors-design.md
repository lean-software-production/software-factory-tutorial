# Main and block workbook tutors

## Status

Approved for planning — 2026-08-22

## Purpose

The workbook needs a durable conversational tutor that understands the learner's current work without
carrying every failed attempt from completed blocks forever. It also needs fast, evidence-aware help
beside an active terminal or editor.

This iteration repairs the conversational-timeline regressions and implements the tutor roles adopted
in [ADR 0005](../../../tutorial-engine/docs/adr/0005-use-a-main-tutor-with-on-demand-block-tutors.md).

## Goals

- Make **Continue** available after every active narrative and lesson-transition course note.
- Keep a fixed bottom-of-viewport **Message the tutor** composer for the main tutor.
- Add a one-click **Get a hint** control to the sticky active terminal/editor band.
- Give the main tutor complete active-block context and sole authority to accept learner work.
- Use a fast, read-only block tutor to display direct, focused hints.
- Prepare the main tutor's private block-tutor briefing before the learner asks for a hint.
- Compact completed blocks into durable summaries while retaining their full event and attempt records.
- Preserve exact learner-visible conversation and recover it after a restart.

## Non-goals

- Do not add block-tutor consultation for completed blocks in this iteration.
- Do not add a supervisor-question protocol or more learner-facing tutor roles.
- Do not show a generated summary of each editor revision or terminal attempt in the timeline.
- Do not give a block tutor shell or write authority.
- Do not expose author guidance, internal briefings, or readiness observations to the browser.
- Do not turn raw attempt evidence into browser timeline messages or general tutor context after its
  block is complete.

## Tutor roles

### Main tutor

The main tutor owns the learner's continuous conversation and is the only tutor that can accept an
attempt. It receives:

- exact authored course notes the learner has been shown;
- learner messages, main-tutor replies, block-tutor hints, and review feedback;
- the complete working record of the active block, including submitted terminal, editor, or reflection
  evidence and earlier attempts in that block; and
- the trusted `tutor` frontmatter guidance written by the lesson author when it needs to review work
  or prepare help for that block.

When a learner submits an attempt, the main tutor produces one of three outcomes:

- **accepted:** record an accepted checkpoint, show the sign-off, and enable Continue;
- **material feedback:** show concise feedback that identifies a useful next correction; or
- **still working:** do not add a tutor bubble; update a quiet status in the activity band instead.

The main tutor reviews every submitted attempt. A block tutor may provide a readiness observation, but
that observation never accepts or rejects work.

### Block tutor

The block tutor is an on-demand, fast-model helper for the active terminal or editor block only. A
learner invokes it by pressing **Get a hint**. It receives:

- a private briefing prepared by the main tutor;
- the exact trusted author `tutor` frontmatter prompt, included in that briefing;
- the active block's material and latest attempt evidence; and
- read-only workspace tools to list, search, and read files rooted in the learner workspace.

The block tutor has no shell, write, network, or mutating authority. Its concise, learner-facing hint
appears directly in the timeline as a tutor message. The UI need not distinguish it visually from a
main-tutor message.

The block tutor may also return an internal readiness observation when an automatic attempt review
begins. The main tutor receives that observation as advice, not a decision. A block tutor does not
produce unsolicited learner-facing feedback.

## Briefing lifecycle

When a terminal or editor block becomes active, the server asks the main tutor to prepare a private
briefing for its block tutor. The briefing includes the author guidance, the block goal, and the main
tutor's initial account of what useful help looks like. The server persists it as an internal timeline
record.

A hint request uses the newest successful briefing plus the latest evidence, so the learner does not
wait for a main-tutor call before the fast block tutor can respond. After a meaningful main-tutor chat
turn or review result, the server refreshes the briefing in the background. The last successful
briefing remains available until its replacement succeeds.

The briefing is server-only. It is never rendered, projected as learner-facing conversation, or
included in the public workbook state.

## Context and compaction

The append-only workbook timeline remains canonical. It records authored messages, learner messages,
main-tutor replies, block-tutor hints, review feedback, workflow events, summaries, and internal
briefing/readiness records. The browser timeline receives only safe learner-facing messages and
retryable failures. The active work surface may receive its current evidence through the existing
workbook state.

While a block is active, reconstruction of the main tutor includes its full working record. This gives
the main tutor enough evidence to answer the learner's chat questions and sign off work accurately.

After the learner completes a block, the main tutor writes a factual internal block summary. Later
main-tutor context contains that summary and subsequent conversation instead of the completed block's
raw attempt history. Lesson summaries continue to replace earlier block summaries at lesson boundaries.
The full event log and immutable attempts remain available for future engine work, but this iteration
does not provide completed-block delegation.

Both main-tutor and block-tutor learner-facing responses enter the projected main-tutor history as
assistant turns. The main tutor therefore knows what the learner has already been told, including after
a restart.

## Learner interface

### Timeline and continuation

The chronological thread renders authored notes, learner messages, main-tutor messages, block-tutor
hints, and structured review feedback. Tutor messages are left-aligned and learner messages are
right-aligned.

An active narrative or lesson-transition course note renders its **Continue** control immediately after
the note. The timeline composer must never replace that control. This fixes the current first-lesson
regression that traps a learner at the Orientation note.

### Active work and hints

The active terminal/editor remains in a sticky activity band above the thread. Its header includes a
one-click **Get a hint** action. The action asks for the best next hint from current evidence; it does
not first open a question field. Hints appear in the ordinary timeline beneath the activity band.

Reflection is main-tutor conversation. It has no block-tutor hint action. Its reflection question gives
the learner enough context while the generic composer remains labelled **Message the tutor**.

### Main-tutor composer

The main-tutor composer stays fixed at the bottom of the viewport. The thread reserves enough bottom
space that its last message and any Continue control remain reachable. The composer sends only main
tutor chat; it is not the terminal/editor hint route.

## Server operations

- `POST /messages` appends a learner message and invokes the main tutor for a non-empty public reply.
- A new active-terminal/editor hint operation invokes the already briefed block tutor and appends its
  direct hint.
- Automatic terminal, editor, and reflection submissions persist immutable attempt evidence, obtain any
  block-tutor readiness observation, and ask the main tutor to review and sign off.
- Timeline writes, main-tutor work, block-tutor work, briefing refreshes, and summaries remain ordered
  through the workbook serialization queue.

The timeline must distinguish message source (`authored`, `learner`, `main_tutor`, or `block_tutor`) and
presentation (`course`, `chat`, `hint`, or `review`) without exposing internal prompts or records.

## Failure handling

A main reply, main review, prepared briefing, block hint, or summary failure creates a durable retryable
failure record. The server must reject an empty model response as a failure; it must never append a
blank tutor message. A failed briefing does not block active work. The server may use the most recent
successful briefing while a background refresh retries.

On restart, the server restores the public timeline, active workflow, current attempt state, latest
summary, and latest prepared briefing. It reconstructs the main tutor from the appropriate projected
history and active-block context before accepting further learner actions.

## Verification

Tests must demonstrate that:

1. The first narrative note shows Continue and advances to the next block.
2. Main-tutor chat persists a non-empty reply; an empty or failed reply produces a retryable failure.
3. Active-block evidence is supplied to the main tutor, while a completed block is represented by its
   summary rather than raw attempts.
4. A terminal/editor activation prepares a durable private briefing before Get a hint is requested.
5. Get a hint uses the prepared briefing, latest evidence, and only read-only workspace tools; its
   direct response persists and survives restart.
6. The main tutor alone accepts an attempt. Its quiet still-working result adds no chat bubble, while
   material feedback and acceptance remain visible.
7. Private author guidance, briefings, and readiness observations never appear in public state. Raw
   attempt evidence never appears as a browser timeline message.
8. The sticky activity band contains Get a hint and the fixed composer does not obscure timeline actions.
