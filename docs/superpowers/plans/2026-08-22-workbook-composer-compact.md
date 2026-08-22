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
