# Task 1 Report: Simplify the docked composer

## Requirements covered

- Removed the visible outer composer label by replacing the visible wrapping label with an `aria-label` on the textarea.
- Removed the visible card treatment from the fixed composer form in the dock while preserving the existing dock/form classes used by the submission path.
- Made the textarea start at one row with a compact textarea class hook and CSS for content-sized growth, bounded max height, and vertical scrolling after the cap.
- Preserved Enter submission and Shift+Enter newline behavior.

## RED evidence

Added the behavioral test `keeps the docked composer visually compact while preserving accessible labels` in `tutorial-engine/test/workbook-ui.test.tsx` before production changes.

Command:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-compact/tutorial-engine && npm test -- test/workbook-ui.test.tsx -t "keeps the docked composer visually compact"
```

Expected RED output:

```text
× keeps the docked composer visually compact while preserving accessible labels
AssertionError: expected null not to be null
❯ test/workbook-ui.test.tsx:225:22
```

The failure was expected: the form did not yet expose the compact composer hook, the textarea still lived inside a visible label, and the textarea did not yet have the new accessible-label/compact-textarea markup.

## Implementation

Changed `tutorial-engine/web-workbook/src/timeline-thread.tsx`:

- Replaced the visible `<label>Message the tutor ...</label>` wrapper with a standalone textarea.
- Added `aria-label="Message the tutor"` so the textarea remains accessible without visible label text.
- Added `rows={1}` and `className="timeline-composer-textarea"` as the compact/autogrow styling hook.
- Left the existing `.timeline-composer-dock.fixed-composer`, `.timeline-input.fixed-composer`, send button, `onSubmit`, Enter, and Shift+Enter paths in place.

Changed `tutorial-engine/web-workbook/src/styles.css`:

- Removed the fixed dock form's visible card styling by setting the docked `.timeline-input` padding, border, radius, background, and shadow to the compact transparent treatment.
- Added compact textarea styling: `field-sizing: content`, one-line min height, bounded max height, `overflow-y: auto`, and `resize: none`.

Changed `tutorial-engine/test/workbook-ui.test.tsx`:

- Added assertions for the accessible textarea label, hidden visible label text, absence of a label wrapper, existing dock/form/send hooks, and the compact textarea class.
- Updated the narrative/Continue ordering test so it checks DOM ordering against the fixed composer dock and confirms the composer label is accessible rather than visible text.

## GREEN / verification output

Focused new behavior test:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-compact/tutorial-engine && npm test -- test/workbook-ui.test.tsx -t "keeps the docked composer visually compact"
```

Output:

```text
Test Files  1 passed (1)
Tests  1 passed | 31 skipped (32)
```

Focused UI test file:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-compact/tutorial-engine && npm test -- test/workbook-ui.test.tsx
```

Output:

```text
Test Files  1 passed (1)
Tests  32 passed (32)
```

Regression check for fixed conversation layout:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-compact/tutorial-engine && npm test -- test/workbook-conversation-layout.test.tsx
```

Output:

```text
Test Files  1 passed (1)
Tests  3 passed (3)
```

Full tutorial-engine check:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-compact/tutorial-engine && npm run check
```

Output:

```text
Test Files  38 passed (38)
Tests  292 passed (292)
```

## Self-review

- The new test would fail if the textarea lost its accessible label, if visible composer label text returned, if the visible label wrapper returned, or if the compact textarea class hook disappeared.
- Existing submission behavior remains covered by the Enter submission test and the reflection composer routing tests; Shift+Enter newline behavior remains covered by the existing newline test.
- The fixed composer's existing dock/form selectors are preserved, including `.timeline-input.fixed-composer`, to avoid breaking existing tests and code paths.
- The implementation is limited to the requested markup/style and test updates; no tutor event or submission logic changed.

## Concerns

- The CSS autogrow uses `field-sizing: content`; browsers without support will still start at one row and become scrollable, but may not visually grow before reaching the scrollable behavior.
