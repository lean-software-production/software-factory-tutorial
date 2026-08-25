# Workbook composer dock

## Context

The workbook’s fixed tutor composer currently appears as a floating card at the lower right. It should feel like a modern chat composer: docked at the bottom of the main pane, with a rounded input and circular up-arrow send control.

## Global constraints

- The composer spans the full width of the main pane on desktop: from the lesson rail’s edge to the viewport’s right edge, flush to the viewport bottom.
- Its input content remains aligned to the readable lesson column rather than becoming an unreadably wide field.
- Enter submits a nonblank enabled message; Shift+Enter inserts a newline.
- Existing click submission, disabled handling, reflection-review disablement, mobile layout, accessibility labels, and request API remain intact.
- Add tests that fail before production changes and assert user-observable behavior.

## Task 1: Dock and modernize the timeline composer

**Files:**
- Modify: `tutorial-engine/web-workbook/src/timeline-thread.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Implementation:**
- Add semantic hooks/classes required for a full-width dock and its readable inner composer.
- Replace the text Send control with an accessible circular up-arrow submit control.
- Submit with Enter unless Shift is held; preserve textarea newline with Shift+Enter and do not submit blank or disabled forms.
- Style desktop and mobile docks so the composer reaches the main pane bottom and is visually part of the viewport rather than a floating card.
- Maintain thread bottom clearance.

**Tests:**
- Add a failing test proving Enter submits the typed message.
- Add a failing test proving Shift+Enter does not submit and preserves a newline.
- Assert the composer exposes the dock and round-send hooks/classes used by its layout.
- Run `npm run --workspace=tutorial-engine test -- workbook-ui.test.tsx` and `npm run --workspace=tutorial-engine check`.
