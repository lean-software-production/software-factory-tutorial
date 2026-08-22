# Compact workbook composer

## Global constraints

- The dock keeps its existing full-width layout, circular send control, click behavior, Enter submission, and Shift+Enter newline behavior.
- The input starts at one text line; a Shift+Enter newline expands it naturally, with a bounded height and scrolling after that bound.
- Remove the visible outer “Message the tutor” label/card around the input while preserving an accessible name.
- Add test-first, user-observable coverage.

## Task 1: Simplify the docked composer

**Files:**
- Modify: `tutorial-engine/web-workbook/src/timeline-thread.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Implementation:**
- Remove the visible outer composer label/card while giving the textarea an accessible label.
- Make the initial text area one line and let Shift+Enter expand it; cap its height and permit vertical scrolling after the cap.
- Keep the existing dock and submission paths.

**Tests:**
- Add a failing test that asserts the accessible textarea label and lack of visible outer label/card.
- Assert the compact textarea hook/classes needed for its one-line/autogrow styling.
- Run focused UI tests and tutorial-engine check.

## Task 2: Render the opening as the tutor conversation

**Files:**
- Modify: `tutorial-engine/src/workbook/server.ts`
- Modify: `tutorial-engine/src/workbook/timeline.ts` and/or `tutorial-engine/src/workbook/pi-history.ts`
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/web-workbook/src/timeline-thread.tsx`
- Modify: focused workbook server, timeline, UI, and recovery tests

**Implementation:**
- Persist authored messages for the workbook introduction, each newly reached part, and each newly reached lesson frame (title, description, outcomes). Do not duplicate them on restart.
- Render this authored content through `TimelineThread`; in conversational mode, do not also render it as standalone introduction, part, or lesson document sections.
- The composer is available during the unopened introduction. It sends and records a learner message and main-tutor reply using a durable introduction conversation target; it remains available after restart. Do not enable hints or evaluated-block operations until a real active block.
- Continue from the introduction still emerges the first active lesson and its authored frame/block messages in order.
- Preserve public/private filtering and use the canonical event log, not client-only state.

**Tests:**
- Add test-first server coverage for intro chat and recovery, including durable learner/tutor messages.
- Add test-first UI coverage that conversational state renders authored intro/part/lesson content in the timeline but not duplicated document sections, and renders the composer before introduction completion.
- Run focused tests and full tutorial-engine check.
