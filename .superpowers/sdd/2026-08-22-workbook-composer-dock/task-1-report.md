# Task 1 report: Dock and modernize the timeline composer

## Red test command/output

Command:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock && npm run --workspace=tutorial-engine test -- workbook-ui.test.tsx
```

Output after adding the behavioral UI tests and before production changes:

```text
> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root . workbook-ui.test.tsx


 RUN  v4.1.10 /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock/tutorial-engine

 ❯ test/workbook-ui.test.tsx (32 tests | 3 failed) 358ms
     × submits the typed tutor message with Enter 65ms
     × keeps Shift+Enter in the tutor composer as a newline without submitting 9ms
     × exposes the docked composer and round send layout hooks 5ms

 FAIL  test/workbook-ui.test.tsx > workbook lesson UI > submits the typed tutor message with Enter
AssertionError: expected "vi.fn()" to be called with arguments: [ 'What should I try next?' ]

Number of calls: 0

 FAIL  test/workbook-ui.test.tsx > workbook lesson UI > keeps Shift+Enter in the tutor composer as a newline without submitting
AssertionError: expected 'Line one' to be 'Line one\n' // Object.is equality

- Expected
+ Received

  Line one
-

 FAIL  test/workbook-ui.test.tsx > workbook lesson UI > exposes the docked composer and round send layout hooks
AssertionError: expected '<section class="timeline-thread has-f…' to contain 'class="timeline-composer-dock fixed-c…'

Expected: "class="timeline-composer-dock fixed-composer""
Received: "<section class="timeline-thread has-fixed-composer" aria-label="Tutor conversation"><form class="timeline-input fixed-composer"><label>Message the tutor<textarea name="message"></textarea></label><button class="button primary" disabled="">Send</button></form></section>"

 Test Files  1 failed (1)
      Tests  3 failed | 29 passed (32)
```

The failures were for the missing Enter submission behavior, missing Shift+Enter newline preservation, and missing dock/round-send hooks.

## Implementation summary

- Added workbook UI tests for Enter submit, Shift+Enter newline/no-submit, and the dock/round-send semantic hooks.
- Updated `TimelineThread` so Enter submits nonblank enabled messages, Shift+Enter inserts a newline without submitting, and blank/disabled/pending submissions are ignored.
- Replaced the text Send button with an accessible circular up-arrow button using `aria-label="Send message"`.
- Wrapped the composer in a full-width fixed dock while retaining the existing fixed-composer compatibility hook and thread bottom clearance.
- Updated desktop and mobile composer CSS so the dock reaches the bottom of the main pane and the inner composer remains readable.

## Tests command/output

Command:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock && npm run --workspace=tutorial-engine test -- workbook-ui.test.tsx
```

Output:

```text
> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root . workbook-ui.test.tsx


 RUN  v4.1.10 /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock/tutorial-engine


 Test Files  1 passed (1)
      Tests  32 passed (32)
   Start at  23:29:09
   Duration  973ms (transform 107ms, setup 0ms, import 508ms, tests 388ms, environment 0ms)
```

Command:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock && npm run --workspace=tutorial-engine check
```

Output:

```text
> @lean-software-production/tutorial-engine@0.1.0 check
> tsc --noEmit && npm run test


> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root .


 RUN  v4.1.10 /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock/tutorial-engine

 Test Files  38 passed (38)
      Tests  292 passed (292)
   Start at  23:30:01
   Duration  9.45s (transform 1.30s, setup 0ms, import 10.88s, tests 12.66s, environment 4ms)
```

The full check emitted expected tutorial test INFO log lines while exercising server/error paths; there were no test failures.

## Self-review

- Scope stayed within the brief’s files: `timeline-thread.tsx`, `styles.css`, and `workbook-ui.test.tsx`, plus this required report.
- The behavior is protected by tests that fail if Enter no longer submits, Shift+Enter submits or loses the newline, or the dock/round-send hooks disappear.
- Existing reflection composer tests were updated to use the accessible send control instead of the removed text label.
- Backward-compatible `timeline-input fixed-composer` markup remains for existing layout tests, while the new `timeline-composer-dock fixed-composer` wrapper carries the dock behavior.
- `git diff --check` passed with no whitespace errors.

## Final review fix: viewport-right dock and stronger inner hook assertion

### Findings addressed

- Removed the centered-shell right gutter for wide desktop viewports by changing `.timeline-composer-dock.fixed-composer` to `right: 0`, while preserving the existing main-pane left-edge calculation: `left: max(265px, calc((100vw - 1480px) / 2 + 265px))`.
- Preserved mobile behavior: the existing `@media (max-width: 840px)` override still sets `right: 0; left: 0;` and keeps the mobile inner composer unconstrained.
- Strengthened the UI layout hook test so it independently asserts the inner composer form class with `class="timeline-input fixed-composer"` instead of matching the dock class substring via `timeline-composer`.

### Tests

Command:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock && npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx
```

Output:

```text
Test Files  1 passed (1)
Tests  32 passed (32)
```

Command:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/workbook-composer-dock && npm run --workspace=tutorial-engine check
```

Output:

```text
Test Files  38 passed (38)
Tests  292 passed (292)
```
