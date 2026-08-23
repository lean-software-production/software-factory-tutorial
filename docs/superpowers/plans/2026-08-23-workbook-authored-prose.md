# Plain authored workbook prose

## Global constraints

- Authored `course` timeline messages (introduction, part, lesson frame, authored blocks) render as direct workbook page content: no card, border, shadow, or “Course note” eyebrow.
- Dynamic conversation messages—learner, main tutor, block tutor hints, reviews, and failures—retain their existing cards and labels.
- Authored prose remains in the timeline, order, and continuation behavior unchanged.

## Task 1: Style authored timeline entries as page content

**Files:**
- Modify: `tutorial-engine/web-workbook/src/timeline-thread.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Implementation:**
- Render course entries using a distinct plain-content semantic hook, without the “Course note” label.
- Style those entries as direct readable page prose rather than chat cards.
- Preserve the authored record’s continuation insertion and all dynamic message presentation.

**Tests:**
- Add a failing UI test that authored content has no course eyebrow/card hook and uses the plain-content hook.
- Assert dynamic tutor/learner messages retain their card presentation.
- Run focused UI tests and tutorial-engine check.
